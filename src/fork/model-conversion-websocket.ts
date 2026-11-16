import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerWebSocket } from "bun";
import { resolveConcurrentInboundBodyLimitBytes } from "../lib/inbound-body-policy";
import { MAX_WS_FRAME_BYTES } from "../server/index/live-sideband";
import { resolveInboundBodyLimitBytes } from "../server/request-decompress";
import type { WsData } from "../server/ws-bridge";
import type { ModelConversionDeps } from "./model-conversion-http";
import type { ModelConversionRule } from "./model-conversion-config";
import { overlayConvertedJson } from "./model-conversion-json";
import { applyConversionSpans, applyConversionSpansText, conversionStreamByteLength, scanConversionJson, type ScannedConversionJson } from "./model-conversion-json-scan";
import { convertModelRequest, type ConversionTurn } from "./model-conversion-request";
import { parseModelConversionJson, restoreModelPayload, type ModelConversionResponseContext } from "./model-conversion-response";

type Turn = {
  turn?: ConversionTurn;
  context?: ModelConversionResponseContext;
  clientModel?: string;
  effectiveEffort?: string;
  releaseMetadata?: () => void;
};

type MessageScope = { turn: Turn; control: boolean };

type SocketState<T> = {
  socket: ServerWebSocket<T>;
  facade: ServerWebSocket<T>;
  rules: readonly ModelConversionRule[];
  current?: Turn;
  failed?: MessageScope;
};

const frameLimit = 32 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function conflictFrame(code: "invalid_request_error" | "inbound_body_too_large" | "server_busy" | "model_conversion_response_error"): string {
  const status = code === "invalid_request_error" ? 400 : code === "inbound_body_too_large" ? 413 : code === "server_busy" ? 503 : 502;
  const message = code === "invalid_request_error" ? "Invalid model conversion request."
    : code === "inbound_body_too_large" ? "Model conversion request exceeds the available body limit."
    : code === "server_busy" ? "Model conversion capacity is currently unavailable."
      : "Model conversion response could not be safely processed.";
  return JSON.stringify({ type: "error", status, error: { type: status < 500 ? "invalid_request_error" : "server_error", code, message }, headers: {} });
}

function rawBytes(raw: string | Buffer): number {
  return typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
}

function applyFrameProjection(frame: Record<string, unknown>, before: Record<string, unknown>, after: Record<string, unknown>): () => void {
  const undo: Array<() => void> = [];
  const patch = (object: Record<string, unknown>, key: string, value: unknown, present: boolean) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    undo.push(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key]; });
    if (present) Object.defineProperty(object, key, { value, configurable: true, enumerable: true, writable: true });
    else delete object[key];
  };
  const restore = () => { for (const action of undo.reverse()) action(); };
  try {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (Object.hasOwn(before, key) === Object.hasOwn(after, key) && Object.is(before[key], after[key])) continue;
      if (key === "input" && Array.isArray(before.input) && Array.isArray(after.input) && Array.isArray(frame.input)) {
        if (before.input.length !== after.input.length || frame.input.length !== before.input.length) throw new Error("Invalid control projection");
        for (let index = 0; index < before.input.length; index++) {
          if (Object.is(before.input[index], after.input[index])) continue;
          const actual = frame.input[index], next = after.input[index];
          if (!record(actual) || !record(next) || !Object.hasOwn(next, "reasoning")) throw new Error("Invalid control projection");
          patch(actual, "reasoning", next.reasoning, true);
        }
      } else patch(frame, key, after[key], Object.hasOwn(after, key));
    }
    return restore;
  } catch (error) { restore(); throw error; }
}

export function wrapModelConversionWebsocket<T>(handler: Bun.WebSocketHandler<T>, deps: ModelConversionDeps): Bun.WebSocketHandler<T> {
  const states = new WeakMap<ServerWebSocket<T>, SocketState<T>>();
  const scope = new AsyncLocalStorage<MessageScope>();
  const capacity = deps.bodyBudget?.capacity() ?? resolveConcurrentInboundBodyLimitBytes(deps.config().maxConcurrentInboundBodyBytes);
  let reserved = 0;

  function reserve(bytes: number): (() => void) | undefined {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > capacity - reserved) return undefined;
    reserved += bytes;
    let active = true;
    return () => { if (active) { active = false; reserved -= bytes; } };
  }

  function releaseTurn(turn: Turn | undefined): void {
    if (!turn?.releaseMetadata) return;
    if (turn.turn) {
      const { clientMetadata: _clientMetadata, ...identity } = turn.turn;
      turn.turn = identity;
    }
    turn.context = undefined;
    turn.releaseMetadata();
    turn.releaseMetadata = undefined;
  }

  function stateFor(socket: ServerWebSocket<T>): SocketState<T> | undefined {
    const cached = states.get(socket);
    if (cached) return cached;
    const data = socket.data as unknown as WsData;
    if (!data || data.kind === "live-sideband" || data.kind === "remote-workspace-agent" || data.admission?.kind !== "configured") return undefined;
    const rules = deps.rules.get(data.admission.keyId);
    if (!rules?.length) return undefined;
    const state: SocketState<T> = { socket, facade: socket, rules };
    const methods = new Map<PropertyKey, unknown>();
    state.facade = new Proxy(socket, {
      get(target, key) {
        if (key === "send") {
          if (!methods.has(key)) methods.set(key, (message: string | Uint8Array, compress?: boolean) => {
            const currentScope = scope.getStore();
            const turn = currentScope?.turn ?? state.current;
            if (!turn?.turn) return target.send(message, compress);
            const bytes = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
            const release = bytes <= frameLimit ? reserve(bytes * 8 + 1024) : undefined;
            if (!release || typeof message !== "string") {
              release?.();
              const result = target.send(conflictFrame("model_conversion_response_error"));
              target.close(1011, "model conversion response error");
              return result;
            }
            try {
              if (message === "[DONE]") return target.send(message, compress);
              const restored = restoreModelPayload(parseModelConversionJson(message), turn.turn, "responses", turn.context);
              const result = target.send(JSON.stringify(restored), compress);
              const data = target.data as unknown as WsData;
              if (result !== 0 && record(restored)) {
                const terminal = restored.type === "response.completed" || restored.type === "response.failed"
                  || restored.type === "response.incomplete" || restored.type === "response.done";
                if ((!data.nativeControl && terminal) || (restored.type === "error" && currentScope?.control === false)) releaseTurn(turn);
              }
              return result;
            } catch {
              const result = target.send(conflictFrame("model_conversion_response_error"));
              target.close(1011, "model conversion response error");
              return result;
            } finally { release(); }
          });
          return methods.get(key);
        }
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (!methods.has(key)) methods.set(key, value.bind(target));
        return methods.get(key);
      },
      set(target, key, value) { return Reflect.set(target, key, value, target); },
    });
    states.set(socket, state);
    return state;
  }

  function invoke(state: SocketState<T>, raw: string | Buffer<ArrayBuffer>, context: MessageScope): void | Promise<void> {
    return scope.run(context, () => handler.message?.call(handler, state.facade, raw));
  }

  function message(state: SocketState<T>, raw: string | Buffer<ArrayBuffer>): void | Promise<void> {
    state.failed = undefined;
    const data = state.socket.data as unknown as WsData;
    const bytes = rawBytes(raw);
    const priorScope = (): MessageScope => ({ turn: state.current ?? {}, control: true });
    if (bytes > MAX_WS_FRAME_BYTES || data.responsesActivity?.closing) return invoke(state, raw, priorScope());
    if (data.nativeControl && bytes > resolveInboundBodyLimitBytes(deps.config().maxInboundBodyBytes)) {
      return invoke(state, raw, priorScope());
    }
    const release = reserve(bytes * 8 + 32 * 1024 * 1024);
    if (!release) { state.socket.send(conflictFrame("server_busy")); return; }
    let invoking = false;
    let failureScope: MessageScope | undefined;
    let releaseFull: (() => void) | undefined;
    let candidate: Turn | undefined;
    let accepted = false;
    const dispatch = (frame: string | Buffer<ArrayBuffer>, context: MessageScope) => {
      invoking = true;
      failureScope = context;
      return invoke(state, frame, context);
    };
    try {
      const encoded = typeof raw === "string" ? encoder.encode(raw) : raw;
      let scan: ScannedConversionJson | undefined;
      let value: Record<string, unknown>;
      let originalText: string | undefined;
      try {
        scan = scanConversionJson(encoded, "responses");
        value = scan.value;
      } catch {
        releaseFull = reserve(bytes * 24);
        if (!releaseFull) { state.socket.send(conflictFrame("server_busy")); return; }
        let parsed: unknown;
        try {
          originalText = typeof raw === "string" ? raw : decoder.decode(raw);
          parsed = JSON.parse(originalText);
        } catch { return dispatch(raw, priorScope()); }
        if (!record(parsed)) return dispatch(raw, priorScope());
        value = parsed;
      }
      if (value.type !== "response.create" && value.type !== "response.inject" && value.type !== "response.steer") {
        return dispatch(raw, priorScope());
      }
      const create = value.type === "response.create";
      const control = !create || !!data.nativeControl;
      const previous = state.current;
      if (control && previous?.clientModel && Object.hasOwn(value, "model")
        && value.model !== previous.clientModel && value.model !== previous.turn?.targetModel) {
        state.socket.send(conflictFrame("invalid_request_error")); return;
      }
      if (control && !previous?.turn) {
        return dispatch(raw, priorScope());
      }
      const config = deps.config();
      const converted = convertModelRequest(value, state.rules, config, previous?.turn, "responses");
      const continuation = create && control && previous?.turn !== undefined;
      const controlInput: Record<string, unknown> = { ...value, type: "response.steer" };
      if (continuation && Object.hasOwn(value, "reasoning")
        && (value.reasoning === null || (record(value.reasoning) && value.reasoning.effort == null))) {
        controlInput.reasoning = { ...(record(value.reasoning) ? value.reasoning : {}), effort: previous.effectiveEffort ?? previous.turn!.maxEffort };
      }
      const controlConverted = continuation
        ? convertModelRequest(controlInput, state.rules, config, previous.turn, "responses") : undefined;
      const controlValue: Record<string, unknown> | undefined = controlConverted && record(controlConverted.value)
        ? { ...controlConverted.value, type: "response.create" } : undefined;
      const overlay = !scan && converted.turn ? overlayConvertedJson(originalText!, value, converted.value) : undefined;
      const metadata = scan?.metadata ?? overlay?.metadata;
      const inheritedControl = !create && previous !== undefined;
      let turn = inheritedControl ? previous : undefined;
      if (!turn) {
        const coreClientMetadata = converted.turn && record(value.metadata)
          ? JSON.parse(JSON.stringify(value.metadata)) as Record<string, unknown> : undefined;
        const retainedBytes = metadata === undefined || !converted.turn ? 0
          : 32 * (Buffer.byteLength(JSON.stringify(metadata)) + Buffer.byteLength(JSON.stringify(coreClientMetadata ?? {}))) + 1024;
        const releaseMetadata = retainedBytes ? reserve(retainedBytes) : undefined;
        if (retainedBytes && !releaseMetadata) { state.socket.send(conflictFrame("server_busy")); return; }
        const nextTurn = converted.turn ? { ...converted.turn, clientMetadata: metadata } : undefined;
        const clientModel = typeof value.model === "string" ? value.model : previous?.clientModel;
        const effectiveEffort = record(converted.value) && record(converted.value.reasoning) && typeof converted.value.reasoning.effort === "string"
          ? converted.value.reasoning.effort : undefined;
        turn = {
          ...(nextTurn ? { turn: nextTurn } : {}),
          ...(coreClientMetadata ? { context: { coreClientMetadata } } : {}),
          ...(clientModel !== undefined ? { clientModel } : {}),
          ...(effectiveEffort !== undefined ? { effectiveEffort } : {}),
          ...(releaseMetadata ? { releaseMetadata } : {}),
        };
        candidate = turn;
      }
      if (!record(converted.value)) {
        state.socket.send(conflictFrame("invalid_request_error")); return;
      }
      const maxBytes = Math.min(MAX_WS_FRAME_BYTES, resolveInboundBodyLimitBytes(config.maxInboundBodyBytes));
      const projectedBytes = (projection: Record<string, unknown>): number => {
        if (!scan) return Buffer.byteLength(overlayConvertedJson(originalText!, value, projection).text);
        const stream = applyConversionSpans(scan, projection);
        const length = conversionStreamByteLength(stream);
        void stream.cancel().catch(() => {});
        return length;
      };
      if (continuation && controlValue && (projectedBytes(controlValue) > maxBytes || projectedBytes(converted.value) > maxBytes)) {
        state.socket.send(conflictFrame("inbound_body_too_large")); return;
      }
      const transformed = continuation ? raw : converted.changed ? scan ? applyConversionSpansText(scan, converted.value) : overlay!.text : raw;
      if (!continuation && rawBytes(transformed) > maxBytes) { state.socket.send(conflictFrame("inbound_body_too_large")); return; }
      const before = data.turnId;
      const context: MessageScope = { turn: continuation ? previous : turn, control };
      if (create && !continuation) state.current = turn;
      try {
        if (!continuation || !controlValue) return dispatch(transformed, context);
        const original = data.nativeControl!;
        const descriptor = Object.getOwnPropertyDescriptor(data, "nativeControl");
        if (!descriptor || !("value" in descriptor) || !descriptor.writable) {
          state.socket.send(conflictFrame("invalid_request_error")); return;
        }
        const controlProxy = new Proxy({} as typeof original, {
          get(_target, key) {
            if (key === "continue") return (frame: Record<string, unknown>) => {
              const undo = applyFrameProjection(frame, value, controlValue);
              let continued: boolean;
              try { continued = original.continue(frame); }
              catch (error) { undo(); throw error; }
              if (typeof continued !== "boolean") { undo(); throw new Error("Invalid native continuation result"); }
              if (!continued) {
                undo();
                if (data.turnId !== before || state.current !== previous || data.nativeControl !== controlProxy) {
                  throw new Error("Native continuation changed during dispatch");
                }
                applyFrameProjection(frame, value, converted.value as Record<string, unknown>);
                context.turn = turn;
                context.control = false;
                state.current = turn;
              } else if (record(controlValue.reasoning) && typeof controlValue.reasoning.effort === "string") {
                previous.effectiveEffort = controlValue.reasoning.effort;
              }
              return continued;
            };
            const member = Reflect.get(original, key, original);
            return typeof member === "function" ? member.bind(original) : member;
          },
          set(_target, key, value) { return Reflect.set(original, key, value, original); },
        });
        if (!Reflect.set(data, "nativeControl", controlProxy, data) || data.nativeControl !== controlProxy) {
          state.socket.send(conflictFrame("invalid_request_error")); return;
        }
        try { return dispatch(transformed, context); }
        finally { if (data.nativeControl === controlProxy) Reflect.set(data, "nativeControl", original, data); }
      }
      finally {
        if (create && data.turnId === before && state.current === turn) state.current = previous;
        else if (candidate && state.current === turn && data.turnId !== before) { accepted = true; releaseTurn(previous); }
      }
    } catch (error) {
      if (invoking) { state.failed = failureScope; throw error; }
      state.socket.send(conflictFrame("invalid_request_error"));
    } finally {
      if (!accepted) releaseTurn(candidate);
      releaseFull?.();
      release();
    }
  }

  return {
    ...handler,
    open(socket) {
      const state = stateFor(socket);
      return handler.open?.call(handler, state?.facade ?? socket);
    },
    message(socket, raw) {
      const state = stateFor(socket);
      return state ? message(state, raw) : handler.message?.call(handler, socket, raw);
    },
    drain(socket) {
      const state = stateFor(socket);
      return handler.drain?.call(handler, state?.facade ?? socket);
    },
    close(socket, code, reason) {
      const state = states.get(socket);
      try { return handler.close?.call(handler, state?.facade ?? socket, code, reason); }
      finally { releaseTurn(state?.current); states.delete(socket); }
    },
    ping(socket, data) { return handler.ping?.call(handler, stateFor(socket)?.facade ?? socket, data); },
    pong(socket, data) { return handler.pong?.call(handler, stateFor(socket)?.facade ?? socket, data); },
    error(error, socket) {
      if (!socket) return handler.error?.call(handler, error, socket);
      const state = stateFor(socket);
      if (!state?.failed) return handler.error?.call(handler, error, state?.facade ?? socket);
      const turn = state.failed;
      state.failed = undefined;
      return scope.run(turn, () => handler.error?.call(handler, error, state.facade));
    },
  };
}

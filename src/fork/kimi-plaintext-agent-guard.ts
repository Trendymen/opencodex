import { formatErrorResponse } from "../bridge";
import { Buffer } from "node:buffer";
import { markProxyError } from "../lib/client-error-body";
import { TRANSLATOR_MAX_TURN_BYTES, TranslatorBudgetExceededError, type TranslatorBudget } from "../lib/translator-budget";
import { applyReplayRefusalClientHeaders, markResponseNonReplayable } from "../lib/upstream-retry";
import type { FunctionCallRepairSchemas } from "../responses/function-call-compat";
import type { RoutedNamespaceToolAliases } from "../responses/namespace-tool-compat";
import { isBackendTaskCiphertext } from "../lib/agent-task-ciphertext";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../server/sse-payload-rewrite";
import type { OcxProviderConfig } from "../types";
import { COLLABORATION_MESSAGE_NAMES, isKimiPlaintextAgentMessageRoute, KIMI_PLAINTEXT_AGENT_ERROR_CODE } from "./spawn-agent-compat";

export { KIMI_PLAINTEXT_AGENT_ERROR_CODE } from "./spawn-agent-compat";
export const KIMI_PLAINTEXT_AGENT_ERROR_MESSAGE = "The collaboration message could not be validated as readable plain text. Retry the tool call with the complete task or message as plain text in the message field.";
const MAX_TRACKED_ITEMS = 1024;
const MAX_TRACKED_ID_LENGTH = 512;

type Identity = { id?: string; index?: number; target: boolean; verified?: boolean; opaque?: boolean; unknown?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function opaqueArguments(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let args: unknown;
  try { args = JSON.parse(value); } catch { return false; }
  return isRecord(args) && typeof args.message === "string" && isBackendTaskCiphertext(args.message.trim());
}

function readableArguments(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let args: unknown;
  try { args = JSON.parse(value); } catch { return false; }
  return isRecord(args) && typeof args.message === "string" && args.message.trim().length > 0
    && !isBackendTaskCiphertext(args.message.trim());
}

function identityMatches(left: Identity, right: Identity): boolean {
  if (left.id !== undefined && right.id !== undefined && left.id !== right.id) return false;
  if (left.index !== undefined && right.index !== undefined && left.index !== right.index) return false;
  return (left.id !== undefined && right.id !== undefined) || (left.index !== undefined && right.index !== undefined);
}

function coordinates(id: unknown, index: unknown): Identity {
  return {
    ...(typeof id === "string" && id.length > 0 && id.length <= MAX_TRACKED_ID_LENGTH ? { id } : {}),
    ...(typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? { index } : {}),
    target: false,
  };
}

export function createKimiPlaintextAgentGuard(options: {
  provider: OcxProviderConfig;
  modelId: string;
  plaintextDecision: boolean | undefined;
  schemas: FunctionCallRepairSchemas;
  aliases: () => readonly RoutedNamespaceToolAliases[];
  budget?: TranslatorBudget;
  onRefusal?: () => void;
}): {
  inspect: (payload: unknown) => boolean;
  cacheSafe: () => boolean;
  rejectJson: (text: string) => boolean;
  errorResponse: () => Response;
  blockRewrite: SseBlockRewrite;
} | undefined {
  if (!isKimiPlaintextAgentMessageRoute(options.provider, options.modelId, options.plaintextDecision)
    || ![...COLLABORATION_MESSAGE_NAMES].some(name => {
      const schema = options.schemas.get(`collaboration__${name}`);
      return schema?.namespace === "collaboration" && schema.name === name;
    })) return undefined;
  let identities: Identity[] = [];
  let pending: Identity[] = [];
  let cacheUncertain = false;
  let tripped = false;

  const target = (item: unknown): boolean => {
    if (!isRecord(item) || item.type !== "function_call" || typeof item.name !== "string") return false;
    let namespace = item.namespace;
    let name = item.name;
    if (!Object.hasOwn(item, "namespace")) {
      for (const aliases of options.aliases()) {
        const identity = aliases.get(name);
        if (identity?.kind === "function") { namespace = identity.namespace; name = identity.name; break; }
      }
    }
    if (namespace !== "collaboration" || !COLLABORATION_MESSAGE_NAMES.has(name)) return false;
    const schema = options.schemas.get(`collaboration__${name}`);
    return schema?.namespace === "collaboration" && schema.name === name;
  };
  const ambiguousBareName = (item: Record<string, unknown>): boolean =>
    typeof item.name === "string" && COLLABORATION_MESSAGE_NAMES.has(item.name)
    && (typeof item.namespace !== "string" || item.namespace.length === 0)
    && options.schemas.get(`collaboration__${item.name}`)?.namespace === "collaboration";
  const opaqueItem = (item: unknown): boolean => isRecord(item) && target(item) && opaqueArguments(item.arguments);
  const inspectResponse = (response: unknown): boolean =>
    isRecord(response) && Array.isArray(response.output) && response.output.some(opaqueItem);
  const inspect = (payload: unknown): boolean => {
    if (tripped || !isRecord(payload)) return tripped;
    if (inspectResponse(payload) || inspectResponse(payload.response)) return tripped = true;
    const response = isRecord(payload.response) ? payload.response : payload;
    if (Array.isArray(response.output)) {
      for (const [index, item] of response.output.entries()) {
        if (!isRecord(item)) continue;
        const key = coordinates(item.id, index);
        const isTarget = target(item);
        if (!isTarget && (item.type !== "function_call" || typeof item.name === "string")
          && identities.some(entry => entry.target && identityMatches(entry, key))) return tripped = true;
        if (item.type !== "function_call") continue;
        if (isTarget && pending.some(entry => entry.opaque && identityMatches(entry, key))) return tripped = true;
        if (!isTarget || readableArguments(item.arguments)) pending = pending.filter(entry => !identityMatches(entry, key));
        for (const entry of identities) if (entry.target && identityMatches(entry, key)) entry.verified = readableArguments(item.arguments);
      }
    }
    if ((payload.type === "response.output_item.added" || payload.type === "response.output_item.done") && isRecord(payload.item)) {
      const key = coordinates(payload.item.id, payload.output_index);
      key.target = target(payload.item);
      const previous = identities.find(entry => identityMatches(entry, key));
      if (previous?.target && !key.target && (payload.item.type !== "function_call" || typeof payload.item.name === "string")) return tripped = true;
      if (!key.target && payload.item.type === "function_call" && typeof payload.item.name !== "string") {
        key.target = identities.some(entry => entry.target && identityMatches(entry, key));
      }
      if (key.target && opaqueArguments(payload.item.arguments)) return tripped = true;
      if (key.target && pending.some(entry => entry.opaque && identityMatches(entry, key))) return tripped = true;
      if (key.target && key.id === undefined && key.index === undefined) cacheUncertain = true;
      if (!key.target || (payload.type === "response.output_item.done" && readableArguments(payload.item.arguments))) {
        pending = pending.filter(entry => !identityMatches(entry, key));
      }
      identities = identities.filter(entry => !identityMatches(entry, key));
      if ((payload.type === "response.output_item.added" || (key.target && !readableArguments(payload.item.arguments)))
        && payload.item.type === "function_call" && (key.id !== undefined || key.index !== undefined)) {
        if (identities.length >= MAX_TRACKED_ITEMS) {
          const unrelated = identities.findIndex(entry => !entry.target);
          if (unrelated >= 0) identities.splice(unrelated, 1);
          else if (key.target) { cacheUncertain = true; return false; }
          else return false;
        }
        identities.push(key);
      }
    } else if (payload.type === "response.function_call_arguments.done" && typeof payload.arguments === "string") {
      const opaque = opaqueArguments(payload.arguments);
      const key = coordinates(payload.item_id, payload.output_index);
      const known = identities.find(entry => identityMatches(entry, key));
      const namedTarget = target({ ...payload, type: "function_call" });
      if ((known?.target || namedTarget) && opaque) return tripped = true;
      if (known?.target) known.verified = readableArguments(payload.arguments);
      if (known || (typeof payload.name === "string" && !ambiguousBareName(payload))) {
        if ((!known?.target && !namedTarget) || readableArguments(payload.arguments)) pending = pending.filter(entry => !identityMatches(entry, key));
      } else if (opaque && (key.id !== undefined || key.index !== undefined)) {
        const existing = pending.find(entry => identityMatches(entry, key));
        if (existing) existing.opaque = true;
        else if (pending.length < MAX_TRACKED_ITEMS) pending.push({ ...key, opaque: true });
        else cacheUncertain = true;
      }
    } else if (payload.type === "response.function_call_arguments.delta") {
      const key = coordinates(payload.item_id, payload.output_index);
      if (key.id === undefined && key.index === undefined) { cacheUncertain = true; return false; }
      if (!identities.some(entry => identityMatches(entry, key)) && !pending.some(entry => identityMatches(entry, key))) {
        if (pending.length < MAX_TRACKED_ITEMS) pending.push(key);
        else cacheUncertain = true;
      }
    }
    return false;
  };
  const errorResponse = (): Response => {
    const response = markProxyError(formatErrorResponse(502, "upstream_error", KIMI_PLAINTEXT_AGENT_ERROR_MESSAGE, {
      code: KIMI_PLAINTEXT_AGENT_ERROR_CODE, classified: true,
    }));
    markResponseNonReplayable(response);
    applyReplayRefusalClientHeaders(response.headers);
    return response;
  };
  type BufferedBlock = { block: string; deltaKey?: Identity; addedKey?: Identity };
  let waiting: Identity[] = [];
  let buffered: BufferedBlock[] = [];
  let retainedBytes = 0;
  const release = (): string[] => {
    options.budget?.releaseRetained(retainedBytes, { kind: "retained_collectors" });
    retainedBytes = 0;
    const output = buffered.map(entry => entry.block);
    buffered = [];
    return output;
  };
  const retain = (block: string, payload?: Record<string, unknown>): void => {
    const bytes = 64 + Buffer.byteLength(block, "utf8");
    if (retainedBytes + bytes > TRANSLATOR_MAX_TURN_BYTES) {
      throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
    }
    options.budget?.chargeRetained(bytes, { kind: "retained_collectors" });
    retainedBytes += bytes;
    buffered.push({ block, ...(payload?.type === "response.function_call_arguments.delta"
      ? { deltaKey: coordinates(payload.item_id, payload.output_index) } : {}),
      ...(payload?.type === "response.output_item.added" && isRecord(payload.item)
        ? { addedKey: coordinates(payload.item.id, payload.output_index) } : {}) });
  };
  const replacePreviews = (key: Identity, argumentsText: string): void => {
    const matching = buffered.filter(entry => entry.deltaKey && identityMatches(entry.deltaKey, key));
    const added = buffered.filter(entry => entry.addedKey && identityMatches(entry.addedKey, key));
    for (const [index, entry] of [...added, ...matching].entries()) {
      const data = sseDataPayload(entry.block);
      if (data === null) continue;
      let payload: unknown;
      try { payload = JSON.parse(data); } catch { continue; }
      if (isRecord(payload)) {
        let projected: Record<string, unknown>;
        if (entry.addedKey) {
          if (!isRecord(payload.item) || typeof payload.item.arguments !== "string") continue;
          projected = { ...payload, item: { ...payload.item, arguments: matching.length === 0 && payload.item.arguments ? argumentsText : "" } };
        } else projected = { ...payload, delta: index === added.length + matching.length - 1 ? argumentsText : "" };
        const rewritten = replaceSseDataPayload(entry.block, JSON.stringify(projected));
        const extra = Math.max(0, Buffer.byteLength(rewritten, "utf8") - Buffer.byteLength(entry.block, "utf8"));
        if (retainedBytes + extra > TRANSLATOR_MAX_TURN_BYTES) {
          throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
        }
        options.budget?.chargeRetained(extra, { kind: "retained_collectors" });
        retainedBytes += extra;
        entry.block = rewritten;
      }
    }
  };
  const failedBlocks = (newline: string): readonly string[] => {
    release();
    waiting = [];
    tripped = true;
    options.onRefusal?.();
    const failure = { type: "upstream_error", code: KIMI_PLAINTEXT_AGENT_ERROR_CODE, message: KIMI_PLAINTEXT_AGENT_ERROR_MESSAGE, retryable: false };
    return [`event: response.failed${newline}data: ${JSON.stringify({ type: "response.failed", replayUnsafe: true, response: { status: "failed", error: failure, last_error: failure } })}`, "data: [DONE]"];
  };
  const blockRewrite: SseBlockRewrite = block => {
    if (tripped) return [];
    const data = sseDataPayload(block);
    if (data === "[DONE]" && waiting.length > 0) return failedBlocks(block.includes("\r\n") ? "\r\n" : "\n");
    if (data === null || data === "[DONE]") {
      if (waiting.length > 0) { retain(block); return []; }
      return [block];
    }
    let payload: unknown;
    try { payload = JSON.parse(data); } catch {
      if (waiting.length > 0) { retain(block); return []; }
      return [block];
    }
    const newline = block.includes("\r\n") ? "\r\n" : "\n";
    const priorIdentities = identities.slice();
    if (inspect(payload)) return failedBlocks(newline);
    if (!isRecord(payload)) {
      if (waiting.length > 0) { retain(block); return []; }
      return [block];
    }
    const wasWaiting = waiting.length > 0;
    if (payload.type === "response.output_item.added" && isRecord(payload.item) && payload.item.type === "function_call") {
      const key = coordinates(payload.item.id, payload.output_index);
      const existing = waiting.find(entry => identityMatches(entry, key));
      if (target(payload.item)) {
        if (existing) { existing.target = true; existing.unknown = false; }
        else waiting.push({ ...key, target: true });
      } else if (typeof payload.item.name === "string" && existing?.unknown) {
        waiting = waiting.filter(entry => entry !== existing);
      }
    } else if (payload.type === "response.function_call_arguments.delta") {
      const key = coordinates(payload.item_id, payload.output_index);
      const known = priorIdentities.find(entry => identityMatches(entry, key));
      const named = typeof payload.name === "string" && !ambiguousBareName(payload);
      const namedTarget = target({ ...payload, type: "function_call" });
      if ((known?.target || namedTarget || (!known && !named)) && !waiting.some(entry => identityMatches(entry, key))) {
        waiting.push({ ...key, target: known?.target === true || namedTarget, unknown: !known && !named });
      }
    } else if (payload.type === "response.function_call_arguments.done") {
      const key = coordinates(payload.item_id, payload.output_index);
      const previous = waiting.find(entry => identityMatches(entry, key));
      const known = priorIdentities.find(entry => identityMatches(entry, key));
      const named = typeof payload.name === "string" && !ambiguousBareName(payload);
      const isTarget = previous?.target === true || known?.target === true || target({ ...payload, type: "function_call" });
      if (!isTarget && !known && !named && opaqueArguments(payload.arguments) && !previous) {
        waiting.push({ ...key, unknown: true });
      }
      if (isTarget && readableArguments(payload.arguments)) {
        replacePreviews(key, payload.arguments);
        waiting = waiting.filter(entry => !identityMatches(entry, key));
      } else if (!isTarget && (known || named)) {
        waiting = waiting.filter(entry => !identityMatches(entry, key));
      }
    } else if (payload.type === "response.output_item.done" && isRecord(payload.item)) {
      const key = coordinates(payload.item.id, payload.output_index);
      const previous = waiting.find(entry => identityMatches(entry, key));
      const known = priorIdentities.find(entry => identityMatches(entry, key));
      const isTarget = previous?.target === true || known?.target === true || target(payload.item);
      if (isTarget && readableArguments(payload.item.arguments)) {
        replacePreviews(key, payload.item.arguments);
        waiting = waiting.filter(entry => !identityMatches(entry, key));
      } else if (!isTarget && typeof payload.item.name === "string") {
        waiting = waiting.filter(entry => !identityMatches(entry, key));
      }
    } else if (payload.type === "response.failed" || payload.type === "response.incomplete" || payload.type === "response.cancelled") {
      release();
      waiting = [];
      return [block];
    } else if (payload.type === "response.completed" || payload.type === "response.done") {
      const response = isRecord(payload.response) ? payload.response : undefined;
      if (Array.isArray(response?.output)) {
        for (const [index, item] of response.output.entries()) {
          if (!isRecord(item) || item.type !== "function_call") continue;
          const key = coordinates(item.id, index);
          const previous = waiting.find(entry => identityMatches(entry, key));
          const isTarget = previous?.target === true || target(item);
          if (isTarget && readableArguments(item.arguments)) {
            replacePreviews(key, item.arguments);
            waiting = waiting.filter(entry => !identityMatches(entry, key));
          } else if (!isTarget && typeof item.name === "string") {
            waiting = waiting.filter(entry => !identityMatches(entry, key));
          }
        }
      }
      if (waiting.length > 0) return failedBlocks(newline);
    }
    if (wasWaiting || waiting.length > 0) {
      retain(block, payload);
      return waiting.length === 0 ? release() : [];
    }
    return [block];
  };
  blockRewrite.flush = () => waiting.length > 0 ? failedBlocks("\n") : release();
  blockRewrite.dispose = () => { identities = []; pending = []; waiting = []; release(); };
  return {
    inspect,
    cacheSafe: () => !tripped && !cacheUncertain && pending.length === 0 && !identities.some(entry => entry.target && !entry.verified),
    rejectJson: text => {
      let value: unknown;
      try { value = JSON.parse(text); } catch { return false; }
      if (!inspect(value)) return false;
      options.onRefusal?.();
      return true;
    },
    errorResponse,
    blockRewrite,
  };
}

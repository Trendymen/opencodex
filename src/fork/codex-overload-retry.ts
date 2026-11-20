import { formatClientRetryAfter } from "../lib/client-retry-after";
import { carryPacedStream, pacedQueuingStrategy } from "../lib/paced-stream";
import { comboStreamPayloadCommitsOutput } from "../server/responses/combo-stream-preflight";
import { codexWsFrameResponseIds, codexWsPreOutputRefusalStatus } from "../server/responses/codex-ws-wire";
import { BoundedSseFrameBuffer } from "../server/sse-frame-buffer";
import { sseDataPayload } from "../server/sse-payload-rewrite";
import { isStructuredCodexOverload, safeCodexOverloadMetadata, type CodexOverloadSource } from "./codex-overload-provenance";

const MAX_OVERLOAD_FRAME_BYTES = 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function overloadEvent(event: Record<string, unknown>): boolean {
  if (!isStructuredCodexOverload(event)) return false;
  const error = record(event.error) ? event.error : {};
  const withStatus = event.status === undefined && event.status_code === undefined
    ? { ...event, status: 503 } : event;
  if (codexWsPreOutputRefusalStatus(withStatus) !== 503) return false;
  const allowed = new Set(["type", "status", "status_code", "error", "code", "message", "headers", "sequence_number", "response_id", "response", "replayUnsafe", "retryable"]);
  if (Object.keys(event).some(key => !allowed.has(key))) return false;
  if (Object.keys(error).some(key => !["type", "code", "message", "headers", "retryable", "param"].includes(key))) return false;
  if (error.param !== undefined && error.param !== null && typeof error.param !== "string") return false;
  if (event.sequence_number !== undefined && !(typeof event.sequence_number === "number"
    && Number.isSafeInteger(event.sequence_number) && event.sequence_number >= 0)) return false;
  for (const headers of [event.headers, error.headers]) {
    if (headers !== undefined && (!record(headers) || Object.values(headers).some(value =>
      typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))))) return false;
  }
  if (event.response !== undefined && (!record(event.response) || comboStreamPayloadCommitsOutput({ type: "response.in_progress", response: event.response }))) return false;
  return true;
}

export function relayCodexOverloadRetry(
  body: ReadableStream<Uint8Array>,
  candidate: CodexOverloadSource | { source?: CodexOverloadSource },
  signal?: AbortSignal,
  onSyntheticTail?: (payload: string) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const framer = new BoundedSseFrameBuffer(MAX_OVERLOAD_FRAME_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let eligible = true;
  let overload = false;
  let overloadHeaderValues: unknown[] = [];
  let sawSentinel = false;
  let responseId: string | undefined;
  let closed = false;
  const observe = (bytes: Uint8Array): void => {
    if (!eligible || bytes.byteLength === 0) return;
    const frame = decoder.decode(bytes);
    const lines = frame.split(/\r\n|\r|\n/);
    const data = sseDataPayload(frame);
    if (data === null) {
      if (lines.some(line => line && !line.startsWith(":"))) eligible = false;
      return;
    }
    const eventLines = lines.filter(line => line === "event" || line.startsWith("event:"));
    if (eventLines.length > 1 || lines.some(line => line && !line.startsWith(":")
      && !line.startsWith("data:") && line !== "data" && !line.startsWith("event:") && line !== "event")) {
      eligible = false;
      return;
    }
    if (data === "[DONE]" && overload && !sawSentinel && eventLines.length === 0) {
      sawSentinel = true;
      return;
    }
    let event: unknown;
    try { event = JSON.parse(data); } catch { eligible = false; return; }
    if (!record(event) || typeof event.type !== "string") { eligible = false; return; }
    if (eventLines.length === 1) {
      const name = eventLines[0]!.slice(6).replace(/^ /, "");
      if (name !== event.type) { eligible = false; return; }
    }
    const ids = codexWsFrameResponseIds(event);
    if (!ids || ids.length > 1 || (ids[0] !== undefined && responseId !== undefined && ids[0] !== responseId)) {
      eligible = false;
      return;
    }
    responseId ??= ids[0];
    if (overload) { eligible = false; return; }
    if (event.type === "error") {
      if (overloadEvent(event)) {
        overload = true;
        const error = record(event.error) ? event.error : {};
        for (const headers of [error.headers, event.headers]) {
          if (!record(headers)) continue;
          const values = Object.entries(headers).filter(([name]) => name.toLowerCase() === "retry-after");
          if (values.length === 1) overloadHeaderValues.push(values[0]![1]);
        }
      }
      else eligible = false;
      return;
    }
    const isMetadata = event.type === "codex.response.metadata" || event.type === "codex.rate_limits";
    const isPrelude = ["response.created", "response.in_progress", "response.queued", "response.heartbeat"].includes(event.type);
    if ((!isMetadata && !isPrelude) || (isMetadata && !safeCodexOverloadMetadata(event))
      || comboStreamPayloadCommitsOutput(event)) eligible = false;
  };
  const dispose = (): void => { framer.dispose(); try { reader.releaseLock(); } catch { /* pending read */ } };
  return carryPacedStream(body, new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (!next.done) {
          if (eligible) {
            try { for (const frame of framer.feed(next.value)) if (!frame.continuation) observe(frame.block); }
            catch { eligible = false; framer.dispose(); }
          }
          controller.enqueue(next.value);
          return;
        }
        if (eligible) {
          try { observe(framer.finish()); } catch { eligible = false; }
        }
        const source = "retryAfter" in candidate ? candidate : candidate.source;
        if (eligible && overload && source && !source.safety?.unsafe && !source.signal.aborted && !signal?.aborted) {
          let advice: string | undefined;
          for (const value of [...overloadHeaderValues, source.retryAfter]) {
            if (typeof value !== "string" && typeof value !== "number") continue;
            const raw = String(value);
            if (source.maskCredential && source.maskCredential(raw) !== raw) continue;
            const normalized = formatClientRetryAfter(raw);
            if (normalized !== undefined && (!source.maskCredential || source.maskCredential(normalized) === normalized)) {
              advice = normalized;
              break;
            }
          }
          const delay = advice && (!source.maskCredential || source.maskCredential(advice) === advice) ? advice : "1";
          const failure = { type: "server_error", code: "server_is_overloaded", message: "The upstream model is overloaded.",
            headers: { "retry-after": delay } };
          const payload = { type: "response.failed", response: { status: "failed", error: failure } };
          const serialized = JSON.stringify(payload);
          if (!source.maskCredential || source.maskCredential(serialized) === serialized) {
            onSyntheticTail?.(serialized);
            controller.enqueue(new TextEncoder().encode(`\n\nevent: response.failed\ndata: ${serialized}\n\n`));
          }
        }
        closed = true;
        controller.close();
        dispose();
      } catch (error) {
        if (closed) return;
        closed = true;
        dispose();
        controller.error(error);
      }
    },
    cancel(reason) {
      if (closed) return;
      closed = true;
      framer.dispose();
      return reader.cancel(reason).finally(dispose);
    },
  }, pacedQueuingStrategy(body)));
}

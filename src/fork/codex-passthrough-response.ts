import type { SseInspector } from "../server/relay";
import type { ResponsesTerminalStatus } from "../bridge";
import type { CodexPassthroughPermissions } from "./codex-passthrough-contract";
import { TRANSLATOR_MAX_SSE_EVENT_BYTES } from "../lib/translator-budget";

export function codexRawJsonTerminal(response: Record<string, unknown>, permissions?: CodexPassthroughPermissions):
  { payload: Record<string, unknown>; status: ResponsesTerminalStatus } | undefined {
  if (permissions?.backfillResponseFields !== false && permissions?.synthesizeTerminalFailure !== false) return undefined;
  const status = codexDoneTerminalStatus({ type: "response.done", response })!;
  return { payload: { type: permissions?.synthesizeTerminalFailure === false ? "response.done" : `response.${status}`, response }, status };
}

export function codexRawErrorBody(text: string, permissions?: CodexPassthroughPermissions): { response: unknown } | undefined {
  if (permissions?.backfillResponseFields !== false && permissions?.synthesizeTerminalFailure !== false && permissions?.redactUpstreamErrors !== false) return undefined;
  try { return { response: JSON.parse(text) }; }
  catch { return { response: text }; }
}

export function codexRawJsonSse(response: Record<string, unknown>, permissions?: CodexPassthroughPermissions): ReadableStream<Uint8Array> | undefined {
  const terminal = codexRawJsonTerminal(response, permissions); if (!terminal) return undefined;
  const bytes = new TextEncoder().encode(`event: ${terminal.payload.type}\ndata: ${JSON.stringify(terminal.payload)}\n\n`);
  if (bytes.byteLength > TRANSLATOR_MAX_SSE_EVENT_BYTES) throw new RangeError("Responses JSON terminal exceeds the SSE event limit");
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

export function codexDoneTerminalStatus(value: unknown): ResponsesTerminalStatus | null {
  const event = value && typeof value === "object" ? value as { type?: unknown; response?: { status?: unknown } } : undefined;
  if (event?.type !== "response.done") return null;
  return event.response?.status === "completed" ? "completed"
    : event.response?.status === "incomplete" || event.response?.status === "cancelled" ? "incomplete" : "failed";
}

export function relayUnmodifiedCodexSse(body: ReadableStream<Uint8Array>, upstream: AbortController,
  inspector: SseInspector, onClientGone?: (reason?: unknown) => void): ReadableStream<Uint8Array> {
  const reader = body.getReader(); let closed = false;
  const dispose = () => { inspector.dispose(); try { reader.releaseLock(); } catch { /* pending read */ } };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read(); if (closed) return;
        if (next.done) { inspector.finish(); closed = true; controller.close(); dispose(); return; }
        inspector.feed(next.value); controller.enqueue(next.value);
        if (inspector.terminalSeen()) {
          closed = true; controller.close(); const reason = "Responses terminal event received";
          onClientGone?.(reason); void reader.cancel(reason).catch(() => {}); dispose();
        }
      } catch (error) {
        if (closed) return; closed = true; inspector.dispose(); controller.error(error); upstream.abort(error);
        void reader.cancel(error).catch(() => {}); dispose();
      }
    },
    cancel(reason) {
      if (closed) return; closed = true; inspector.dispose();
      if (onClientGone) onClientGone(reason); else upstream.abort(reason);
      void reader.cancel(reason).catch(() => {}); dispose();
    },
  });
}

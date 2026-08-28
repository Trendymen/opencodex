import type { SsePayloadRewrite } from "./sse-payload-rewrite";
import {
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
} from "./sse-payload-rewrite";

/**
 * Route content-channel reasoning from native-Responses upstreams through the
 * expandable summary channel (issue #45).
 *
 * Codex renders the expandable reasoning trace from the Responses reasoning
 * item's `summary[]` channel. DeepSeek's native `/responses` endpoint emits
 * raw thinking on the content channel instead (`response.reasoning_text.delta`
 * plus items with `content: [{type: "reasoning_text", text}]` and an empty
 * `summary`), so routed DeepSeek turns showed the "Worked for Xs" timer with
 * nothing to expand. Native OpenAI upstreams already emit summary-channel
 * events; this rewrite is a no-op for them (no reasoning_text events to
 * rewrite) and only engages when the upstream produces content-channel
 * reasoning.
 *
 * Replay compatibility: Codex echoes the reasoning item it received back into
 * the next request's input. DeepSeek's Responses API accepts summary-shaped
 * reasoning input items (verified live), so the rewrite round-trips.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function reasoningTextOf(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter((part): part is Record<string, unknown> => isPlainObject(part) && part.type === "reasoning_text")
    .map(part => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

/** Add a summary channel to a content-channel reasoning item without dropping its raw data. */
function reasoningItemToSummaryShape(
  item: Record<string, unknown>,
  projectSummary: (text: string) => string = text => text,
): Record<string, unknown> {
  if (item.type !== "reasoning") return item;
  const text = reasoningTextOf(item);
  // Items that already use the summary channel (or carry no content text at
  // all) are left untouched: rewriting them could clear a valid summary.
  if (text.length === 0) return item;
  // Opaque provider state must round-trip verbatim. Keep the raw content alongside the
  // summary so a terminal snapshot cannot erase the live summary delta before Codex renders it.
  if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
    if (Array.isArray(item.summary) && item.summary.length > 0) return item;
    return { ...item, summary: [{ type: "summary_text", text: projectSummary(text) }] };
  }
  return { ...item, summary: [{ type: "summary_text", text: projectSummary(text) }] };
}

/**
 * Rewrite one parsed SSE payload in place of the content channel, or return
 * `null` when nothing changed (caller keeps the original payload).
 */
function rewritePayload(
  payload: Record<string, unknown>,
  projectSummary: (text: string) => string = text => text,
): Record<string, unknown> | null {
  switch (payload.type) {
    case "response.content_part.added":
    case "response.content_part.done": {
      if (!isPlainObject(payload.part) || payload.part.type !== "reasoning_text") return null;
      const next: Record<string, unknown> = {
        type: payload.type === "response.content_part.added"
          ? "response.reasoning_summary_part.added"
          : "response.reasoning_summary_part.done",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: 0,
        part: { ...payload.part, type: "summary_text" },
      };
      if (payload.sequence_number !== undefined) next.sequence_number = payload.sequence_number;
      return next;
    }
    case "response.reasoning_text.delta": {
      const next: Record<string, unknown> = {
        type: "response.reasoning_summary_text.delta",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: 0,
        delta: payload.delta,
      };
      if (payload.sequence_number !== undefined) next.sequence_number = payload.sequence_number;
      return next;
    }
    case "response.reasoning_text.done": {
      const next: Record<string, unknown> = {
        type: "response.reasoning_summary_text.done",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: 0,
        text: payload.text,
      };
      if (payload.sequence_number !== undefined) next.sequence_number = payload.sequence_number;
      return next;
    }
    default: {
      let changed = false;
      const next: Record<string, unknown> = { ...payload };
      if (isPlainObject(next.item) && next.item.type === "reasoning") {
        const rewritten = reasoningItemToSummaryShape(next.item, projectSummary);
        if (rewritten !== next.item) {
          next.item = rewritten;
          changed = true;
        }
      }
      // SSE event shape: {type: "response.completed", response: {output}}.
      const response = isPlainObject(next.response) ? { ...next.response } : null;
      if (response && Array.isArray(response.output)) {
        const output = response.output.map(item => {
          if (!isPlainObject(item) || item.type !== "reasoning") return item;
          const rewritten = reasoningItemToSummaryShape(item, projectSummary);
          if (rewritten !== item) changed = true;
          return rewritten;
        });
        if (changed) {
          response.output = output;
          next.response = response;
        }
      }
      // Bare response document shape (non-streaming passthrough):
      // {object: "response", output: [...]}.
      if (Array.isArray(next.output)) {
        const output = next.output.map(item => {
          if (!isPlainObject(item) || item.type !== "reasoning") return item;
          const rewritten = reasoningItemToSummaryShape(item, projectSummary);
          if (rewritten !== item) changed = true;
          return rewritten;
        });
        if (changed) next.output = output;
      }
      return changed ? next : null;
    }
  }
}

const MAX_REASONING_TITLE_CODEPOINTS = 100;
const SENTENCE_END = /[.!?。！？]/;

function truncateCodePoints(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : `${points.slice(0, limit).join("")}…`;
}

/** Format raw third-party reasoning as the title shape the live TUI recognizes. */
function projectRawReasoningSummary(raw: string): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  const end = normalized.search(SENTENCE_END);
  const title = end >= 0
    ? normalized.slice(0, end + 1)
    : truncateCodePoints(normalized, MAX_REASONING_TITLE_CODEPOINTS);
  return `**${title || "Thinking"}**\n\n${raw}`;
}

function titleReady(raw: string): boolean {
  const normalized = raw.replace(/\s+/g, " ").trim();
  return SENTENCE_END.test(normalized) || Array.from(normalized).length >= MAX_REASONING_TITLE_CODEPOINTS;
}

type PendingReasoning = {
  raw: string;
  emitted: boolean;
  lastBlock?: string;
  lastEvent?: Record<string, unknown>;
};

function summaryDelta(payload: Record<string, unknown>, delta: string): Record<string, unknown> {
  const next: Record<string, unknown> = {
    type: "response.reasoning_summary_text.delta",
    item_id: payload.item_id,
    output_index: payload.output_index,
    summary_index: 0,
    delta,
  };
  if (payload.sequence_number !== undefined) next.sequence_number = payload.sequence_number;
  return next;
}

function summaryDone(payload: Record<string, unknown>, text: string): Record<string, unknown> {
  const next: Record<string, unknown> = {
    type: "response.reasoning_summary_text.done",
    item_id: payload.item_id,
    output_index: payload.output_index,
    summary_index: 0,
    text,
  };
  if (payload.sequence_number !== undefined) next.sequence_number = payload.sequence_number;
  return next;
}

/**
 * Stateful stream projection for raw third-party reasoning. It waits until the
 * first sentence (or a bounded fallback) before emitting the first summary
 * delta, so the TUI receives a readable bold heading instead of raw prose.
 */
export function createReasoningSummaryChannelBlockRewrite(): SseBlockRewrite {
  const pending = new Map<string, PendingReasoning>();

  const emitBuffered = (block: string, payload: Record<string, unknown>, state: PendingReasoning): string[] => {
    state.emitted = true;
    state.lastBlock = undefined;
    state.lastEvent = undefined;
    return [replaceSseDataPayload(block, JSON.stringify(summaryDelta(payload, projectRawReasoningSummary(state.raw))))];
  };

  const rewrite: SseBlockRewrite = (block) => {
    const source = sseDataPayload(block);
    if (source === null || source === "[DONE]") return [block];
    let payload: unknown;
    try {
      payload = JSON.parse(source);
    } catch {
      return [block];
    }
    if (!isPlainObject(payload)) return [block];

    if (payload.type === "response.reasoning_text.delta" && typeof payload.item_id === "string" && typeof payload.delta === "string") {
      const state = pending.get(payload.item_id) ?? { raw: "", emitted: false };
      state.raw += payload.delta;
      pending.set(payload.item_id, state);
      if (!state.emitted) {
        state.lastBlock = block;
        state.lastEvent = payload;
        return titleReady(state.raw) ? emitBuffered(block, payload, state) : [];
      }
      return [replaceSseDataPayload(block, JSON.stringify(summaryDelta(payload, payload.delta)))];
    }

    if (payload.type === "response.reasoning_text.done" && typeof payload.item_id === "string") {
      const state = pending.get(payload.item_id);
      const finalRaw = typeof payload.text === "string" ? payload.text : state?.raw ?? "";
      if (state && !state.emitted) {
        state.raw = finalRaw;
        const delta = replaceSseDataPayload(block, JSON.stringify(summaryDelta(payload, projectRawReasoningSummary(finalRaw))));
        const done = replaceSseDataPayload(block, JSON.stringify(summaryDone(payload, projectRawReasoningSummary(finalRaw))));
        pending.delete(payload.item_id);
        return [delta, done];
      }
      pending.delete(payload.item_id);
      return [replaceSseDataPayload(block, JSON.stringify(summaryDone(payload, projectRawReasoningSummary(finalRaw))))];
    }

    const rewritten = rewritePayload(payload, projectRawReasoningSummary);
    return rewritten === null ? [block] : [replaceSseDataPayload(block, JSON.stringify(rewritten))];
  };

  rewrite.flush = () => {
    const output: string[] = [];
    for (const state of pending.values()) {
      if (!state.emitted && state.lastBlock && state.lastEvent) {
        output.push(...emitBuffered(state.lastBlock, state.lastEvent, state));
      }
    }
    pending.clear();
    return output;
  };
  rewrite.dispose = () => pending.clear();
  return rewrite;
}

/** Payload rewrite for passthrough relays whose upstream emits content-channel reasoning. */
export function createReasoningSummaryChannelPayloadRewrite(): SsePayloadRewrite {
  return (payload: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return payload;
    }
    if (!isPlainObject(parsed)) return payload;
    const rewritten = rewritePayload(parsed);
    return rewritten !== null ? JSON.stringify(rewritten) : payload;
  };
}

/**
 * Object-level variant for the non-streaming passthrough: the bounded-JSON
 * relay bypasses the SSE payload rewrite, so reasoning items inside a full
 * Responses JSON document need the same normalization before plain JSON
 * serialization or forced JSON-to-SSE reframing. Returns the same reference
 * when nothing changed.
 */
export function rewriteReasoningSummaryInJson(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const rewritten = rewritePayload(value);
  return rewritten !== null ? rewritten : value;
}

/** String-level variant of {@link rewriteReasoningSummaryInJson}. */
export function rewriteReasoningSummaryInJsonString(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  const rewritten = rewriteReasoningSummaryInJson(parsed);
  return rewritten === parsed ? json : JSON.stringify(rewritten);
}

/**
 * True when a routed native-Responses provider emits content-channel reasoning
 * (raw `reasoning_text`) instead of the summary channel. DeepSeek's
 * `/responses` endpoint is the current example: it ships raw thinking with an
 * empty `summary` and keeps `preserveReasoningContentModels` so multi-turn
 * replays round-trip.
 */
export function routeUsesContentChannelReasoning(
  provider: { statelessResponses?: boolean; preserveReasoningContentModels?: string[] },
  modelId: string,
): boolean {
  if (provider.statelessResponses === true) return true;
  const preserved = provider.preserveReasoningContentModels;
  const normalizedModelId = modelId.toLowerCase();
  return Array.isArray(preserved)
    && preserved.some(id => id.toLowerCase() === normalizedModelId);
}

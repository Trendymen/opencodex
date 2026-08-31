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
 * Streaming display projection: the first part keeps the established shape
 * (bold title + first sentence emitted as one summary delta, closed by the
 * mapped part lifecycle), then the raw text is buffered and re-emitted as
 * additional summary parts (3 sentences or 500 code points, whichever comes
 * first) with a complete added/delta/done lifecycle each, so the Desktop
 * preview refreshes in GPT-like bursts instead of growing one monolithic
 * item. Terminal snapshots reuse the emitted parts for `summary[]`.
 *
 * Replay compatibility: Codex echoes the reasoning item it received back into
 * the next request's input. DeepSeek's Responses API accepts summary-shaped
 * reasoning input items (verified live), and raw reasoning `content` is kept
 * verbatim on every terminal snapshot so provider-side reasoning state and
 * opaque replay data survive unchanged.
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
  const existing = Array.isArray(item.summary) && item.summary.length > 0
    ? item.summary
    : [{ type: "summary_text", text: projectSummary(text) }];
  return { ...item, summary: existing };
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
      if (!changed && Array.isArray(next.output)) {
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

/** Each streamed summary part aggregates up to this many upstream sentences. */
const SUMMARY_PART_SENTENCE_LIMIT = 3;
/** Split long unpunctuated reasoning once it exceeds this many code points. */
const SUMMARY_PART_CODEPOINT_LIMIT = 500;

type PendingReasoning = {
  /** Completed summary parts, in order (part 0 is the bold first sentence). */
  parts: string[];
  /** Raw reasoning accumulated after the last completed part. */
  buffer: string;
  lastBlock?: string;
  lastEvent?: Record<string, unknown>;
};

function countSentences(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (SENTENCE_END.test(ch)) count++;
  }
  return count;
}

/** Cut after the last complete sentence, or return null when none ended. */
function cutAtSentenceBoundary(text: string): string | null {
  const chars = Array.from(text);
  let seen = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (SENTENCE_END.test(chars[i])) {
      seen = i + 1;
      break;
    }
  }
  return seen > 0 ? chars.slice(0, seen).join("") : null;
}

/** Slice by Unicode code points so a surrogate pair never splits. */
function sliceCodePoints(text: string, count: number): string {
  return Array.from(text).slice(count).join("");
}

function joinedSummary(parts: string[]): string {
  return parts.join("\n\n");
}

/** Terminal reasoning item: keep raw content, project the emitted parts into summary[]. */
function withPartsSummary(item: Record<string, unknown>, parts: string[]): Record<string, unknown> {
  if (!parts.length) return item;
  return { ...item, summary: parts.map(text => ({ type: "summary_text", text })) };
}

/** Rewrite reasoning items inside terminal snapshots using the already-emitted parts. */
function rewriteTerminalItems(payload: Record<string, unknown>, parts: string[]): Record<string, unknown> | null {
  if (!parts.length) return null;
  let changed = false;
  const next: Record<string, unknown> = { ...payload };
  if (isPlainObject(next.item) && next.item.type === "reasoning") {
    next.item = withPartsSummary(next.item, parts);
    changed = true;
  }
  const response = isPlainObject(next.response) ? { ...next.response } : null;
  if (response && Array.isArray(response.output)) {
    response.output = response.output.map((item: unknown) =>
      isPlainObject(item) && item.type === "reasoning" ? withPartsSummary(item, parts) : item,
    );
    next.response = response;
    changed = true;
  }
  return changed ? next : null;
}

/**
 * Stateful stream projection for raw third-party reasoning. It waits until the
 * first sentence (or a bounded fallback) before emitting the first summary
 * delta in the established bold-title shape, then aggregates the remaining
 * raw text into additional parts (3 sentences or 500 code points, whichever
 * comes first) with a complete added/delta/done lifecycle per part.
 */
export function createReasoningSummaryChannelBlockRewrite(): SseBlockRewrite {
  const pending = new Map<string, PendingReasoning>();

  const stateOf = (itemId: string): PendingReasoning => {
    let state = pending.get(itemId);
    if (!state) {
      state = { parts: [], buffer: "" };
      pending.set(itemId, state);
    }
    return state;
  };

  // Emit one additional summary part with a complete lifecycle:
  // part added, text delta, text done, part done.
  const emitPart = (block: string, payload: Record<string, unknown>, state: PendingReasoning, text: string): string[] => {
    state.parts.push(text);
    const summaryIndex = state.parts.length - 1;
    const events = [
      {
        type: "response.reasoning_summary_part.added",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: summaryIndex,
        part: { type: "summary_text", text: "" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: summaryIndex,
        delta: text,
      },
      {
        type: "response.reasoning_summary_text.done",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: summaryIndex,
        text,
      },
      {
        type: "response.reasoning_summary_part.done",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: summaryIndex,
        part: { type: "summary_text", text },
      },
    ];
    return events.map(event => replaceSseDataPayload(block, JSON.stringify(event)));
  };

  // Emit the residual buffer as a final part, then close the summary text
  // channel over the joined parts. State survives until the terminal
  // snapshot so output_item.done can reuse the parts.
  const flushItem = (block: string, payload: Record<string, unknown>, state: PendingReasoning, fullRaw: string): string[] => {
    const output: string[] = [];
    if (!state.parts.length) {
      // No part was streamed yet: keep the single-event first-part shape.
      const projected = projectRawReasoningSummary(fullRaw);
      state.parts.push(projected);
      state.buffer = "";
      output.push(replaceSseDataPayload(block, JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: 0,
        delta: projected,
      })));
      return output;
    }
    if (state.buffer.length > 0) {
      output.push(...emitPart(block, payload, state, state.buffer));
      state.buffer = "";
    }
    output.push(replaceSseDataPayload(block, JSON.stringify({
      type: "response.reasoning_summary_text.done",
      item_id: payload.item_id,
      output_index: payload.output_index,
      summary_index: state.parts.length - 1,
      text: joinedSummary(state.parts),
    })));
    return output;
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
      const state = stateOf(payload.item_id);
      state.lastBlock = block;
      state.lastEvent = payload;
      state.buffer += payload.delta;
      if (!state.parts.length) {
        if (!titleReady(state.buffer)) return [];
        // First part keeps the established single-delta emission.
        const first = projectRawReasoningSummary(state.buffer);
        state.parts.push(first);
        state.buffer = "";
        return [replaceSseDataPayload(block, JSON.stringify({
          type: "response.reasoning_summary_text.delta",
          item_id: payload.item_id,
          output_index: payload.output_index,
          summary_index: 0,
          delta: first,
        }))];
      }
      const sentenceCount = countSentences(state.buffer);
      const codePoints = Array.from(state.buffer).length;
      if (sentenceCount < SUMMARY_PART_SENTENCE_LIMIT && codePoints < SUMMARY_PART_CODEPOINT_LIMIT) return [];
      const cut = sentenceCount >= SUMMARY_PART_SENTENCE_LIMIT ? cutAtSentenceBoundary(state.buffer) : null;
      const splitAt = cut === null ? SUMMARY_PART_CODEPOINT_LIMIT : Array.from(cut).length;
      const emittedText = Array.from(state.buffer).slice(0, splitAt).join("");
      state.buffer = sliceCodePoints(state.buffer, splitAt);
      return emitPart(block, payload, state, emittedText);
    }

    if (payload.type === "response.reasoning_text.done" && typeof payload.item_id === "string") {
      const state = pending.get(payload.item_id);
      if (!state) return [block];
      const fullRaw = typeof payload.text === "string" ? payload.text : state.buffer;
      return flushItem(block, payload, state, fullRaw);
    }

    if (payload.type === "response.content_part.added") {
      const rewritten = rewritePayload(payload, projectRawReasoningSummary);
      return rewritten === null ? [block] : [replaceSseDataPayload(block, JSON.stringify(rewritten))];
    }

    if (payload.type === "response.content_part.done") {
      const state = typeof payload.item_id === "string" ? pending.get(payload.item_id) : undefined;
      // Parts beyond the first already closed inline; a duplicate index-0
      // close would corrupt the summary lifecycle.
      if (state && state.parts.length > 1) return [];
      const rewritten = rewritePayload(payload, projectRawReasoningSummary);
      return rewritten === null ? [block] : [replaceSseDataPayload(block, JSON.stringify(rewritten))];
    }

    if (payload.type === "response.output_item.done" || payload.type === "response.completed") {
      let stateId: string | null = null;
      if (payload.type === "response.output_item.done") {
        if (isPlainObject(payload.item) && typeof payload.item.id === "string") stateId = payload.item.id;
      } else {
        const response = isPlainObject(payload.response) ? payload.response : null;
        if (response && Array.isArray(response.output)) {
          for (const item of response.output) {
            if (isPlainObject(item) && item.type === "reasoning" && typeof item.id === "string") {
              stateId = item.id;
              break;
            }
          }
        }
      }
      const state = stateId !== null ? pending.get(stateId) : undefined;
      if (state && stateId !== null && state.parts.length > 0) {
        const output: string[] = [];
        if (state.buffer.length > 0) {
          const anchor = state.lastEvent ?? { item_id: stateId, output_index: 0 };
          output.push(...emitPart(block, anchor, state, state.buffer));
          state.buffer = "";
        }
        const rewritten = rewriteTerminalItems(payload, state.parts);
        pending.delete(stateId);
        output.push(replaceSseDataPayload(block, JSON.stringify(rewritten ?? payload)));
        return output;
      }
    }

    const rewritten = rewritePayload(payload, projectRawReasoningSummary);
    return rewritten === null ? [block] : [replaceSseDataPayload(block, JSON.stringify(rewritten))];
  };

  rewrite.flush = () => {
    const output: string[] = [];
    for (const state of pending.values()) {
      if (!state.parts.length && state.lastBlock && state.lastEvent) {
        const projected = projectRawReasoningSummary(state.buffer);
        state.parts.push(projected);
        state.buffer = "";
        output.push(replaceSseDataPayload(state.lastBlock, JSON.stringify({
          type: "response.reasoning_summary_text.delta",
          item_id: state.lastEvent.item_id,
          output_index: state.lastEvent.output_index,
          summary_index: 0,
          delta: projected,
        })));
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

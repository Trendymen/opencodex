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
  partZeroAdded: boolean;
  partZeroTextDone: boolean;
  partZeroDone: boolean;
  lastBlock?: string;
  lastEvent?: Record<string, unknown>;
};

type ClosedReasoning = {
  parts: string[];
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
  let sentences = 0;
  for (let i = 0; i < chars.length; i++) {
    if (SENTENCE_END.test(chars[i])) {
      sentences += 1;
      if (sentences === SUMMARY_PART_SENTENCE_LIMIT) return chars.slice(0, i + 1).join("");
    }
  }
  return null;
}

/** Slice by Unicode code points so a surrogate pair never splits. */
function sliceCodePoints(text: string, count: number): string {
  return Array.from(text).slice(count).join("");
}

/** Terminal reasoning item: keep raw content, project the emitted parts into summary[]. */
function withPartsSummary(item: Record<string, unknown>, parts: string[]): Record<string, unknown> {
  if (!parts.length) return item;
  return { ...item, summary: parts.map(text => ({ type: "summary_text", text })) };
}

function streamedRaw(state: PendingReasoning): string {
  if (!state.parts.length) return state.buffer;
  const first = state.parts[0];
  const marker = "\n\n";
  const split = first.indexOf(marker);
  const rawFirst = split >= 0 ? first.slice(split + marker.length) : first;
  return rawFirst + state.parts.slice(1).join("") + state.buffer;
}

function appendTerminalSuffix(state: PendingReasoning, fullRaw: string): void {
  const seen = streamedRaw(state);
  if (fullRaw.length > seen.length && fullRaw.startsWith(seen)) {
    state.buffer += fullRaw.slice(seen.length);
  }
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
  const closed = new Map<string, ClosedReasoning>();

  const stateOf = (itemId: string): PendingReasoning => {
    let state = pending.get(itemId);
    if (!state) {
      state = {
        parts: [],
        buffer: "",
        partZeroAdded: false,
        partZeroTextDone: false,
        partZeroDone: false,
      };
      pending.set(itemId, state);
    }
    return state;
  };

  const ensurePartZeroAdded = (
    block: string,
    payload: Record<string, unknown>,
    state: PendingReasoning,
  ): string[] => {
    if (state.partZeroAdded) return [];
    state.partZeroAdded = true;
    return [replaceSseDataPayload(block, JSON.stringify({
      type: "response.reasoning_summary_part.added",
      item_id: payload.item_id,
      output_index: payload.output_index,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }))];
  };

  const closePartZero = (
    block: string,
    payload: Record<string, unknown>,
    state: PendingReasoning,
  ): string[] => {
    if (!state.parts.length) return [];
    const text = state.parts[0];
    const output: string[] = [];
    if (!state.partZeroTextDone) {
      state.partZeroTextDone = true;
      output.push(replaceSseDataPayload(block, JSON.stringify({
        type: "response.reasoning_summary_text.done",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: 0,
        text,
      })));
    }
    if (!state.partZeroDone) {
      state.partZeroDone = true;
      output.push(replaceSseDataPayload(block, JSON.stringify({
        type: "response.reasoning_summary_part.done",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: 0,
        part: { type: "summary_text", text },
      })));
    }
    return output;
  };

  const closeEmptyPartZero = (
    block: string,
    payload: Record<string, unknown>,
    state: PendingReasoning,
  ): string[] => {
    if (!state.partZeroAdded || state.partZeroDone) return [];
    state.partZeroDone = true;
    return [replaceSseDataPayload(block, JSON.stringify({
      type: "response.reasoning_summary_part.done",
      item_id: payload.item_id,
      output_index: payload.output_index,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }))];
  };

  const emitPartZero = (
    block: string,
    payload: Record<string, unknown>,
    state: PendingReasoning,
    raw: string,
  ): string[] => {
    if (state.parts.length) return [];
    const projected = projectRawReasoningSummary(raw);
    state.parts.push(projected);
    state.buffer = "";
    return [
      ...ensurePartZeroAdded(block, payload, state),
      replaceSseDataPayload(block, JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: 0,
        delta: projected,
      })),
    ];
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

  // Emit the residual buffer as a final part and close the still-open first
  // part. State survives until the terminal snapshot can reuse every part.
  const flushItem = (block: string, payload: Record<string, unknown>, state: PendingReasoning, fullRaw: string): string[] => {
    const output: string[] = [];
    if (!state.parts.length) {
      output.push(...emitPartZero(block, payload, state, fullRaw));
      output.push(...closePartZero(block, payload, state));
      return output;
    }
    appendTerminalSuffix(state, fullRaw);
    output.push(...closePartZero(block, payload, state));
    if (state.buffer.length > 0) {
      output.push(...emitPart(block, payload, state, state.buffer));
      state.buffer = "";
    }
    return output;
  };

  const closeForTerminal = (
    block: string,
    payload: Record<string, unknown>,
    state: PendingReasoning,
    fullRaw: string,
  ): string[] => fullRaw.length > 0 || state.buffer.length > 0 || state.parts.length > 0
    ? flushItem(block, payload, state, fullRaw || state.buffer)
    : closeEmptyPartZero(block, payload, state);

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
        return emitPartZero(block, payload, state, state.buffer);
      }
      const sentenceCount = countSentences(state.buffer);
      const codePoints = Array.from(state.buffer).length;
      if (sentenceCount < SUMMARY_PART_SENTENCE_LIMIT && codePoints < SUMMARY_PART_CODEPOINT_LIMIT) return [];
      const cut = sentenceCount >= SUMMARY_PART_SENTENCE_LIMIT ? cutAtSentenceBoundary(state.buffer) : null;
      const sentenceBoundary = cut === null ? Number.POSITIVE_INFINITY : Array.from(cut).length;
      const splitAt = Math.min(sentenceBoundary, SUMMARY_PART_CODEPOINT_LIMIT);
      const emittedText = Array.from(state.buffer).slice(0, splitAt).join("");
      state.buffer = sliceCodePoints(state.buffer, splitAt);
      return [
        ...closePartZero(block, payload, state),
        ...emitPart(block, payload, state, emittedText),
      ];
    }

    if (payload.type === "response.reasoning_text.done" && typeof payload.item_id === "string") {
      const state = pending.get(payload.item_id);
      const prior = closed.get(payload.item_id);
      if (!state && prior) return [];
      if (!state) {
        const rewritten = rewritePayload(payload, projectRawReasoningSummary);
        return rewritten === null ? [block] : [replaceSseDataPayload(block, JSON.stringify(rewritten))];
      }
      const fullRaw = typeof payload.text === "string" ? payload.text : state.buffer;
      return closeForTerminal(block, payload, state, fullRaw);
    }

    if (payload.type === "response.content_part.added") {
      if (typeof payload.item_id === "string"
        && isPlainObject(payload.part)
        && payload.part.type === "reasoning_text") {
        if (closed.has(payload.item_id)) return [];
        const existing = pending.get(payload.item_id);
        if (existing?.partZeroAdded) return [];
        const state = stateOf(payload.item_id);
        state.lastBlock = block;
        state.lastEvent = payload;
        state.partZeroAdded = true;
      }
      const rewritten = rewritePayload(payload, projectRawReasoningSummary);
      return rewritten === null ? [block] : [replaceSseDataPayload(block, JSON.stringify(rewritten))];
    }

    if (payload.type === "response.content_part.done") {
      const state = typeof payload.item_id === "string" ? pending.get(payload.item_id) : undefined;
      const prior = typeof payload.item_id === "string" ? closed.get(payload.item_id) : undefined;
      if (!state && prior) return [];
      if (state) {
        state.lastBlock = block;
        state.lastEvent = payload;
        const partText = isPlainObject(payload.part) && typeof payload.part.text === "string"
          ? payload.part.text
          : "";
        appendTerminalSuffix(state, partText);
        if (!state.parts.length && state.buffer.length > 0) {
          return flushItem(block, payload, state, state.buffer);
        }
        if (state.parts.length) return closePartZero(block, payload, state);
        return closeEmptyPartZero(block, payload, state);
      }
      const rewritten = rewritePayload(payload, projectRawReasoningSummary);
      return rewritten === null ? [block] : [replaceSseDataPayload(block, JSON.stringify(rewritten))];
    }

    if (payload.type === "response.failed" || payload.type === "response.incomplete") {
      const output: string[] = [];
      const response = isPlainObject(payload.response) ? payload.response : null;
      const terminalItems = response && Array.isArray(response.output)
        ? new Map(response.output.flatMap(item =>
            isPlainObject(item) && item.type === "reasoning" && typeof item.id === "string"
              ? [[item.id, item] as const]
              : []))
        : new Map<string, Record<string, unknown>>();
      for (const [itemId, state] of pending) {
        const anchor = state.lastEvent ?? { item_id: itemId, output_index: 0 };
        const terminalItem = terminalItems.get(itemId);
        const terminalRaw = terminalItem ? reasoningTextOf(terminalItem) : "";
        output.push(...closeForTerminal(block, anchor, state, terminalRaw || state.buffer));
        closed.set(itemId, {
          parts: [...state.parts],
        });
      }
      pending.clear();
      let terminalPayload: Record<string, unknown> = payload;
      const terminalResponse = isPlainObject(payload.response) ? payload.response : null;
      if (terminalResponse && Array.isArray(terminalResponse.output)) {
        let changed = false;
        const rewrittenItems = terminalResponse.output.map(item => {
          if (!isPlainObject(item) || item.type !== "reasoning" || typeof item.id !== "string") return item;
          const prior = closed.get(item.id);
          if (!prior) return item;
          changed = true;
          return withPartsSummary(item, prior.parts);
        });
        if (changed) {
          terminalPayload = {
            ...payload,
            response: { ...terminalResponse, output: rewrittenItems },
          };
        }
      }
      const rewritten = rewritePayload(terminalPayload, projectRawReasoningSummary);
      const finalPayload = rewritten ?? terminalPayload;
      output.push(finalPayload === payload ? block : replaceSseDataPayload(block, JSON.stringify(finalPayload)));
      return output;
    }

    if (payload.type === "response.completed") {
      const response = isPlainObject(payload.response) ? payload.response : null;
      if (response && Array.isArray(response.output)) {
        const output: string[] = [];
        let changed = false;
        const rewrittenItems = response.output.map(item => {
          if (!isPlainObject(item) || item.type !== "reasoning" || typeof item.id !== "string") return item;
          const state = pending.get(item.id);
          const prior = closed.get(item.id);
          if (!state) {
            if (prior) {
              changed = true;
              return withPartsSummary(item, prior.parts);
            }
            return reasoningItemToSummaryShape(item, projectRawReasoningSummary);
          }
          const anchor = state.lastEvent ?? { item_id: item.id, output_index: 0 };
          output.push(...closeForTerminal(block, anchor, state, reasoningTextOf(item) || state.buffer));
          pending.delete(item.id);
          closed.set(item.id, {
            parts: [...state.parts],
          });
          changed = true;
          return withPartsSummary(item, state.parts);
        });
        for (const [itemId, state] of pending) {
          const anchor = state.lastEvent ?? { item_id: itemId, output_index: 0 };
          output.push(...closeForTerminal(block, anchor, state, state.buffer));
          closed.set(itemId, {
            parts: [...state.parts],
          });
        }
        pending.clear();
        if (changed || output.length > 0) {
          output.push(replaceSseDataPayload(block, JSON.stringify({
            ...payload,
            response: { ...response, output: rewrittenItems },
          })));
          return output;
        }
      }
      if (pending.size > 0) {
        const output: string[] = [];
        for (const [itemId, state] of pending) {
          const anchor = state.lastEvent ?? { item_id: itemId, output_index: 0 };
          output.push(...closeForTerminal(block, anchor, state, state.buffer));
          closed.set(itemId, {
            parts: [...state.parts],
          });
        }
        pending.clear();
        output.push(block);
        return output;
      }
    }

    if (payload.type === "response.output_item.done") {
      let stateId: string | null = null;
      if (isPlainObject(payload.item) && typeof payload.item.id === "string") stateId = payload.item.id;
      const state = stateId !== null ? pending.get(stateId) : undefined;
      if (state && stateId !== null) {
        const output: string[] = [];
        const anchor = state.lastEvent ?? { item_id: stateId, output_index: 0 };
        const terminalRaw = payload.type === "response.output_item.done" && isPlainObject(payload.item)
          ? reasoningTextOf(payload.item)
          : state.buffer;
        output.push(...closeForTerminal(block, anchor, state, terminalRaw || state.buffer));
        const rewritten = rewriteTerminalItems(payload, state.parts);
        pending.delete(stateId);
        closed.set(stateId, {
          parts: [...state.parts],
        });
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
      if (state.lastBlock && state.lastEvent && (state.parts.length > 0 || state.buffer.length > 0)) {
        output.push(...flushItem(state.lastBlock, state.lastEvent, state, state.buffer));
      } else if (state.lastBlock && state.lastEvent) {
        output.push(...closeEmptyPartZero(state.lastBlock, state.lastEvent, state));
      }
    }
    pending.clear();
    closed.clear();
    return output;
  };
  rewrite.dispose = () => {
    pending.clear();
    closed.clear();
  };
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

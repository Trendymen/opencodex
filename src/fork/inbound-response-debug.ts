/** Redacted inbound upstream Responses diagnostics for relay compatibility work. */

import { debugProviderDiagnostic } from "../lib/debug";
import { isDebugEnabled } from "../lib/debug-settings";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const MAX_EVENT_TYPES = 64;
const MAX_SHAPE_TYPES = 16;
const MAX_CONTEXT_BYTES = 256;
const MAX_LIVE_TIMELINE_BYTES = 512 * 1024;
const SAFE_CONTEXT_VALUE = /^[A-Za-z0-9._~/:@+-]+$/;
const OPAQUE_THREAD_TAG = /^[a-f0-9]{12}$/;
const KNOWN_EVENT_TYPES = new Set([
  "response.json",
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.output_text.annotation.added",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta",
  "response.custom_tool_call_input.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.error",
]);
const KNOWN_ITEM_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "custom_tool_call",
  "tool_search_call",
  "web_search_call",
  "computer_call",
  "image_generation_call",
  "code_interpreter_call",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "item_reference",
  "compaction",
]);
const KNOWN_CONTENT_TYPES = new Set([
  "output_text",
  "reasoning_text",
  "summary_text",
  "refusal",
  "input_text",
]);
const KNOWN_ROLES = new Set(["assistant", "user", "system", "developer"]);
const KNOWN_PHASES = new Set(["commentary", "final_answer"]);
const KNOWN_RESPONSE_STATUSES = new Set([
  "queued",
  "in_progress",
  "completed",
  "failed",
  "incomplete",
  "cancelled",
  "cancelling",
]);

function knownLabel(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  return allowed.has(value) ? value : "other";
}

function payloadTypeSummary(value: unknown, allowed: ReadonlySet<string>): { types: string[]; truncated: boolean } {
  if (!Array.isArray(value)) return { types: [], truncated: false };
  return {
    types: value.slice(0, MAX_SHAPE_TYPES)
      .map(entry => knownLabel(isPlainObject(entry) ? entry.type : undefined, allowed) ?? "other"),
    truncated: value.length > MAX_SHAPE_TYPES,
  };
}

function stringBytes(value: unknown): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

export interface InboundResponsesDebugSummary {
  kind: "inbound-sse-summary" | "inbound-json-summary";
  terminal: "completed" | "failed" | "incomplete" | "none";
  eventCounts: Record<string, number>;
  textBytes: {
    reasoningText: number;
    reasoningSummaryText: number;
    outputText: number;
  };
  timeline: Record<string, unknown>[];
  timelineTruncated: boolean;
}

// Durable provider-debug.jsonl remains append-only, but a live stream must never retain an
// unbounded event history in the request path. The budget is deliberately far above the UI
// preview limit; event/text aggregate counters continue after its detailed timeline fills.
const DEFAULT_TIMELINE_LIMIT = 4_096;

export interface InboundResponsesDebugObserverOptions {
  timelineLimit?: number;
}

export function createInboundResponsesDebugObserver(
  options: InboundResponsesDebugObserverOptions = {},
): {
  notePayload: (payload: unknown) => void;
  noteJsonResponse: (payload: unknown) => void;
  summary: () => InboundResponsesDebugSummary;
} {
  const timelineLimit = Math.max(0, Math.trunc(options.timelineLimit ?? DEFAULT_TIMELINE_LIMIT));
  const eventCounts: Record<string, number> = {};
  const textBytes = {
    reasoningText: 0,
    reasoningSummaryText: 0,
    outputText: 0,
  };
  const timeline: Record<string, unknown>[] = [];
  let timelineBytes = 0;
  let timelineTruncated = false;
  let terminal: InboundResponsesDebugSummary["terminal"] = "none";
  let kind: InboundResponsesDebugSummary["kind"] = "inbound-sse-summary";

  const addEvent = (type: string): void => {
    let key = knownLabel(type, KNOWN_EVENT_TYPES) ?? "other";
    if (!Object.hasOwn(eventCounts, key) && Object.keys(eventCounts).length >= MAX_EVENT_TYPES - 1) {
      key = "other";
    }
    eventCounts[key] = (eventCounts[key] ?? 0) + 1;
  };

  const addTimeline = (entry: Record<string, unknown>): void => {
    if (timeline.length >= timelineLimit) {
      timelineTruncated = true;
      return;
    }
    const next = { seq: timeline.length, ...entry };
    const nextBytes = Buffer.byteLength(JSON.stringify(next), "utf8");
    if (timelineBytes + nextBytes > MAX_LIVE_TIMELINE_BYTES) {
      timelineTruncated = true;
      return;
    }
    timeline.push(next);
    timelineBytes += nextBytes;
  };

  const noteOutputItem = (type: string, item: unknown): void => {
    if (!isPlainObject(item)) {
      addTimeline({ type });
      return;
    }
    const content = payloadTypeSummary(item.content, KNOWN_CONTENT_TYPES);
    const base = {
      type,
      ...(knownLabel(item.type, KNOWN_ITEM_TYPES) ? { itemType: knownLabel(item.type, KNOWN_ITEM_TYPES) } : {}),
      ...(knownLabel(item.role, KNOWN_ROLES) ? { role: knownLabel(item.role, KNOWN_ROLES) } : {}),
      ...(knownLabel(item.phase, KNOWN_PHASES) ? { phase: knownLabel(item.phase, KNOWN_PHASES) } : {}),
      ...(Array.isArray(item.content)
        ? {
            contentTypes: content.types,
            ...(content.truncated ? { contentTypesTruncated: true } : {}),
          }
        : {}),
      ...(Array.isArray(item.summary) ? { summaryParts: item.summary.length } : {}),
      ...(typeof item.encrypted_content === "string" && item.encrypted_content.length > 0
        ? { hasEncryptedContent: true }
        : {}),
    };
    addTimeline(base);
  };

  const noteResponse = (type: string, responseValue: unknown): void => {
    const response = isPlainObject(responseValue) ? responseValue : {};
    const output = payloadTypeSummary(response.output, KNOWN_ITEM_TYPES);
    addTimeline({
      type,
      ...(knownLabel(response.status, KNOWN_RESPONSE_STATUSES)
        ? { responseStatus: knownLabel(response.status, KNOWN_RESPONSE_STATUSES) }
        : {}),
      ...(Array.isArray(response.output)
        ? {
            outputItemTypes: output.types,
            ...(output.truncated ? { outputItemTypesTruncated: true } : {}),
          }
        : {}),
    });
  };

  const noteOutputTextBytes = (item: Record<string, unknown>): void => {
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isPlainObject(part)) continue;
        const type = knownLabel(part.type, KNOWN_CONTENT_TYPES);
        if (type === "reasoning_text") textBytes.reasoningText += stringBytes(part.text);
        if (type === "output_text") textBytes.outputText += stringBytes(part.text);
      }
    }
    if (Array.isArray(item.summary)) {
      for (const part of item.summary) {
        if (isPlainObject(part)) textBytes.reasoningSummaryText += stringBytes(part.text);
      }
    }
  };

  const setTerminalFromStatus = (status: unknown): void => {
    if (status === "completed" || status === "failed" || status === "incomplete") terminal = status;
  };

  const notePayload = (payload: unknown): void => {
    if (!isPlainObject(payload) || typeof payload.type !== "string") return;
    addEvent(payload.type);
    const timelineType = knownLabel(payload.type, KNOWN_EVENT_TYPES) ?? "other";
    switch (payload.type) {
      case "response.reasoning_text.delta":
      case "response.reasoning_text.done": {
        const bytes = stringBytes(typeof payload.delta === "string" ? payload.delta : payload.text);
        textBytes.reasoningText += bytes;
        addTimeline(payload.type.endsWith("delta")
          ? { type: timelineType, deltaBytes: bytes }
          : { type: timelineType, textBytes: bytes });
        return;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_summary_text.done": {
        const bytes = stringBytes(typeof payload.delta === "string" ? payload.delta : payload.text);
        textBytes.reasoningSummaryText += bytes;
        addTimeline(payload.type.endsWith("delta")
          ? { type: timelineType, deltaBytes: bytes }
          : { type: timelineType, textBytes: bytes });
        return;
      }
      case "response.output_text.delta":
      case "response.output_text.done": {
        const bytes = stringBytes(typeof payload.delta === "string" ? payload.delta : payload.text);
        textBytes.outputText += bytes;
        addTimeline(payload.type.endsWith("delta")
          ? { type: timelineType, deltaBytes: bytes }
          : { type: timelineType, textBytes: bytes });
        return;
      }
      case "response.output_item.added":
      case "response.output_item.done": {
        noteOutputItem(timelineType, payload.item);
        return;
      }
      case "response.completed":
      case "response.failed":
      case "response.incomplete": {
        terminal = payload.type === "response.completed"
          ? "completed"
          : payload.type === "response.failed" ? "failed" : "incomplete";
        noteResponse(timelineType, payload.response);
        return;
      }
      default: {
        addTimeline({ type: timelineType });
      }
    }
  };

  const noteJsonResponse = (payload: unknown): void => {
    kind = "inbound-json-summary";
    addEvent("response.json");
    if (!isPlainObject(payload)) {
      addTimeline({ type: "response.json", responseKind: typeof payload });
      return;
    }
    setTerminalFromStatus(payload.status);
    noteResponse("response.json", payload);
    if (!Array.isArray(payload.output)) return;
    for (const item of payload.output) {
      if (!isPlainObject(item)) {
        noteOutputItem("response.output_item.done", item);
        continue;
      }
      noteOutputTextBytes(item);
      noteOutputItem("response.output_item.done", item);
    }
  };

  return {
    notePayload,
    noteJsonResponse,
    summary: () => ({
      kind,
      terminal,
      eventCounts,
      textBytes,
      timeline,
      timelineTruncated,
    }),
  };
}

export function persistInboundResponsesDebugSummary(args: {
  observer: ReturnType<typeof createInboundResponsesDebugObserver>;
  host: string;
  pathname: string;
  model: string;
  threadIdTag?: string;
  httpStatus?: number;
  persist?: (entry: Record<string, unknown>) => void;
}): void {
  if (!isDebugEnabled()) return;
  const context = (value: string): string => (
    Buffer.byteLength(value, "utf8") <= MAX_CONTEXT_BYTES && SAFE_CONTEXT_VALUE.test(value)
      ? value
      : "other"
  );
  const entry = {
    ...args.observer.summary(),
    host: context(args.host),
    pathname: context(args.pathname),
    model: context(args.model),
    ...(args.threadIdTag && OPAQUE_THREAD_TAG.test(args.threadIdTag) ? { threadIdTag: args.threadIdTag } : {}),
    ...(args.httpStatus !== undefined && Number.isInteger(args.httpStatus)
      && args.httpStatus >= 100 && args.httpStatus <= 599 ? { httpStatus: args.httpStatus } : {}),
  };
  if (args.persist) {
    args.persist(entry);
    return;
  }
  // The in-memory DebugLogEntry remains a compact UI preview, while provider-debug.jsonl retains
  // the complete, already allowlisted structural evidence for an opt-in operator diagnostic.
  debugProviderDiagnostic("openai-responses", entry.kind, entry, { durableFullLine: true });
}

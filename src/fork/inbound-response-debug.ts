/**
 * Inbound upstream and downstream Responses diagnostics for relay compatibility work.
 *
 * The user explicitly authorized bounded, non-fully-redacted TEXT SAMPLES for this operator
 * diagnostic: sampled strings are cut at a hard UTF-8-safe byte limit and stored in a referenced
 * provider-debug artifact file; provider-debug.jsonl carries only the structural summary plus a relative
 * reference. Credentials, request bodies, full long chains, and non-text fields are never
 * captured. Two stages are recorded separately:
 * - upstream-inbound: the original upstream stream (before client rewrites).
 * - downstream-after-rewrite: the actual client-bound stream, where OCX may add `phase`.
 */

import { appendFileSync, chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { debugProviderDiagnostic } from "../lib/debug";
import { isDebugEnabled } from "../lib/debug-settings";
import { redactSecretString } from "../lib/redact";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const MAX_EVENT_TYPES = 64;
const MAX_SHAPE_TYPES = 16;
const MAX_CONTEXT_BYTES = 256;
// User-authorized bounded text samples: 256 bytes per string, at most 512 strings per turn, and
// never more than the live diagnostic budget in aggregate. provider-debug.jsonl carries only the
// structural summary plus a relative reference into the provider-debug artifact directory.
const DEFAULT_TEXT_SAMPLE_LIMIT = 256;
const MAX_TEXT_SAMPLE_LIMIT = 8 * 1024;
const MAX_ARTIFACT_TEXT_ENTRIES = 512;
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

/** Take a UTF-8 byte prefix without splitting a Unicode scalar. */
function utf8SamplePrefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

export type InboundResponsesDebugStage = "upstream-inbound" | "downstream-after-rewrite";

type CapturedItemMeta = {
  itemId?: string;
  itemType?: string;
  role?: string;
  phase?: string;
};

const SAFE_ITEM_ID = /^[A-Za-z0-9_.:-]+$/;

function safeItemId(value: unknown): string | undefined {
  if (typeof value !== "string" || redactSecretString(value) !== value || !SAFE_ITEM_ID.test(value)) return undefined;
  return Buffer.byteLength(value, "utf8") <= 128 ? value : undefined;
}

function hardenArtifactPath(path: string, mode: 0o700 | 0o600): void {
  try {
    chmodSync(path, mode);
  } catch {
    if (process.platform !== "win32") throw new Error("Provider debug artifact permission hardening failed");
  }
  if (process.platform === "win32") {
    const result = mode === 0o700
      ? hardenSecretDir(path, { required: true })
      : hardenSecretPath(path, { required: true });
    if (!result.ok) throw new Error("Provider debug artifact permission hardening failed");
  }
}

export interface InboundResponsesDebugSummary {
  kind: "inbound-sse-summary" | "inbound-json-summary" | "inbound-downstream-summary";
  terminal: "completed" | "failed" | "incomplete" | "none";
  eventCounts: Record<string, number>;
  textBytes: {
    reasoningText: number;
    reasoningSummaryText: number;
    outputText: number;
  };
  timeline: Record<string, unknown>[];
  timelineTruncated: boolean;
  /** Operator-authorized bounded samples; carried in the observer summary, persisted to an artifact. */
  textSamples?: {
    stage: InboundResponsesDebugStage;
    eventType: string;
    channel: string;
    kind: "delta" | "done" | "snapshot";
    itemId: string;
    itemType?: string;
    role?: string;
    phase?: string;
    text: string;
    textBytes: number;
    sampleBytes: number;
    truncated?: true;
  }[];
  textRef?: string;
  textCaptureTruncated?: boolean;
}

// Durable provider-debug.jsonl remains append-only, but a live stream must never retain an
// unbounded event history in the request path. The budget is deliberately far above the UI
// preview limit; event/text aggregate counters continue after its detailed timeline fills.
const DEFAULT_TIMELINE_LIMIT = 4_096;

export interface InboundResponsesDebugObserverOptions {
  timelineLimit?: number;
  textSampleLimit?: number;
  stage?: InboundResponsesDebugStage;
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
  const stage = options.stage ?? "upstream-inbound";
  const textSamples: NonNullable<InboundResponsesDebugSummary["textSamples"]> = [];
  let textSampleBytes = 0;
  let textCaptureTruncated = false;
  const textSampleLimit = Math.min(
    MAX_TEXT_SAMPLE_LIMIT,
    Math.max(0, Math.trunc(options.textSampleLimit ?? DEFAULT_TEXT_SAMPLE_LIMIT)),
  );

  const sampleText = (
    channel: string,
    kind: "delta" | "done" | "snapshot",
    value: unknown,
    itemId: unknown,
    eventType: string,
    explicitMeta?: CapturedItemMeta,
  ): void => {
    if (typeof value !== "string" || value.length === 0 || textSampleLimit === 0) return;
    const textBytes = Buffer.byteLength(value, "utf8");
    const redacted = redactSecretString(value);
    const cut = utf8SamplePrefix(redacted, textSampleLimit);
    const sampleBytes = Buffer.byteLength(cut, "utf8");
    const truncated = sampleBytes < Buffer.byteLength(redacted, "utf8");
    if (truncated) textCaptureTruncated = true;
    if (cut.length === 0) return;
    if (textSamples.length >= MAX_ARTIFACT_TEXT_ENTRIES
      || textSampleBytes + sampleBytes > MAX_LIVE_TIMELINE_BYTES) {
      textCaptureTruncated = true;
      return;
    }
    textSampleBytes += sampleBytes;
    const capturedItemId = safeItemId(itemId)
      ?? (itemId === undefined || itemId === null ? "missing" : "redacted");
    const meta = explicitMeta;
    textSamples.push({
      stage,
      eventType,
      channel,
      kind,
      itemId: capturedItemId,
      ...(meta?.itemType ? { itemType: meta.itemType } : {}),
      ...(meta?.role ? { role: meta.role } : {}),
      ...(meta?.phase ? { phase: meta.phase } : {}),
      text: cut,
      textBytes,
      sampleBytes,
      ...(truncated ? { truncated: true as const } : {}),
    });
  };
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
    // Authorized text samples flow only into the artifact capture; keep timeline text-free.
    const { outputSample: _sample, outputTextBytes: _bytes, ...structural } = next as Record<string, unknown>;
    timeline.push(structural);
    timelineBytes += nextBytes;
  };

  const noteOutputItem = (type: string, item: unknown): void => {
    if (!isPlainObject(item)) {
      addTimeline({ type });
      return;
    }
    const content = payloadTypeSummary(item.content, KNOWN_CONTENT_TYPES);
    const itemType = knownLabel(item.type, KNOWN_ITEM_TYPES);
    const meta: CapturedItemMeta = {
      ...(safeItemId(item.id) ? { itemId: safeItemId(item.id) } : {}),
      ...(itemType ? { itemType } : {}),
      ...(knownLabel(item.role, KNOWN_ROLES) ? { role: knownLabel(item.role, KNOWN_ROLES) } : {}),
      ...(knownLabel(item.phase, KNOWN_PHASES) ? { phase: knownLabel(item.phase, KNOWN_PHASES) } : {}),
    };
    const joinedText = Array.isArray(item.content)
      ? item.content.map(part => isPlainObject(part) && typeof part.text === "string" ? part.text : "").join("")
      : "";
    let outputSample = "";
    if (joinedText) {
      outputSample = joinedText.slice(0, textSampleLimit);
      while (outputSample.length > 0 && Buffer.byteLength(outputSample, "utf8") > textSampleLimit) {
        outputSample = outputSample.slice(0, -1);
      }
    }
    const base = {
      type,
      ...meta,
      ...(type === "response.output_item.added" && itemType === "reasoning"
        ? {
            hasContentArray: Array.isArray(item.content),
            hasSummaryArray: Array.isArray(item.summary),
          }
        : {}),
      ...(Array.isArray(item.content)
        ? {
            contentTypes: content.types,
            ...(content.truncated ? { contentTypesTruncated: true } : {}),
          }
        : {}),
      ...(Array.isArray(item.summary) ? { summaryParts: item.summary.length } : {}),
      ...(outputSample ? { outputSample, outputTextBytes: Buffer.byteLength(joinedText, "utf8") } : {}),
      ...(typeof item.encrypted_content === "string" && item.encrypted_content.length > 0
        ? { hasEncryptedContent: true }
        : {}),
    };
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isPlainObject(part)) continue;
        const partType = knownLabel(part.type, KNOWN_CONTENT_TYPES);
        if (partType === "reasoning_text") sampleText("reasoningText", "snapshot", part.text, item.id, type, meta);
        if (partType === "output_text") sampleText("outputText", "snapshot", part.text, item.id, type, meta);
      }
    }
    if (Array.isArray(item.summary)) {
      for (const part of item.summary) {
        if (isPlainObject(part) && knownLabel(part.type, KNOWN_CONTENT_TYPES) === "summary_text") {
          sampleText("reasoningSummaryText", "snapshot", part.text, item.id, type, meta);
        }
      }
    }
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
        sampleText(
          "reasoningText",
          payload.type.endsWith("delta") ? "delta" : "done",
          typeof payload.delta === "string" ? payload.delta : payload.text,
          payload.item_id,
          timelineType,
        );
        textBytes.reasoningText += bytes;
        addTimeline(payload.type.endsWith("delta")
          ? { type: timelineType, deltaBytes: bytes }
          : { type: timelineType, textBytes: bytes });
        return;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_summary_text.done": {
        const bytes = stringBytes(typeof payload.delta === "string" ? payload.delta : payload.text);
        sampleText(
          "reasoningSummaryText",
          payload.type.endsWith("delta") ? "delta" : "done",
          typeof payload.delta === "string" ? payload.delta : payload.text,
          payload.item_id,
          timelineType,
        );
        textBytes.reasoningSummaryText += bytes;
        addTimeline(payload.type.endsWith("delta")
          ? { type: timelineType, deltaBytes: bytes }
          : { type: timelineType, textBytes: bytes });
        return;
      }
      case "response.output_text.delta":
      case "response.output_text.done": {
        const bytes = stringBytes(typeof payload.delta === "string" ? payload.delta : payload.text);
        sampleText(
          "outputText",
          payload.type.endsWith("delta") ? "delta" : "done",
          typeof payload.delta === "string" ? payload.delta : payload.text,
          payload.item_id,
          timelineType,
        );
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
      ...(textSamples.length > 0 ? { textSamples } : {}),
      ...(textCaptureTruncated ? { textCaptureTruncated: true } : {}),
    }),
  };
}

export function persistInboundResponsesDebugSummary(args: {
  observer: ReturnType<typeof createInboundResponsesDebugObserver>;
  host: string;
  pathname: string;
  model: string;
  stage?: "upstream-inbound" | "downstream-after-rewrite";
  threadIdTag?: string;
  httpStatus?: number;
  writeArtifact?: boolean;
  persist?: (entry: Record<string, unknown>) => void;
}): void {
  if (!isDebugEnabled()) return;
  const context = (value: string): string => (
    Buffer.byteLength(value, "utf8") <= MAX_CONTEXT_BYTES && SAFE_CONTEXT_VALUE.test(value)
      ? value
      : "other"
  );
  const observerSummary = args.observer.summary();
  const textSamples = observerSummary.textSamples ?? [];
  const textCaptureTruncated = observerSummary.textCaptureTruncated === true;
  const { textSamples: _s, textCaptureTruncated: _t, ...summary } =
    observerSummary as unknown as Record<string, unknown>;
  let textRef: string | undefined;
  if (args.writeArtifact !== false && textSamples.length > 0) {
    const dir = join(getConfigDir(), "provider-debug-artifacts");
    textRef = join("provider-debug-artifacts", `${Date.now()}-${randomUUID()}.jsonl`);
    try {
      recordOwnedConfigPath(getConfigDir(), dir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      hardenArtifactPath(dir, 0o700);
      const artifactPath = join(getConfigDir(), textRef as string);
      const payloadLines = textSamples
        .map((sample: { channel: string; kind: string; text: string }) => `${JSON.stringify(sample)}\n`)
        .join("");
      appendFileSync(artifactPath, payloadLines, { encoding: "utf8", mode: 0o600 });
      hardenArtifactPath(artifactPath, 0o600);
    } catch {
      // Reference follows the write: if the artifact failed, the summary line carries no pointer.
      try { if (textRef) unlinkSync(join(getConfigDir(), textRef)); } catch { /* best-effort cleanup */ }
      textRef = undefined;
    }
  }
  const entry: Record<string, unknown> = {
    ...summary,
    // Downstream observations are a distinct kind so operator tooling can separate the
    // pre-rewrite upstream feed from what Codex actually receives after OCX rewrites.
    ...(args.stage === "downstream-after-rewrite" ? { kind: "inbound-downstream-summary" } : {}),
    ...(args.stage ? { stage: args.stage } : {}),
    ...(textRef ? { textRef } : {}),
    ...(textCaptureTruncated ? { textCaptureTruncated: true } : {}),
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
  debugProviderDiagnostic(
    "openai-responses",
    typeof entry.kind === "string" ? entry.kind : "inbound-sse-summary",
    entry,
    { durableFullLine: true },
  );
}

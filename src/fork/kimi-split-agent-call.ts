import { validatesRestoredValue } from "../adapters/command-code-restored-schema";
import { stripResponsesOnlyEncryptedMarker } from "../adapters/responses-tool-schema";
import { formatErrorResponse } from "../bridge";
import { markProxyError } from "../lib/client-error-body";
import { TRANSLATOR_MAX_CALL_ARGUMENT_BYTES, TRANSLATOR_MAX_TURN_BYTES, TranslatorBudgetExceededError, type TranslatorBudget } from "../lib/translator-budget";
import { applyReplayRefusalClientHeaders, markResponseNonReplayable } from "../lib/upstream-retry";
import { isOpenAiOperatedResponsesDestination } from "../providers/openai-tiers-destination";
import type { FunctionCallRepairSchema, FunctionCallRepairSchemas } from "../responses/function-call-compat";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../server/sse-payload-rewrite";
import type { OcxProviderConfig } from "../types";
import { KIMI_PLAINTEXT_AGENT_ERROR_CODE } from "./spawn-agent-compat";

const FAILURE_MESSAGE = "The upstream split a collaboration tool call into incomplete items. Retry the request to generate the complete tool call.";
const MAX_ITEMS = 256;
const HISTORICAL_FIELDS = ["agent_type", "fork_turns", "message", "model", "reasoning_effort", "task_name"];
const HISTORICAL_SCHEMA: FunctionCallRepairSchema = {
  name: "spawn_agent",
  namespace: "collaboration",
  parameters: {
    type: "object",
    properties: Object.fromEntries(HISTORICAL_FIELDS.map(name => [name, { type: "string" }])),
    required: HISTORICAL_FIELDS,
    additionalProperties: false,
  },
};
const PAIRED_HISTORY_SCHEMA: FunctionCallRepairSchema = {
  ...HISTORICAL_SCHEMA,
  parameters: { ...HISTORICAL_SCHEMA.parameters, required: ["message", "task_name"] },
};
const WAIT_HISTORY_SCHEMA: FunctionCallRepairSchema = {
  name: "wait_agent",
  namespace: "collaboration",
  parameters: { type: "object", properties: { timeout_ms: { type: "number" } }, additionalProperties: false },
};

type RecordValue = Record<string, unknown>;
type Fragment = { id: string; argumentsText: string };
type SplitResult = { value: unknown; original: unknown[]; fragments: Map<number, Fragment>; artifacts: Map<number, string>; argumentsText: string; rootIndex: number; root: RecordValue };
type PendingCall = { id: string; callId: string; index: number; state: "pending" | "complete" | "incomplete" };

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isKimiSplitAgentRoute(provider: OcxProviderConfig, modelId: string): boolean {
  return provider.authMode !== "forward" && !isOpenAiOperatedResponsesDestination(provider)
    && provider.arkKimiResponsesModels?.includes(modelId) === true;
}

function target(item: unknown): item is RecordValue {
  return isRecord(item) && item.type === "function_call" && (item.name === "spawn_agent" || item.name === "wait_agent")
    && item.namespace === "collaboration" && typeof item.call_id === "string" && item.call_id.length > 0;
}

function declaredSchema(schemas: FunctionCallRepairSchemas, name: string): FunctionCallRepairSchema | undefined {
  const schema = schemas.get("collaboration__" + name);
  return schema?.name === name && schema.namespace === "collaboration" ? schema : undefined;
}

function anonymousIdentity(item: unknown): item is RecordValue {
  return isRecord(item) && item.type === "function_call" && (item.name === "" || item.name === undefined)
    && (item.namespace === "" || item.namespace === undefined || item.namespace === null)
    && (item.call_id === "" || item.call_id === undefined || item.call_id === null)
    && typeof item.id === "string" && item.id.length > 0;
}

function anonymous(item: unknown): item is RecordValue {
  return anonymousIdentity(item) && typeof item.arguments === "string";
}

function emptyAssistant(item: unknown): boolean {
  return isRecord(item) && item.type === "message" && item.role === "assistant" && Array.isArray(item.content)
    && item.content.length > 0 && item.content.every(part => isRecord(part) && part.type === "output_text" && part.text === "");
}

function bareEmptyTextPart(part: unknown): boolean {
  return isRecord(part) && part.type === "output_text" && part.text === ""
    && Object.keys(part).every(key => key === "type" || key === "text"
      || ((key === "annotations" || key === "logprobs") && Array.isArray(part[key]) && part[key].length === 0));
}

function bareEmptyAssistant(item: unknown, referencedIds: ReadonlySet<string>): boolean {
  if (!emptyAssistant(item) || !isRecord(item) || (typeof item.id === "string" && referencedIds.has(item.id))) return false;
  const fields = new Set(["type", "role", "content", "id", "status", "phase", "internal_chat_message_metadata_passthrough"]);
  if (Object.keys(item).some(key => !fields.has(key)) || (item.status !== undefined && item.status !== "completed")
    || (item.phase !== undefined && item.phase !== "commentary" && item.phase !== "final_answer")) return false;
  const metadata = item.internal_chat_message_metadata_passthrough;
  if (metadata !== undefined && (!isRecord(metadata)
    || Object.keys(metadata).some(key => key !== "turn_id" && key !== "content_item_kinds")
    || (metadata.turn_id !== undefined && typeof metadata.turn_id !== "string")
    || (metadata.content_item_kinds !== undefined && (!Array.isArray(metadata.content_item_kinds)
      || metadata.content_item_kinds.some(kind => kind !== "unknown"))))) return false;
  return (item.content as unknown[]).every(bareEmptyTextPart);
}

function bareEmptyAssistantPreview(item: unknown): boolean {
  if (!isRecord(item) || (item.status !== undefined && item.status !== "in_progress" && item.status !== "completed")) return false;
  if (item.content !== undefined && (!Array.isArray(item.content) || !item.content.every(bareEmptyTextPart))) return false;
  const content = Array.isArray(item.content) && item.content.length > 0 ? item.content : [{ type: "output_text", text: "" }];
  return bareEmptyAssistant({ ...item, status: "completed", content }, new Set());
}

function completed(value: RecordValue): boolean {
  return value.status === undefined || value.status === "completed";
}

function sameTurnEmptyBefore(input: unknown[], index: number, root: RecordValue, references: ReadonlySet<string>): boolean {
  const before = input[index - 1];
  const rootMetadata = root.internal_chat_message_metadata_passthrough;
  const beforeMetadata = isRecord(before) ? before.internal_chat_message_metadata_passthrough : undefined;
  return bareEmptyAssistant(before, references) && isRecord(rootMetadata) && typeof rootMetadata.turn_id === "string"
    && rootMetadata.turn_id.trim().length > 0 && isRecord(beforeMetadata) && beforeMetadata.turn_id === rootMetadata.turn_id;
}

function validWaitValue(value: unknown, schema: FunctionCallRepairSchema): boolean {
  return isRecord(value) && Object.entries(value).every(([key, member]) =>
    key === "timeout_ms" && typeof member === "number" && Number.isSafeInteger(member) && member >= 0)
    && isRecord(schema.parameters) && schema.parameters.type === "object" && isRecord(schema.parameters.properties)
    && Object.hasOwn(schema.parameters.properties, "timeout_ms")
    && validatesRestoredValue(value, stripResponsesOnlyEncryptedMarker(schema.parameters));
}

function validArguments(text: string, schema: FunctionCallRepairSchema): boolean {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return false; }
  const wait = schema.name === "wait_agent" && schema.namespace === "collaboration";
  if (!isRecord(value) || (wait
    ? !validWaitValue(value, schema)
    : !Object.values(value).every(member => typeof member === "string"))) return false;
  const token = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const number = /(?:0|[1-9]\d*)/y;
  const seen = new Set<string>();
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? "") && index < text.length) index++; };
  whitespace();
  if (text[index++] !== "{") return false;
  whitespace();
  while (text[index] !== "}") {
    token.lastIndex = index;
    const key = token.exec(text);
    if (!key) return false;
    const name = JSON.parse(key[0]) as string;
    if (seen.has(name)) return false;
    seen.add(name);
    index = token.lastIndex;
    whitespace();
    if (text[index++] !== ":") return false;
    whitespace();
    const member = wait ? number : token;
    member.lastIndex = index;
    if (!member.exec(text)) return false;
    index = member.lastIndex;
    whitespace();
    if (text[index] === "}") break;
    if (text[index++] !== ",") return false;
    whitespace();
  }
  return schema.parameters !== undefined && validatesRestoredValue(value, stripResponsesOnlyEncryptedMarker(schema.parameters));
}

function splitOutput(value: unknown, resolve: (name: string) => FunctionCallRepairSchema | undefined): SplitResult | "invalid" | undefined {
  if (!isRecord(value) || !Array.isArray(value.output)) return undefined;
  const output = value.output;
  for (let index = 0; index < output.length; index++) {
    const root = output[index];
    if (!target(root) || typeof root.arguments !== "string") continue;
    try { JSON.parse(root.arguments); continue; } catch { /* inspect the incomplete call */ }
    const schema = resolve(root.name as string);
    if (!schema) continue;
    if (schema.name !== root.name || schema.namespace !== root.namespace) return "invalid";
    if (!completed(value) || !completed(root) || root.arguments.trim() !== "{" || typeof root.id !== "string" || !root.id) return "invalid";
    const fragments = new Map<number, Fragment>();
    const ids = new Set([root.id]);
    let argumentsText = root.arguments;
    for (let cursor = index + 1; cursor < output.length; cursor++) {
      const item = output[cursor];
      if (emptyAssistant(item)) continue;
      if (!anonymous(item) || ids.has(item.id as string) || fragments.size >= MAX_ITEMS) break;
      if (!completed(item)) return "invalid";
      ids.add(item.id as string);
      fragments.set(cursor, { id: item.id as string, argumentsText: item.arguments as string });
      argumentsText += item.arguments as string;
      if (Buffer.byteLength(argumentsText, "utf8") > TRANSLATOR_MAX_CALL_ARGUMENT_BYTES) return "invalid";
      try { JSON.parse(argumentsText); break; } catch { /* wait for the closing fragment */ }
    }
    if (fragments.size === 0 || !validArguments(argumentsText, schema)) return "invalid";
    for (const id of ids) {
      if (output.filter(item => isRecord(item) && item.id === id).length !== 1) return "invalid";
    }
    if (output.some((item, cursor) => cursor !== index && isRecord(item) && item.call_id === root.call_id)) return "invalid";
    if (output.some((item, cursor) => cursor !== index && !fragments.has(cursor)
      && (anonymous(item) || (target(item) && typeof item.arguments === "string" && (() => {
        try { JSON.parse(item.arguments); return false; } catch { return true; }
      })())))) return "invalid";
    const references = new Set(output.flatMap(item => isRecord(item) && item.type === "item_reference" && typeof item.id === "string" ? [item.id] : []));
    const artifacts = new Map<number, string>();
    const lastFragment = Math.max(...fragments.keys());
    let end = lastFragment + 1;
    while (end < output.length && emptyAssistant(output[end])) end++;
    for (let cursor = index + 1; cursor < end; cursor++) {
      const item = output[cursor];
      if (bareEmptyAssistant(item, references) && isRecord(item) && typeof item.id === "string" && item.id.length > 0
        && output.filter(other => isRecord(other) && other.id === item.id).length === 1) artifacts.set(cursor, item.id);
    }
    const repaired = output.flatMap((item, cursor) => cursor === index ? [{ ...root, arguments: argumentsText }]
      : fragments.has(cursor) || artifacts.has(cursor) ? [] : [item]);
    return { value: { ...value, output: repaired }, original: output, fragments, artifacts, argumentsText, rootIndex: index, root };
  }
  return undefined;
}

export function removeFailedKimiSplitHistory(body: unknown, schemas: FunctionCallRepairSchemas): unknown {
  if (!isRecord(body) || !Array.isArray(body.input)) return body;
  const input = body.input;
  const removed = new Set<number>();
  const referencedIds = new Set(input.flatMap(item => isRecord(item) && item.type === "item_reference" && typeof item.id === "string" ? [item.id] : []));
  for (let index = 0; index < input.length; index++) {
    const root = input[index];
    if (!target(root) || typeof root.arguments !== "string" || root.arguments.trim() !== "{") continue;
    const fallback = root.name === "wait_agent" ? WAIT_HISTORY_SCHEMA : HISTORICAL_SCHEMA;
    const schema = declaredSchema(schemas, root.name as string) ?? fallback;
    const items: unknown[] = [root];
    const group: number[] = [index];
    let cursor = index + 1;
    while (cursor < input.length && (emptyAssistant(input[cursor]) || anonymous(input[cursor]))) {
      if (anonymous(input[cursor])) { items.push(input[cursor]); group.push(cursor); }
      else if (bareEmptyAssistant(input[cursor], referencedIds)) group.push(cursor);
      cursor++;
      if (cursor - index > MAX_ITEMS * 2) break;
    }
    let repaired = splitOutput({ output: items }, () => schema);
    if (repaired === "invalid" && schema !== fallback) repaired = splitOutput({ output: items }, () => fallback);
    if (!repaired || repaired === "invalid" || repaired.fragments.size !== items.length - 1) continue;
    const output = input[cursor];
    if (!isRecord(output) || output.type !== "function_call_output" || output.call_id !== root.call_id
      || typeof output.output !== "string" || !output.output.startsWith("failed to parse function arguments:")) continue;
    group.push(cursor++);
    let count = 0;
    while (count < repaired.fragments.size) {
      const next = input[cursor];
      if (!isRecord(next) || next.type !== "function_call_output" || (next.call_id !== "" && next.call_id !== undefined)
        || next.output !== "unsupported call: ") break;
      group.push(cursor++);
      count++;
    }
    if (count !== repaired.fragments.size) continue;
    if (sameTurnEmptyBefore(input, index, root, referencedIds)) group.push(index - 1);
    for (const slot of group) removed.add(slot);
    index = cursor - 1;
  }
  for (let index = 0; index < input.length; index++) {
    const root = input[index];
    if (!target(root) || typeof root.arguments !== "string") continue;
    const fallback = root.name === "wait_agent" ? WAIT_HISTORY_SCHEMA : PAIRED_HISTORY_SCHEMA;
    const schema = declaredSchema(schemas, root.name as string) ?? fallback;
    if (!validArguments(root.arguments, schema) && !validArguments(root.arguments, fallback)) continue;
    const calls = input.filter(item => isRecord(item) && (item.type === "function_call" || item.type === "custom_tool_call") && item.call_id === root.call_id);
    const results = input.filter(item => isRecord(item) && (item.type === "function_call_output" || item.type === "custom_tool_call_output") && item.call_id === root.call_id);
    if (calls.length !== 1 || results.length !== 1) continue;
    const group: number[] = [];
    let cursor = index + 1;
    while (cursor < input.length && bareEmptyAssistant(input[cursor], referencedIds)) group.push(cursor++);
    const result = input[cursor];
    if (!isRecord(result) || result.type !== "function_call_output" || result.call_id !== root.call_id) continue;
    if (sameTurnEmptyBefore(input, index, root, referencedIds)) group.push(index - 1);
    if (group.length === 0) continue;
    for (const slot of group) removed.add(slot);
    index = cursor;
  }
  return removed.size ? { ...body, input: input.filter((_item, index) => !removed.has(index)) } : body;
}

export function createKimiSplitAgentCallRepair(options: {
  provider: OcxProviderConfig;
  modelId: string;
  schemas: FunctionCallRepairSchemas;
  budget?: TranslatorBudget;
  onRefusal?: () => void;
}): { blockRewrite: SseBlockRewrite; rewriteJson: (text: string) => string | undefined; errorResponse: () => Response } | undefined {
  const resolve = (name: string) => declaredSchema(options.schemas, name);
  if (!isKimiSplitAgentRoute(options.provider, options.modelId) || (!resolve("spawn_agent") && !resolve("wait_agent"))) return undefined;
  const authorizedTarget = (item: unknown): item is RecordValue => target(item) && !!resolve(item.name as string);
  let buffered: string[] = [];
  let bytes = 0;
  let candidates: PendingCall[] = [];
  let failed = false;
  const release = (): string[] => {
    options.budget?.releaseRetained(bytes, { kind: "retained_collectors" });
    bytes = 0;
    const blocks = buffered;
    buffered = [];
    return blocks;
  };
  const retain = (block: string): void => {
    const size = 64 + Buffer.byteLength(block, "utf8");
    if (bytes + size > TRANSLATOR_MAX_TURN_BYTES) throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
    options.budget?.chargeRetained(size, { kind: "retained_collectors" });
    bytes += size;
    buffered.push(block);
  };
  const refuse = (newline: string): readonly string[] => {
    release();
    candidates = [];
    failed = true;
    options.onRefusal?.();
    const error = { type: "upstream_error", code: KIMI_PLAINTEXT_AGENT_ERROR_CODE, message: FAILURE_MESSAGE, retryable: false };
    return [`event: response.failed${newline}data: ${JSON.stringify({ type: "response.failed", replayUnsafe: true, response: { status: "failed", error, last_error: error } })}`, "data: [DONE]"];
  };
  const project = (result: SplitResult, root: PendingCall): string[] | undefined => {
    const seen = new Map<number, string>();
    const seenArtifacts = new Set<number>();
    const previews = new Map<number, { added?: string; delta?: string; deltaBytes?: number; argumentsDone?: string }>();
    let rootDelta = false;
    const out: string[] = [];
    for (const block of buffered) {
      const data = sseDataPayload(block);
      if (data === null || data === "[DONE]") { out.push(block); continue; }
      let payload: unknown;
      try { payload = JSON.parse(data); } catch { return undefined; }
      if (!isRecord(payload)) return undefined;
      const index = typeof payload.output_index === "number" ? payload.output_index : undefined;
      const item = isRecord(payload.item) ? payload.item : undefined;
      const id = typeof payload.item_id === "string" ? payload.item_id : typeof item?.id === "string" ? item.id : undefined;
      if (typeof payload.item_id === "string" && typeof item?.id === "string" && payload.item_id !== item.id) return undefined;
      if (item?.type === "function_call" && index !== result.rootIndex && item.call_id === root.callId) return undefined;
      if (payload.type === "response.output_item.done" && item?.type === "function_call") {
        if (index === undefined || !Number.isSafeInteger(index) || index < 0) return undefined;
        const snapshot = result.original[index];
        if (!isRecord(snapshot) || snapshot.type !== "function_call" || !completed(item) || !completed(snapshot)
          || item.id !== snapshot.id || (item.name ?? "") !== (snapshot.name ?? "")
          || (item.namespace ?? "") !== (snapshot.namespace ?? "") || (item.call_id ?? "") !== (snapshot.call_id ?? "")
          || item.arguments !== snapshot.arguments) return undefined;
      }
      if (index !== undefined && result.artifacts.has(index)) {
        if (id !== result.artifacts.get(index)) return undefined;
        if ((payload.type === "response.output_text.delta" || payload.type === "response.output_text.done")
          && payload.logprobs !== undefined && (!Array.isArray(payload.logprobs) || payload.logprobs.length > 0)) return undefined;
        if (payload.type === "response.output_item.added") {
          if (!bareEmptyAssistantPreview(item)) return undefined;
        } else if (payload.type === "response.output_item.done") {
          if (!bareEmptyAssistant(item, new Set()) || seenArtifacts.has(index)) return undefined;
          seenArtifacts.add(index);
        } else if (payload.type === "response.content_part.added" || payload.type === "response.content_part.done") {
          if (payload.part !== undefined && !bareEmptyTextPart(payload.part)) return undefined;
        } else if (payload.type === "response.output_text.delta") {
          if (payload.delta !== "") return undefined;
        } else if (payload.type === "response.output_text.done") {
          if (payload.text !== undefined && payload.text !== "") return undefined;
        } else return undefined;
        continue;
      }
      if (index !== undefined && (index === result.rootIndex || result.fragments.has(index))) {
        const expectedId = index === result.rootIndex ? root.id : result.fragments.get(index)!.id;
        if (id !== expectedId) return undefined;
        const preview = previews.get(index) ?? {};
        if (payload.type === "response.output_item.added") {
          if (!item || preview.added !== undefined || (item.arguments !== undefined && typeof item.arguments !== "string")) return undefined;
          preview.added = typeof item.arguments === "string" ? item.arguments : "";
        }
        if (payload.type === "response.function_call_arguments.delta") {
          if (typeof payload.delta !== "string") return undefined;
          const size = Buffer.byteLength(payload.delta, "utf8");
          preview.deltaBytes = (preview.deltaBytes ?? 0) + size;
          if (preview.deltaBytes > TRANSLATOR_MAX_CALL_ARGUMENT_BYTES) return undefined;
          if (bytes + size > TRANSLATOR_MAX_TURN_BYTES) throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
          options.budget?.chargeRetained(size, { kind: "retained_collectors" });
          bytes += size;
          preview.delta = (preview.delta ?? "") + payload.delta;
        }
        if (payload.type === "response.function_call_arguments.done") {
          if (preview.argumentsDone !== undefined || typeof payload.arguments !== "string") return undefined;
          preview.argumentsDone = payload.arguments;
        }
        previews.set(index, preview);
      }
      if (index !== undefined && result.fragments.has(index)) {
        const fragment = result.fragments.get(index)!;
        if (id !== fragment.id) return undefined;
        if (payload.type === "response.output_item.added" && !anonymousIdentity(item)) return undefined;
        if (payload.type === "response.output_item.done" && !anonymous(item)) return undefined;
        if (payload.type === "response.function_call_arguments.done" && payload.arguments !== fragment.argumentsText) return undefined;
        if (payload.type === "response.output_item.done") {
          if (!item || !completed(item) || item.arguments !== fragment.argumentsText || seen.has(index)) return undefined;
          seen.set(index, fragment.id);
        }
        continue;
      }
      if (id && ([...result.fragments.values()].some(fragment => fragment.id === id)
        || [...result.artifacts.values()].includes(id))) return undefined;
      if (id === root.id && index !== result.rootIndex) return undefined;
      let next: RecordValue = payload;
      if (index !== undefined) {
        const shifted = index - [...result.fragments.keys(), ...result.artifacts.keys()].filter(slot => slot < index).length;
        next = { ...next, output_index: shifted };
      }
      if (index === result.rootIndex && id === root.id) {
        if ((payload.type === "response.output_item.added" || payload.type === "response.output_item.done")
          && (!target(item) || item.call_id !== root.callId || item.name !== result.root.name)) return undefined;
        if (payload.type === "response.output_item.added" && item) next = { ...next, item: { ...item, arguments: "" } };
        if (payload.type === "response.output_item.done" && item) {
          if (!completed(item) || item.arguments !== result.root.arguments) return undefined;
          next = { ...next, item: { ...item, arguments: result.argumentsText } };
        }
        if (payload.type === "response.function_call_arguments.done") {
          if (payload.arguments !== result.root.arguments) return undefined;
          next = { ...next, arguments: result.argumentsText };
        }
        if (payload.type === "response.function_call_arguments.delta") {
          if (rootDelta) continue;
          rootDelta = true;
          next = { ...next, delta: result.argumentsText };
        }
      }
      if ((payload.type === "response.completed" || payload.type === "response.done") && isRecord(payload.response)) {
        next = { ...next, response: result.value };
      }
      if (next === payload) out.push(block);
      else {
        const rewritten = replaceSseDataPayload(block, JSON.stringify(next));
        const size = Buffer.byteLength(rewritten, "utf8");
        if (bytes + size > TRANSLATOR_MAX_TURN_BYTES) throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
        options.budget?.chargeRetained(size, { kind: "retained_collectors" });
        bytes += size;
        out.push(rewritten);
      }
    }
    const output = (result.value as RecordValue).output as unknown[];
    if (seen.size !== result.fragments.size || output[result.rootIndex] === undefined
      || result.root.id !== root.id || result.root.call_id !== root.callId) return undefined;
    for (const [index, expected] of [[result.rootIndex, result.root.arguments as string],
      ...[...result.fragments].map(([slot, fragment]) => [slot, fragment.argumentsText] as const)] as const) {
      const preview = previews.get(index);
      if (!preview || preview.added === undefined || (preview.added && !expected.startsWith(preview.added))
        || (preview.argumentsDone !== undefined && preview.argumentsDone !== expected)
        || (preview.delta !== undefined && preview.delta !== expected && (preview.added ?? "") + preview.delta !== expected)) return undefined;
    }
    return out;
  };
  const blockRewrite: SseBlockRewrite = block => {
    if (failed) return [];
    const data = sseDataPayload(block);
    const newline = block.includes("\r\n") ? "\r\n" : "\n";
    if (data === "[DONE]") return candidates.length ? refuse(newline) : [block];
    if (data === null) { if (candidates.length) { retain(block); return []; } return [block]; }
    let event: unknown;
    try { event = JSON.parse(data); } catch { if (candidates.length) return refuse(newline); return [block]; }
    if (!isRecord(event)) return candidates.length ? refuse(newline) : [block];
    if (event.type === "response.output_item.added" && authorizedTarget(event.item)
      && typeof event.item.id === "string" && typeof event.output_index === "number") {
      const item = event.item;
      if (candidates.length >= MAX_ITEMS || candidates.some(call => call.id === item.id || call.index === event.output_index)) return refuse(newline);
      candidates.push({ id: item.id as string, callId: item.call_id as string, index: event.output_index, state: "pending" });
    }
    if (candidates.length === 0 && event.type === "response.output_item.done" && authorizedTarget(event.item) && typeof event.item.arguments === "string") {
      try { JSON.parse(event.item.arguments); } catch { return refuse(newline); }
    }
    if (candidates.length === 0 && (event.type === "response.completed" || event.type === "response.done") && isRecord(event.response)
      && splitOutput(event.response, resolve) !== undefined) return refuse(newline);
    if (candidates.length === 0) return [block];
    retain(block);
    if (event.type === "response.output_item.done" && isRecord(event.item)) {
      const item = event.item;
      const call = candidates.find(candidate => candidate.id === item.id && candidate.index === event.output_index);
      if (call) {
        if (call.state !== "pending" || typeof item.arguments !== "string") return refuse(newline);
        try { JSON.parse(item.arguments); call.state = "complete"; }
        catch { call.state = "incomplete"; }
        if (candidates.filter(candidate => candidate.state === "incomplete").length > 1) return refuse(newline);
        if (candidates.every(candidate => candidate.state === "complete")) { candidates = []; return release(); }
      }
    }
    if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "response.cancelled") {
      release(); candidates = []; return [block];
    }
    if (event.type === "response.completed" || event.type === "response.done") {
      const incomplete = candidates.filter(candidate => candidate.state === "incomplete");
      const pending = candidates.filter(candidate => candidate.state === "pending");
      let pendingVerified = pending.length === 0;
      if (pending.length > 0 && isRecord(event.response) && completed(event.response) && Array.isArray(event.response.output)) {
        const output = event.response.output;
        const hasAnonymous = output.some(item => isRecord(item) && item.type === "function_call"
          && (item.name === "" || item.name === undefined) && (item.call_id === "" || item.call_id === undefined || item.call_id === null));
        const previews = new Map<number, { direct: number; added: number; total: number; seen: boolean; done: boolean; addedSeen: boolean }>();
        const coherent = buffered.every(block => {
          const data = sseDataPayload(block);
          if (data === null || data === "[DONE]") return true;
          let frame: unknown;
          try { frame = JSON.parse(data); } catch { return false; }
          if (!isRecord(frame)) return false;
          const item = isRecord(frame.item) ? frame.item : undefined;
          if (item?.type !== "function_call" && frame.type !== "response.function_call_arguments.delta"
            && frame.type !== "response.function_call_arguments.done") return true;
          const index = frame.output_index;
          if (incomplete.length > 0 && !pending.some(call => call.index === index)) {
            if (pending.some(call => call.id === frame.item_id || call.id === item?.id)
              || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return false;
            const other = output[index];
            if (!isRecord(other) || other.type !== "function_call" || typeof other.id !== "string"
              || (item && item.id !== other.id) || (typeof frame.item_id === "string" && frame.item_id !== other.id)) return false;
            return (frame.type !== "response.function_call_arguments.delta" && frame.type !== "response.function_call_arguments.done")
              || frame.item_id === other.id;
          }
          if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return false;
          const snapshot = output[index];
          if (!isRecord(snapshot) || snapshot.type !== "function_call" || typeof snapshot.id !== "string"
            || typeof snapshot.name !== "string" || !snapshot.name || typeof snapshot.call_id !== "string" || !snapshot.call_id
            || typeof snapshot.arguments !== "string") return false;
          if (typeof frame.item_id === "string" && frame.item_id !== snapshot.id) return false;
          if (item && (item.id !== snapshot.id || item.name !== snapshot.name
            || (item.namespace ?? "") !== (snapshot.namespace ?? "") || item.call_id !== snapshot.call_id)) return false;
          const preview = previews.get(index) ?? { direct: 0, added: 0, total: snapshot.arguments.length, seen: false, done: false, addedSeen: false };
          if (frame.type === "response.output_item.added" && item) {
            if (preview.addedSeen || preview.seen || (item.arguments !== undefined && typeof item.arguments !== "string")) return false;
            const added = typeof item.arguments === "string" ? item.arguments : "";
            if (!snapshot.arguments.startsWith(added)) return false;
            preview.added = added.length;
            preview.addedSeen = true;
          }
          if (frame.type === "response.output_item.done" && item
            && (!completed(item) || item.arguments !== snapshot.arguments)) return false;
          if (frame.type === "response.function_call_arguments.done") {
            if (frame.item_id !== snapshot.id || preview.done || frame.arguments !== snapshot.arguments) return false;
            preview.done = true;
          }
          if (frame.type === "response.function_call_arguments.delta") {
            if (frame.item_id !== snapshot.id || typeof frame.delta !== "string") return false;
            preview.direct = preview.direct >= 0 && snapshot.arguments.startsWith(frame.delta, preview.direct) ? preview.direct + frame.delta.length : -1;
            preview.added = preview.added >= 0 && snapshot.arguments.startsWith(frame.delta, preview.added) ? preview.added + frame.delta.length : -1;
            preview.seen = true;
            if (preview.direct < 0 && preview.added < 0) return false;
          }
          previews.set(index, preview);
          return true;
        });
        const completePreviews = [...previews.values()].every(preview =>
          !preview.seen || preview.direct === preview.total || preview.added === preview.total);
        pendingVerified = (incomplete.length > 0 || !hasAnonymous) && coherent && completePreviews && pending.every(call => {
          if (!Number.isSafeInteger(call.index) || call.index < 0) return false;
          const item = output[call.index];
          const schema = resolve("wait_agent");
          if (!schema || !target(item) || item.name !== "wait_agent" || item.id !== call.id || item.call_id !== call.callId
            || !completed(item) || typeof item.arguments !== "string"
            || output.filter(other => isRecord(other) && other.id === call.id).length !== 1
            || output.filter(other => isRecord(other) && other.call_id === call.callId).length !== 1) return false;
          try { return validWaitValue(JSON.parse(item.arguments), schema); } catch { return false; }
        });
      }
      if (incomplete.length === 0 && pending.length > 0 && pendingVerified) { candidates = []; return release(); }
      if (incomplete.length !== 1 || !pendingVerified || !isRecord(event.response)) return refuse(newline);
      const root = incomplete[0]!;
      const result = splitOutput(event.response, resolve);
      if (!result || result === "invalid" || result.rootIndex !== root.index) return refuse(newline);
      const projected = project(result, root);
      if (!projected) return refuse(newline);
      release(); candidates = [];
      return projected;
    }
    return [];
  };
  blockRewrite.flush = () => candidates.length ? refuse("\n") : release();
  blockRewrite.dispose = () => { release(); candidates = []; };
  return {
    blockRewrite,
    rewriteJson: text => {
      let response: unknown;
      try { response = JSON.parse(text); } catch { return text; }
      const result = splitOutput(response, resolve);
      if (result === "invalid") { options.onRefusal?.(); return undefined; }
      return result ? JSON.stringify(result.value) : text;
    },
    errorResponse: () => {
      const response = markProxyError(formatErrorResponse(502, "upstream_error", FAILURE_MESSAGE, { code: KIMI_PLAINTEXT_AGENT_ERROR_CODE, classified: true }));
      markResponseNonReplayable(response);
      applyReplayRefusalClientHeaders(response.headers);
      return response;
    },
  };
}

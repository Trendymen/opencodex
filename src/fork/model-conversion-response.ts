import { isSafeResponseHeader, normalizeSafeResponseHeader, type ResponseMetadataContext } from "../server/safe-response-headers";
import { CodexWsMetadata } from "../server/responses/codex-ws-metadata";
import { ANTHROPIC_ERROR_CODES, ANTHROPIC_ERROR_TYPES, OPENAI_ERROR_CODES, OPENAI_ERROR_TYPES } from "../lib/client-error-body";
import type { ConversionProtocol, ConversionTurn } from "./model-conversion-request";

export class ModelConversionResponseError extends Error {
  constructor() {
    super("Model response could not be restored safely");
    this.name = "ModelConversionResponseError";
  }
}

type RecordValue = Record<string, unknown>;
export type ModelConversionResponseContext = Pick<ResponseMetadataContext, "turnStateBinding"> & {
  coreClientMetadata?: Record<string, unknown>;
};

const MODEL_FIELDS = new Set(["model", "model_id", "modelId", "served_model", "requested_model"]);
const DIAGNOSTIC_CONTAINERS = new Set(["diagnostic", "diagnostics", "provider_metadata", "provider_diagnostics"]);
const MODEL_HEADERS = new Set(["openai-model", "x-codex-safety-buffering-faster-model"]);
const OPAQUE_IDENTIFIERS = new Set(["id", "item_id", "call_id", "previous_response_id", "response_id", "stream_id"]);
const RESPONSE_LIFECYCLE = new Set([
  "response.created", "response.in_progress", "response.completed", "response.done", "response.failed", "response.incomplete",
]);
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const REASONING_SUMMARIES = new Set(["auto", "concise", "detailed", "none"]);
const RETRY_FIELDS = new Set(["retry_after", "retry_after_ms", "retry_after_seconds", "reset_at", "resets_at"]);
const ERROR_IDENTIFIERS = new Set([
  ...OPENAI_ERROR_TYPES.keys(), ...OPENAI_ERROR_CODES.keys(), ...ANTHROPIC_ERROR_TYPES.keys(), ...ANTHROPIC_ERROR_CODES.keys(),
  "invalid_value", "unsupported_value", "missing_required_parameter", "invalid_image", "invalid_image_format",
  "content_policy_violation", "upstream_unavailable", "usage_not_included", "usage_limit_exceeded", "1308",
]);
const ERROR_PARAMETERS = new Set([
  "model", "input", "messages", "reasoning", "reasoning.effort", "reasoning.summary", "reasoning_effort",
  "max_tokens", "max_output_tokens", "previous_response_id", "temperature", "top_p", "stream", "tools",
  "tool_choice", "response_format", "text", "metadata", "store", "service_tier",
]);
const HTTP_HEADERS = new Set([
  "content-type", "cache-control", "vary", "access-control-allow-origin", "access-control-allow-credentials",
  "access-control-allow-methods", "access-control-allow-headers", "access-control-expose-headers",
  "x-request-id", "request-id", "openai-request-id", "x-client-request-id",
]);
const ENVELOPE_FIELDS = new Set([
  "id", "type", "object", "created", "created_at", "completed_at", "status", "role", "model", "model_id", "modelId",
  "served_model", "requested_model", "metadata", "diagnostic", "diagnostics", "provider_metadata", "provider_diagnostics",
  "system_fingerprint", "service_tier", "user", "usage", "output", "output_text", "choices", "content", "instructions",
  "input", "tools", "tool_choice", "stop_reason", "stop_sequence", "error", "last_error", "incomplete_details", "headers",
  "reasoning", "background", "parallel_tool_calls", "previous_response_id", "conversation", "prompt", "prompt_cache_key",
  "prompt_cache_retention", "max_output_tokens", "max_tool_calls", "temperature", "top_p", "top_logprobs", "truncation",
  "store", "safety_identifier", "include", "modalities", "text", "text_format", "text_config", "container", "context_management",
  "message", "sequence_number", "item", "item_id", "output_index", "content_index", "part", "delta", "summary_index",
  "summary", "annotation", "annotation_index", "obfuscation", "arguments", "result", "call_id", "refusal", "index", "code",
  "param", "response", "content_block", "safety_buffering", "partial_json", "partial_image_b64", "partial_image_index",
  "output_format", "size", "quality", "revised_prompt", "audio", "audio_index", "rate_limits", "credits", "plan_type", "logprobs",
  "metered_limit_name", "limit_name", "retry_after", "retry_after_ms", "retry_after_seconds", "reset_at", "resets_at",
  "response_id", "stream_id", "steer", "reason", "required_input",
]);
const HEADER_VALUE = /^[\t\x20-\x7e]{0,8192}$/;
const METADATA_NODE_LIMIT = 10_000;
const jsonNumbers = JSON as typeof JSON & {
  rawJSON?: (text: string) => unknown;
  isRawJSON?: (value: unknown) => boolean;
};

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rawNumber(value: unknown): string | undefined {
  if (!jsonNumbers.isRawJSON?.(value) || !record(value) || typeof value.rawJSON !== "string") return undefined;
  return value.rawJSON;
}

type Decimal = { negative: boolean; digits: string; exponent: number };

function decimal(source: string): Decimal | undefined {
  if (source.length > 256) return undefined;
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match || (match[4]?.replace(/^[+-]/, "").length ?? 0) > 6) return undefined;
  let digits = (match[2]! + (match[3] ?? "")).replace(/^0+/, "");
  if (!digits) return { negative: false, digits: "0", exponent: 0 };
  let exponent = Number(match[4] ?? "0") - (match[3]?.length ?? 0);
  while (digits.endsWith("0")) { digits = digits.slice(0, -1); exponent++; }
  return { negative: match[1] === "-", digits, exponent };
}

function equalNumbers(left: string, right: string): boolean {
  const a = decimal(left), b = decimal(right);
  return a !== undefined && b !== undefined && a.negative === b.negative
    && a.digits === b.digits && a.exponent === b.exponent;
}

function validQuotaNumber(value: unknown, maximum: number, integer: boolean): boolean {
  const raw = rawNumber(value);
  const source = raw ?? (typeof value === "number" && Number.isFinite(value) ? JSON.stringify(value) : undefined);
  const parsed = source === undefined ? undefined : decimal(source);
  if (!parsed || parsed.negative || integer && parsed.exponent < 0) return false;
  if (parsed.digits === "0") return true;
  const limit = String(maximum);
  const order = parsed.digits.length + parsed.exponent;
  if (order !== limit.length) return order < limit.length;
  const leading = parsed.digits.slice(0, limit.length).padEnd(limit.length, "0");
  return leading < limit || leading === limit && !/[1-9]/.test(parsed.digits.slice(limit.length));
}

export function modelConversionTokenCount(value: unknown): number | undefined {
  if (!validQuotaNumber(value, Number.MAX_SAFE_INTEGER, true)) return undefined;
  return Number(rawNumber(value) ?? value);
}

function targetIdentifier(value: string, turn: ConversionTurn): boolean {
  return targets(turn).some(target => target.toLowerCase() === value.toLowerCase());
}

function targets(turn: ConversionTurn): string[] {
  const selectors = [turn.targetModel, ...(turn.observedModels ?? [])];
  if (turn.priority && turn.targetModel.endsWith("--fast")) selectors.push(turn.targetModel.slice(0, -6));
  for (const selector of [...selectors]) {
    const slash = selector.indexOf("/");
    if (slash >= 0 && slash + 1 < selector.length) selectors.push(selector.slice(slash + 1));
  }
  return [...new Set(selectors.filter(Boolean))].sort((a, b) => b.length - a.length);
}

function observeModel(value: unknown, turn: ConversionTurn): void {
  if (typeof value !== "string" || !value || value.toLowerCase() === turn.clientModel.toLowerCase()) return;
  if (value.length > 128 || !turn.observedModels || (!turn.observedModels.has(value) && turn.observedModels.size >= 32)) {
    throw new ModelConversionResponseError();
  }
  turn.observedModels.add(value);
}

function observeEnvelope(value: unknown, turn: ConversionTurn): void {
  if (!record(value)) return;
  for (const key of MODEL_FIELDS) observeModel(value[key], turn);
  if (record(value.headers)) {
    for (const [key, entry] of Object.entries(value.headers)) {
      if (MODEL_HEADERS.has(key.toLowerCase())) observeModel(entry, turn);
    }
  }
  for (const key of ["diagnostic", "diagnostics", "provider_metadata", "provider_diagnostics", "error", "last_error", "safety_buffering"]) {
    const nested = value[key];
    if (!record(nested)) continue;
    for (const field of MODEL_FIELDS) observeModel(nested[field], turn);
    if (key === "safety_buffering") observeModel(nested.faster_model, turn);
  }
}

function replaceTarget(value: string, turn: ConversionTurn): string {
  const identifiers = [...targets(turn), turn.clientModel].filter(Boolean).sort((a, b) => b.length - a.length);
  const alternatives: string[] = [];
  for (const target of identifiers) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    alternatives.push(escaped);
  }
  if (alternatives.length === 0) return value;
  return value.replace(new RegExp(alternatives.join("|"), "gi"), match =>
    match.toLowerCase() === turn.clientModel.toLowerCase() ? match : turn.clientModel);
}

function errorParameter(value: string, turn: ConversionTurn): string | null {
  const folded = value.toLowerCase();
  const metadataPath = /^metadata(?:\.|\[)/i.test(value);
  const requestPath = /^request(?:\.|\[)/i.test(value);
  const modelPath = /(?:^|[.\[\]"'/])models?(?=$|[.\[\]"'/])/i.test(value);
  for (const target of targets(turn)) {
    if (target.toLowerCase() === turn.clientModel.toLowerCase() || !folded.includes(target.toLowerCase())) continue;
    if (/^[a-z]{1,7}$/i.test(target) && !modelPath) {
      const segment = new RegExp(`(?:^|[.\\[\\]"'/])${target}(?=$|[.\\[\\]"'/])`, "i");
      const requestField = folded.startsWith(`request.${target.toLowerCase()}.`);
      if (metadataPath || (requestPath && (!segment.test(value) || requestField))) continue;
    }
    return null;
  }
  return value;
}

function errorString(key: string, value: string, turn: ConversionTurn): string | null {
  if (key === "message") return "The model request failed.";
  if (key === "param") return ERROR_PARAMETERS.has(value) ? errorParameter(value, turn) : null;
  if (key === "type") return ERROR_IDENTIFIERS.has(value) && !targetIdentifier(value, turn) ? value : "server_error";
  if (key === "code") return ERROR_IDENTIFIERS.has(value) && !targetIdentifier(value, turn) ? value : null;
  return value;
}

function isoTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || Number(match[7] ?? 0) > 23 || Number(match[8] ?? 0) > 59) return false;
  const date = new Date(Date.UTC(year + 400, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year + 400 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
    && Number.isFinite(Date.parse(value));
}

function retryValue(key: string, value: unknown): unknown {
  if (value === null) return null;
  const raw = rawNumber(value);
  if (raw !== undefined) {
    const parsed = decimal(raw);
    return parsed && !parsed.negative && Number.isFinite(Number(raw)) ? value : undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || value.length > 128) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))) return value;
  if (key === "retry_after" && normalizeSafeResponseHeader("retry-after", value) !== undefined) return value;
  if (key === "reset_at" && isoTimestamp(value)) return value;
  return undefined;
}

function sameMetadata(left: unknown, right: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[left, right]];
  let visited = 0;
  while (pending.length) {
    if (++visited > METADATA_NODE_LIMIT) throw new ModelConversionResponseError();
    const [a, b] = pending.pop()!;
    const rawA = rawNumber(a);
    const rawB = rawNumber(b);
    if (rawA !== undefined || rawB !== undefined) {
      const left = rawA ?? (typeof a === "number" && Number.isFinite(a) ? JSON.stringify(a) : undefined);
      const right = rawB ?? (typeof b === "number" && Number.isFinite(b) ? JSON.stringify(b) : undefined);
      if (left !== undefined && right !== undefined && equalNumbers(left, right)) continue;
      return false;
    }
    if (a === b && (a === null || typeof a !== "object")) continue;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length || visited + aKeys.length > METADATA_NODE_LIMIT) {
      if (aKeys.length !== bKeys.length) return false;
      throw new ModelConversionResponseError();
    }
    for (const key of aKeys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([(a as RecordValue)[key], (b as RecordValue)[key]]);
    }
  }
  return true;
}

function userMetadata(value: unknown, turn: ConversionTurn, context?: ModelConversionResponseContext): unknown {
  if (value === null) return null;
  if (!record(value)) throw new ModelConversionResponseError();
  const output: RecordValue = {};
  const expected = turn.clientMetadata;
  const coreExpected = context?.coreClientMetadata;
  for (const [key, entry] of Object.entries(value)) {
    if (expected && Object.hasOwn(expected, key)
      && (sameMetadata(entry, expected[key]) || coreExpected && Object.hasOwn(coreExpected, key) && sameMetadata(entry, coreExpected[key]))) {
      Object.defineProperty(output, key, { value: coreExpected ? expected[key] : entry, enumerable: true, configurable: true, writable: true });
    }
  }
  return output;
}

function diagnostic(value: unknown, turn: ConversionTurn, safety = false): unknown {
  if (value === null) return null;
  if (!record(value)) throw new ModelConversionResponseError();
  const output: RecordValue = {};
  for (const [key, entry] of Object.entries(value)) {
    if (MODEL_FIELDS.has(key) || safety && key === "faster_model") {
      if (typeof entry === "string") output[key] = turn.clientModel;
      else if (entry === null) output[key] = null;
      else throw new ModelConversionResponseError();
    } else if (safety && key === "type" && entry === "safety_buffering") output.type = entry;
    else if (safety && key === "enabled" && typeof entry === "boolean") output.enabled = entry;
  }
  return output;
}

function errorObject(value: unknown, turn: ConversionTurn): unknown {
  if (value === null) return null;
  if (!record(value)) throw new ModelConversionResponseError();
  const output: RecordValue = {};
  for (const key of ["type", "code", "param", "message", "retry_after", "retry_after_ms", "retry_after_seconds", "reset_at", "resets_at"]) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = value[key];
    if (RETRY_FIELDS.has(key)) {
      const safe = retryValue(key, entry);
      if (safe !== undefined) output[key] = safe;
    } else if (typeof entry === "string") output[key] = errorString(key, entry, turn);
    else if (entry === null || typeof entry === "number" && Number.isFinite(entry) || rawNumber(entry) !== undefined) output[key] = entry;
  }
  for (const key of MODEL_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = value[key];
    if (typeof entry === "string") output[key] = turn.clientModel;
    else if (entry === null) output[key] = null;
    else throw new ModelConversionResponseError();
  }
  return output;
}

function reasoningObject(value: unknown): unknown {
  if (value === null) return null;
  if (!record(value)) throw new ModelConversionResponseError();
  const output: RecordValue = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "effort" && (entry === null || typeof entry === "string" && REASONING_EFFORTS.has(entry))) output[key] = entry;
    else if ((key === "summary" || key === "generate_summary")
      && (entry === null || typeof entry === "string" && REASONING_SUMMARIES.has(entry))) output[key] = entry;
    else if (key === "enabled" && typeof entry === "boolean") output[key] = entry;
  }
  return output;
}

function incompleteDetails(value: unknown, turn: ConversionTurn): unknown {
  if (value === null) return null;
  if (!record(value)) throw new ModelConversionResponseError();
  const output: RecordValue = {};
  if (typeof value.reason === "string") output.reason = replaceTarget(value.reason, turn);
  else if (value.reason === null) output.reason = null;
  return output;
}

function headerProjection(headers: Headers, turn: ConversionTurn, http: boolean, context?: ModelConversionResponseContext): Headers {
  const output = new Headers();
  for (const [name, value] of headers) if (MODEL_HEADERS.has(name.toLowerCase())) observeModel(value, turn);
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (MODEL_HEADERS.has(lower)) {
      output.set(lower, turn.clientModel);
      continue;
    }
    if (lower === "x-reasoning-included" && value === "") {
      output.set(lower, value);
      continue;
    }
    if (isSafeResponseHeader(lower)) {
      const normalized = normalizeSafeResponseHeader(lower, value, context);
      if (normalized !== undefined) output.set(lower, normalized);
      continue;
    }
    if (!http || !HTTP_HEADERS.has(lower) || !HEADER_VALUE.test(value)) continue;
    if (lower === "content-type" && !/^(?:application\/json|text\/event-stream|text\/plain)(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(value)) continue;
    if ((lower.endsWith("request-id") || lower === "request-id") && targetIdentifier(value, turn)) {
      throw new ModelConversionResponseError();
    }
    output.set(lower, value);
  }
  return output;
}

export function restoreModelHeaders(headers: Headers, turn: ConversionTurn, context?: ModelConversionResponseContext): Headers {
  try {
    return headerProjection(headers, turn, true, context);
  } catch {
    throw new ModelConversionResponseError();
  }
}

function metadataHeaders(value: unknown, turn: ConversionTurn, context?: ModelConversionResponseContext): RecordValue {
  if (!record(value)) throw new ModelConversionResponseError();
  const headers = new Headers();
  for (const [name, field] of Object.entries(value)) {
    if (!MODEL_HEADERS.has(name.toLowerCase()) && !isSafeResponseHeader(name)) continue;
    const numeric = rawNumber(field);
    if (numeric === undefined && typeof field !== "string" && typeof field !== "number" && typeof field !== "boolean") continue;
    try { headers.set(name, numeric ?? String(field)); } catch { /* malformed optional header is omitted */ }
  }
  return Object.fromEntries(headerProjection(headers, turn, false, context));
}

function assertItemIdentifiers(value: unknown, turn: ConversionTurn): void {
  if (!record(value)) return;
  for (const key of ["id", "call_id"]) {
    if (typeof value[key] === "string" && targetIdentifier(value[key], turn)) throw new ModelConversionResponseError();
  }
}

function nativeSteer(value: unknown, turn: ConversionTurn): RecordValue {
  if (!record(value)) throw new ModelConversionResponseError();
  const output: RecordValue = {};
  for (const key of ["id", "previous_response_id", "input"]) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = value[key];
    if (key !== "input" && (typeof entry !== "string" || targetIdentifier(entry, turn))) throw new ModelConversionResponseError();
    output[key] = entry;
  }
  return output;
}

function rateLimitsFrame(value: RecordValue): RecordValue {
  let sourceLimits: RecordValue | undefined;
  let event: RecordValue = value;
  if (record(value.rate_limits)) {
    sourceLimits = value.rate_limits;
    const limits: RecordValue = { ...sourceLimits };
    for (const name of ["primary", "secondary"]) {
      const original = sourceLimits[name];
      if (!record(original)) continue;
      const window: RecordValue = { ...original };
      for (const [field, maximum, integer] of [["used_percent", 100, false], ["window_minutes", 1e7, true], ["reset_at", 1e11, true]] as const) {
        if (!Object.hasOwn(original, field)) continue;
        const entry = original[field];
        if (!validQuotaNumber(entry, maximum, integer)) throw new ModelConversionResponseError();
        window[field] = Number(rawNumber(entry) ?? entry);
      }
      limits[name] = window;
    }
    event = { ...value, rate_limits: limits };
  }
  const safe = new CodexWsMetadata().consume(event, 0);
  if (!safe) throw new ModelConversionResponseError();
  const output = JSON.parse(safe) as RecordValue;
  if (sourceLimits && record(output.rate_limits)) {
    for (const name of ["primary", "secondary"]) {
      const original = sourceLimits[name], projected = output.rate_limits[name];
      if (!record(original) || !record(projected)) continue;
      for (const field of ["used_percent", "window_minutes", "reset_at"]) {
        if (Object.hasOwn(projected, field) && Object.hasOwn(original, field)) projected[field] = original[field];
      }
    }
  }
  const balance = record(value.credits) && typeof value.credits.balance === "string"
    ? normalizeSafeResponseHeader("x-codex-credits-balance", value.credits.balance) : undefined;
  if (balance !== undefined && record(output.credits)) output.credits.balance = balance;
  return output;
}

function envelope(value: RecordValue, turn: ConversionTurn, serviceMetadata: boolean, context?: ModelConversionResponseContext): RecordValue {
  const output: RecordValue = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!ENVELOPE_FIELDS.has(key)) continue;
    if (RETRY_FIELDS.has(key)) {
      const safe = retryValue(key, entry);
      if (safe !== undefined) output[key] = safe;
    } else if (MODEL_FIELDS.has(key)) {
      if (typeof entry === "string") output[key] = turn.clientModel;
      else if (entry === null) output[key] = null;
      else if (entry !== null) throw new ModelConversionResponseError();
    } else if (key === "system_fingerprint") continue;
    else if (key === "metadata") output[key] = serviceMetadata ? diagnostic(entry, turn, true) : userMetadata(entry, turn, context);
    else if (DIAGNOSTIC_CONTAINERS.has(key)) output[key] = diagnostic(entry, turn);
    else if (key === "safety_buffering") output[key] = typeof entry === "boolean" ? entry : diagnostic(entry, turn, true);
    else if (key === "error" || key === "last_error") output[key] = errorObject(entry, turn);
    else if (key === "reasoning") output[key] = reasoningObject(entry);
    else if (key === "incomplete_details") output[key] = incompleteDetails(entry, turn);
    else if (key === "headers") output[key] = metadataHeaders(entry, turn, context);
    else if (key === "steer") {
      if (typeof value.type === "string" && value.type.startsWith("response.steer.")) output[key] = nativeSteer(entry, turn);
    }
    else if (key === "required_input") {
      if (value.type === "response.steer.pending") {
        if (!Array.isArray(entry)) throw new ModelConversionResponseError();
        for (const item of entry) assertItemIdentifiers(item, turn);
        output[key] = entry;
      }
    }
    else if (key === "reason") {
      if (value.type === "response.steer.pending" && typeof entry === "string") output[key] = replaceTarget(entry, turn);
    }
    else if (OPAQUE_IDENTIFIERS.has(key) && typeof entry === "string" && targetIdentifier(entry, turn)) {
      throw new ModelConversionResponseError();
    }
    else if (key === "item") { assertItemIdentifiers(entry, turn); output[key] = entry; }
    else if (key === "output" && Array.isArray(entry)) {
      for (const item of entry) assertItemIdentifiers(item, turn);
      output[key] = entry;
    }
    else if ((key === "message" || key === "code" || key === "param") && typeof entry === "string" && typeof value.type === "string"
      && (value.type === "error" || value.type.endsWith(".failed"))) output[key] = errorString(key, entry, turn);
    else output[key] = entry;
  }
  return output;
}

export function restoreModelPayload(value: unknown, turn: ConversionTurn, protocol: ConversionProtocol, context?: ModelConversionResponseContext): unknown {
  try {
    if (!record(value)) throw new ModelConversionResponseError();
    observeEnvelope(value, turn);
    observeEnvelope(value.response, turn);
    if (protocol === "messages" && value.type === "message_start") observeEnvelope(value.message, turn);
    if (value.type === "response.metadata") observeEnvelope(value.metadata, turn);
    if (value.type === "codex.response.metadata") {
      return { type: value.type, headers: metadataHeaders(value.headers, turn, context) };
    }
    if (value.type === "codex.rate_limits") {
      return rateLimitsFrame(value);
    }
    const output = envelope(value, turn, value.type === "response.metadata", context);
    if (protocol === "responses" || protocol === "compact") {
      if (typeof value.type === "string" && RESPONSE_LIFECYCLE.has(value.type) && !record(output.response)) {
        throw new ModelConversionResponseError();
      }
      if (Object.hasOwn(output, "response")) {
        if (!record(output.response)) throw new ModelConversionResponseError();
        output.response = envelope(output.response, turn, false, context);
      }
    } else {
      delete output.response;
    }
    if (protocol === "messages" && value.type === "message_start") {
      if (!record(output.message)) throw new ModelConversionResponseError();
      output.message = envelope(output.message, turn, false, context);
    }
    return output;
  } catch {
    throw new ModelConversionResponseError();
  }
}

export function parseModelConversionJson(json: string): unknown {
  try {
    const parse = JSON.parse as (text: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;
    return parse(json, (_key, entry, context) => {
      if (typeof entry !== "number") return entry;
      const source = context?.source;
      if (typeof source !== "string") throw new ModelConversionResponseError();
      if (Number.isFinite(entry) && !Object.is(entry, -0) && JSON.stringify(entry) === source) return entry;
      if (!jsonNumbers.rawJSON) throw new ModelConversionResponseError();
      return jsonNumbers.rawJSON(source);
    });
  } catch {
    throw new ModelConversionResponseError();
  }
}

export function restoreModelJsonPayload(json: string, turn: ConversionTurn, protocol: ConversionProtocol, context?: ModelConversionResponseContext): string {
  if (json === "[DONE]") return json;
  try {
    return JSON.stringify(restoreModelPayload(parseModelConversionJson(json), turn, protocol, context));
  } catch {
    throw new ModelConversionResponseError();
  }
}

import { registerProviderResponseProvenance } from "../providers/request-pacing";
import { isCyberPolicyMessage, isRateLimitOrQuotaFailureMessage, isUpstreamPolicyRefusalMessage,
  recognizedUpstreamError, safetyRefusalCodeFromMessage } from "../lib/errors";
import { REDACTED_SECRET } from "../lib/redact";

export type CodexOverloadSafety = { unsafe: boolean };
export type CodexOverloadSource = {
  safety?: CodexOverloadSafety;
  retryAfter: string | null;
  signal: AbortSignal;
  maskCredential?: (text: string) => string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isStructuredCodexOverload(event: Record<string, unknown>): boolean {
  if (event.type !== "error" || (event.error !== undefined && !record(event.error))) return false;
  const error = record(event.error) ? event.error : {};
  if ((event.retryable !== undefined && event.retryable !== true)
    || (error.retryable !== undefined && error.retryable !== true)) return false;
  if ((event.code !== undefined && typeof event.code !== "string")
    || (error.code !== undefined && typeof error.code !== "string")) return false;
  if (error.type !== undefined && error.type !== "server_error" && error.type !== "overloaded_error") return false;
  for (const message of [event.message, error.message]) {
    if (message !== undefined && typeof message !== "string") return false;
    if (typeof message === "string" && (message.includes(REDACTED_SECRET)
      || isRateLimitOrQuotaFailureMessage(message) || isCyberPolicyMessage(message)
      || isUpstreamPolicyRefusalMessage(message) || safetyRefusalCodeFromMessage(message))) return false;
  }
  if (typeof event.code === "string" && typeof error.code === "string" && event.code !== error.code) return false;
  return recognizedUpstreamError({ code: event.code ?? error.code, type: error.type })?.httpStatus === 503;
}

const websocketSafety = new WeakMap<Response, CodexOverloadSafety>();
const overloadSources = new WeakMap<Response, CodexOverloadSource>();
const committedResponses = new WeakMap<Response, { source?: CodexOverloadSource }>();
registerProviderResponseProvenance(websocketSafety);
registerProviderResponseProvenance(overloadSources);
registerProviderResponseProvenance(committedResponses);

export function safeCodexOverloadMetadata(event: Record<string, unknown>): boolean {
  const allowed = event.type === "codex.response.metadata"
    ? ["type", "headers", "sequence_number"]
    : event.type === "codex.rate_limits"
      ? ["type", "plan_type", "metered_limit_name", "limit_name", "rate_limits", "credits", "sequence_number"]
      : undefined;
  if (!allowed) return false;
  if (Object.keys(event).some(key => !allowed.includes(key))) return false;
  if (event.sequence_number !== undefined && !(typeof event.sequence_number === "number"
    && Number.isSafeInteger(event.sequence_number) && event.sequence_number >= 0)) return false;
  if (event.type === "codex.response.metadata" && event.headers !== undefined) {
    if (!record(event.headers) || Object.values(event.headers).some(value =>
      typeof value !== "string" && typeof value !== "boolean"
      && !(typeof value === "number" && Number.isFinite(value)))) return false;
  }
  if (event.type === "codex.rate_limits") {
    if ([event.plan_type, event.metered_limit_name, event.limit_name].some(value =>
      value !== undefined && typeof value !== "string")) return false;
    if (event.rate_limits !== undefined) {
      if (!record(event.rate_limits) || Object.keys(event.rate_limits).some(key =>
        !["allowed", "limit_reached", "primary", "secondary"].includes(key))) return false;
      if ([event.rate_limits.allowed, event.rate_limits.limit_reached].some(value =>
        value !== undefined && typeof value !== "boolean")) return false;
      for (const key of ["primary", "secondary"]) {
        const window = event.rate_limits[key];
        if (window !== undefined && (!record(window) || Object.keys(window).some(field =>
          !["used_percent", "window_minutes", "reset_at"].includes(field))
          || Object.values(window).some(value => typeof value !== "number" || !Number.isFinite(value)))) return false;
      }
    }
    if (event.credits !== undefined) {
      if (!record(event.credits) || Object.keys(event.credits).some(key =>
        !["has_credits", "unlimited", "balance"].includes(key))) return false;
      if ([event.credits.has_credits, event.credits.unlimited].some(value =>
        value !== undefined && typeof value !== "boolean")) return false;
      if (event.credits.balance !== undefined && typeof event.credits.balance !== "string") return false;
    }
  }
  return true;
}

export function markCodexOverloadCommitted(response: Response, selected: { source?: CodexOverloadSource }): void {
  committedResponses.set(response, selected);
}

export function markCodexWebsocketSafety(response: Response, safety: CodexOverloadSafety): void {
  websocketSafety.set(response, safety);
}

export function codexWebsocketSafety(response: Response): CodexOverloadSafety | undefined {
  return websocketSafety.get(response);
}

export function markCodexOverloadSource(response: Response, source: CodexOverloadSource): void {
  overloadSources.set(response, source);
}

export function codexOverloadSource(response: Response): CodexOverloadSource | { source?: CodexOverloadSource } | undefined {
  return overloadSources.get(response) ?? committedResponses.get(response);
}

export function carryCodexOverloadSource(source: Response, target: Response): void {
  const metadata = overloadSources.get(source);
  if (metadata) overloadSources.set(target, metadata);
  const committed = committedResponses.get(source);
  if (committed) committedResponses.set(target, committed);
}

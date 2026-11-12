import type { RequestLogEntry } from "../server/request-log";
import { sanitizeLogMetadataString } from "../lib/redact";
import { normalizeRecordedClient } from "../usage/client";
import { errorDetailFor, projectErrorDetail } from "../usage/error-detail";
import { normalizePersistedJevDecision } from "../usage/jev-stats";
import { modelIdentityLogFields, normalizeClaudeCompatibilityUsageLog, normalizedAttempts } from "../usage/log";
import { readSessionEffortObservation } from "../usage/session-effort-observation";

function snapshotRequestLogEntry(entry: RequestLogEntry): RequestLogEntry {
  const source = entry as unknown as Record<PropertyKey, unknown>;
  const retained = {} as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(entry)) {
    if (key === "sessionEffortObservation" || !Object.prototype.propertyIsEnumerable.call(entry, key)) continue;
    if (key === "__proto__") Object.defineProperty(retained, key, { value: source[key], enumerable: true, writable: true, configurable: true });
    else retained[key] = source[key];
  }
  return retained as unknown as RequestLogEntry;
}

export function projectRequestLogEntry(entry: RequestLogEntry): RequestLogEntry {
  // Rows keep proxy-owned error facts only; upstream error text and tokens stop here (both the
  // retained ring row and the usage.jsonl projection below read the projected entry).
  const sessionEffortObservation = readSessionEffortObservation(entry);
  const attemptNormalizationDropped = entry.attemptNormalizationDropped === true, client = normalizeRecordedClient(entry.client) ?? "unknown";
  const clientDescriptor = Object.getOwnPropertyDescriptor(entry, "client");
  if ("sessionEffortObservation" in entry || !Object.isFrozen(entry) || !clientDescriptor?.enumerable || !("value" in clientDescriptor) || clientDescriptor.value !== client || Object.values(Object.getOwnPropertyDescriptors(entry)).some(descriptor => !("value" in descriptor))) {
    const detail = errorDetailFor(entry);
    entry = { ...snapshotRequestLogEntry(entry), ...detail, client, ...(attemptNormalizationDropped ? { attemptNormalizationDropped: true } : {}) };
  }
  entry = projectErrorDetail(entry);
  if (attemptNormalizationDropped && entry.attemptNormalizationDropped !== true) entry = { ...entry, attemptNormalizationDropped: true };
  // Sanitize ONCE, at the ingress, and use that one value for both destinations.
  //
  // `addFinalRequestLog` is not the only way in: `addRequestLog` is exported and callable
  // directly, and it retained the caller's entry verbatim in the in-memory ring while only the
  // field-by-field disk projection below saw a sanitized value. That split let `/api/logs`
  // serve a raw upstream-supplied marker — a newline in it can forge a record boundary in a
  // line-oriented viewer — while `usage.jsonl` looked clean, which is the worst shape for a
  // sanitization bug because the safe surface is the one you check.
  const shadowCallRewrittenFrom = sanitizeLogMetadataString(entry.shadowCallRewrittenFrom);
  const identity = modelIdentityLogFields(entry), servedModel = identity.servedModel;
  const claudeCompatibility = normalizeClaudeCompatibilityUsageLog(entry.claudeCompatibility);
  const jevDecision = normalizePersistedJevDecision(entry.jevDecision);
  const attempts = normalizedAttempts(entry.attempts);
  const attemptsDropped = Array.isArray(entry.attempts) && attempts.length < entry.attempts.length;
  const retained: RequestLogEntry = shadowCallRewrittenFrom === entry.shadowCallRewrittenFrom
    && servedModel === entry.servedModel && identity.resolvedModel === entry.resolvedModel
    && entry.claudeCompatibility === undefined
    && entry.jevDecision === undefined
    && !attemptsDropped
    ? entry
    : { ...entry, ...(entry.attemptNormalizationDropped === true || attemptsDropped ? { attemptNormalizationDropped: true } : {}),
      ...(shadowCallRewrittenFrom ? { shadowCallRewrittenFrom } : {}) };
  if (!shadowCallRewrittenFrom && retained !== entry) delete retained.shadowCallRewrittenFrom;
  if (retained !== entry) { if (!servedModel) delete retained.servedModel; if (!identity.resolvedModel) delete retained.resolvedModel; }
  if (claudeCompatibility) retained.claudeCompatibility = claudeCompatibility;
  else if (retained !== entry) delete retained.claudeCompatibility;
  if (jevDecision) retained.jevDecision = jevDecision;
  else if (retained !== entry) delete retained.jevDecision;
  if (sessionEffortObservation) retained.sessionEffortObservation = sessionEffortObservation;
  return retained;
}

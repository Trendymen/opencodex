import type { CodexPassthroughPermissions } from "./codex-passthrough-contract";

export type ClassifiedLocalFailure =
  | { kind: "reset-refusal"; reason: "reset" | "timeout"; sentAmbiguously: boolean }
  | { kind: "pacing" | "input-estimate" | "ordinary-cached-cooldown" }
  | { kind: "transport"; reason: "reset" | "timeout" | "connection" }
  | { kind: "protected"; reason: "real-upstream" | "agent-task-recovery" | "hard-budget" | "auth" | "identity" | "account-policy" };

export type CodexLocalErrorDecision =
  | { kind: "legacy" }
  | { kind: "bypass-optional" }
  | { kind: "gateway"; status: 502 | 504; addCodexExplanation: boolean; source: "local-transport" };

export function decideCodexLocalError(permissions: CodexPassthroughPermissions | undefined, failure: ClassifiedLocalFailure): CodexLocalErrorDecision {
  if (!permissions || failure.kind === "protected") return { kind: "legacy" };
  const policy = permissions.localErrorPolicies;
  if (failure.kind === "reset-refusal") {
    if (policy.resetReplayRefusal) return { kind: "legacy" };
    return { kind: "gateway", status: failure.reason === "timeout" ? 504 : 502, addCodexExplanation: policy.transportErrorMapping, source: "local-transport" };
  }
  if (failure.kind === "transport") {
    return policy.transportErrorMapping ? { kind: "legacy" }
      : { kind: "gateway", status: failure.reason === "timeout" ? 504 : 502, addCodexExplanation: false, source: "local-transport" };
  }
  const enabled = failure.kind === "pacing" ? policy.requestPacingAdmission
    : failure.kind === "input-estimate" ? policy.inputAdmissionPrecheck : policy.accountSoftPrecheck;
  return enabled ? { kind: "legacy" } : { kind: "bypass-optional" };
}

export function codexAccountSoftPrecheckOptions(permissions: CodexPassthroughPermissions | undefined) {
  return permissions?.localErrorPolicies.accountSoftPrecheck === false ? { skipOrdinaryCachedQuotaPrecheck: true } as const : undefined;
}

const localFailures = new WeakMap<Response, ClassifiedLocalFailure>();
const preDispatchFailures = new WeakSet<object>();

export function markCodexPreDispatchFailure(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) preDispatchFailures.add(error);
}

export function isCodexPreDispatchFailure(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function") && preDispatchFailures.has(error);
}

export function markCodexLocalFailure<T extends Response>(response: T, failure: ClassifiedLocalFailure): T {
  localFailures.set(response, failure); return response;
}

export function codexLocalFailure(response: Response): ClassifiedLocalFailure | undefined {
  return localFailures.get(response);
}

export function carryCodexLocalFailure<T extends Response>(source: Response, target: T): T {
  const failure = localFailures.get(source); if (failure) localFailures.set(target, failure); return target;
}

export function codexLocalGatewayResponse(decision: Extract<CodexLocalErrorDecision, { kind: "gateway" }>, failure: ClassifiedLocalFailure): Response {
  const message = decision.status === 504 ? "Gateway Timeout" : "Bad Gateway";
  const response = decision.addCodexExplanation
    ? Response.json({ error: { type: "upstream_error", code: decision.status === 504 ? "upstream_timeout" : "upstream_connection_error", message } }, { status: decision.status })
    : new Response(message, { status: decision.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  return markCodexLocalFailure(response, failure);
}

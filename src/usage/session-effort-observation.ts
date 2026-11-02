export type SafeEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SessionEffortObservation = {
  clientEffort: SafeEffort | "unknown";
  sessionEffort: SafeEffort | "unknown";
  status: "visible" | "not_in_input" | "unrecognized";
};

const efforts = new Set<unknown>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const effort = (value: unknown): SafeEffort | "unknown" =>
  efforts.has(value) ? value as SafeEffort : "unknown";

export function observeSessionEffort(body: unknown): SessionEffortObservation | undefined {
  if (!record(body)) return undefined;
  const clientEffort = effort(record(body.reasoning) ? body.reasoning.effort : undefined);
  let sessionEffort: SafeEffort | "unknown" = "unknown";
  let status: SessionEffortObservation["status"] | undefined;
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!record(item) || item.type !== "configuration_update") continue;
      sessionEffort = effort(record(item.reasoning) ? item.reasoning.effort : undefined);
      status = sessionEffort === "unknown" ? "unrecognized" : "visible";
    }
  }
  if (!status && typeof body.previous_response_id === "string" && body.previous_response_id.trim()) status = "not_in_input";
  return status ? { clientEffort, sessionEffort, status } : undefined;
}

export function normalizeSessionEffortObservation(value: unknown): SessionEffortObservation | undefined {
  try {
    if (!record(value)) return undefined;
    const { clientEffort, sessionEffort, status } = value;
    if (clientEffort !== "unknown" && !efforts.has(clientEffort)) return undefined;
    if (status === "visible") {
      if (!efforts.has(sessionEffort)) return undefined;
    } else if ((status !== "not_in_input" && status !== "unrecognized") || sessionEffort !== "unknown") {
      return undefined;
    }
    return { clientEffort: clientEffort as SafeEffort | "unknown", sessionEffort: sessionEffort as SafeEffort | "unknown", status };
  } catch { return undefined; }
}

export function readSessionEffortObservation(value: unknown): SessionEffortObservation | undefined {
  try {
    return record(value) ? normalizeSessionEffortObservation(value.sessionEffortObservation) : undefined;
  } catch { return undefined; }
}

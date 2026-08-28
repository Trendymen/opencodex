export type NestedExecRepairPlan = Readonly<{
  execWireName: "exec";
  repairFunctionsExec: boolean;
  repairWebRun: boolean;
}>;

export type NestedExecRepairResult = Readonly<{
  value: unknown;
  outcome: "unchanged" | "repaired" | "rejected";
}>;

export type NestedExecCallRepairResult = Readonly<{
  name: string;
  arguments: string;
  outcome: "unchanged" | "repaired" | "rejected";
}>;

export type CurrentTurnExecDeclaration = Readonly<{
  kind: "custom" | "function";
}>;

export const NESTED_EXEC_MAX_ARGUMENT_BYTES = 64 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseToolSpecs(body: unknown): unknown[] {
  if (!isPlainObject(body)) return [];
  const specs: unknown[] = [];
  if (Array.isArray(body.tools)) specs.push(...body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
        specs.push(...item.tools);
      }
    }
  }
  return specs;
}

function specConflictsWithExec(spec: unknown): boolean {
  if (!isPlainObject(spec)) return false;
  if (spec.type === "namespace" && Array.isArray(spec.tools)) {
    return spec.name === "exec"
      || spec.tools.some(child => isPlainObject(child) && child.name === "exec");
  }
  return spec.name === "exec";
}

export function findUniqueCurrentTurnExecDeclaration(body: unknown): CurrentTurnExecDeclaration | undefined {
  const specs = responseToolSpecs(body);
  const candidates = specs.filter(spec =>
    isPlainObject(spec)
    && (spec.type === "custom" || spec.type === "function")
    && spec.name === "exec"
  ) as Array<Record<string, unknown>>;
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0]!;
  if (specs.some(spec => spec !== candidate && specConflictsWithExec(spec))) return undefined;
  return {
    kind: candidate.type as "custom" | "function",
  };
}

function specCarriesNestedExecSurface(spec: unknown): boolean {
  if (!isPlainObject(spec)) return false;
  if ((spec.type === "custom" || spec.type === "function") && spec.name === "exec") return true;
  return spec.type === "namespace"
    && Array.isArray(spec.tools)
    && spec.tools.some(specCarriesNestedExecSurface);
}

export function hasCurrentTurnNestedExecSurface(body: unknown): boolean {
  return responseToolSpecs(body).some(specCarriesNestedExecSurface);
}

export function buildNestedExecRepairPlan(args: {
  execWasLowered?: boolean;
  execIsDeclaredOnWire?: boolean;
  directlyDeclaredWireNames: ReadonlySet<string>;
}): NestedExecRepairPlan | undefined {
  if (!(args.execWasLowered || args.execIsDeclaredOnWire)) return undefined;
  const repairFunctionsExec = !args.directlyDeclaredWireNames.has("functions.exec")
    && !args.directlyDeclaredWireNames.has("functions__exec");
  const repairWebRun = !args.directlyDeclaredWireNames.has("web__run");
  if (!repairFunctionsExec && !repairWebRun) return undefined;
  return { execWireName: "exec", repairFunctionsExec, repairWebRun };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function normalizedWebRunArguments(argumentsText: unknown): string | undefined {
  if (typeof argumentsText !== "string") return undefined;
  if (Buffer.byteLength(argumentsText, "utf8") > NESTED_EXEC_MAX_ARGUMENT_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const keys = Object.keys(parsed);
  if (keys.length === 1 && keys[0] === "input") {
    return typeof parsed.input === "string" ? JSON.stringify({ input: parsed.input }) : undefined;
  }
  const input = `const result = await tools.web__run(${canonicalJson(parsed)});\n`
    + "text(JSON.stringify(result, null, 2));";
  return JSON.stringify({ input });
}

export function normalizeNestedExecCall(
  name: string,
  argumentsText: string,
  plan: NestedExecRepairPlan,
): NestedExecCallRepairResult {
  if (name === "functions.exec" && plan.repairFunctionsExec) {
    if (Buffer.byteLength(argumentsText, "utf8") > NESTED_EXEC_MAX_ARGUMENT_BYTES) {
      return { name, arguments: argumentsText, outcome: "rejected" };
    }
    return { name: plan.execWireName, arguments: argumentsText, outcome: "repaired" };
  }
  if (name === "web__run" && plan.repairWebRun) {
    const normalized = normalizedWebRunArguments(argumentsText);
    if (normalized === undefined) return { name, arguments: argumentsText, outcome: "rejected" };
    return { name: plan.execWireName, arguments: normalized, outcome: "repaired" };
  }
  return { name, arguments: argumentsText, outcome: "unchanged" };
}

function repairFunctionCall(
  item: Record<string, unknown>,
  plan: NestedExecRepairPlan,
): NestedExecRepairResult | undefined {
  if (item.type !== "function_call" || typeof item.name !== "string") return undefined;
  if (typeof item.arguments !== "string") {
    return (item.name === "functions.exec" && plan.repairFunctionsExec)
      || (item.name === "web__run" && plan.repairWebRun)
      ? { value: item, outcome: "rejected" }
      : undefined;
  }
  const normalized = normalizeNestedExecCall(item.name, item.arguments, plan);
  if (normalized.outcome === "unchanged") return undefined;
  if (normalized.outcome === "rejected") return { value: item, outcome: "rejected" };
  return {
    value: { ...item, name: normalized.name, arguments: normalized.arguments },
    outcome: "repaired",
  };
}

function repairValue(value: unknown, plan: NestedExecRepairPlan): NestedExecRepairResult {
  if (Array.isArray(value)) {
    let changed = false;
    const repaired: unknown[] = [];
    for (const entry of value) {
      const result = repairValue(entry, plan);
      if (result.outcome === "rejected") return { value, outcome: "rejected" };
      changed ||= result.outcome === "repaired";
      repaired.push(result.value);
    }
    return changed ? { value: repaired, outcome: "repaired" } : { value, outcome: "unchanged" };
  }
  if (!isPlainObject(value)) return { value, outcome: "unchanged" };

  const direct = repairFunctionCall(value, plan);
  if (direct !== undefined) return direct;

  let changed = false;
  const repaired: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = repairValue(entry, plan);
    if (result.outcome === "rejected") return { value, outcome: "rejected" };
    changed ||= result.outcome === "repaired";
    repaired[key] = result.value;
  }
  return changed ? { value: repaired, outcome: "repaired" } : { value, outcome: "unchanged" };
}

export function repairNestedExecCallsInPayload(
  value: unknown,
  plan: NestedExecRepairPlan,
): NestedExecRepairResult {
  return repairValue(value, plan);
}

export function repairNestedExecCallsInJson(
  text: string,
  plan: NestedExecRepairPlan,
): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  const repaired = repairNestedExecCallsInPayload(value, plan);
  return repaired.outcome === "repaired" ? JSON.stringify(repaired.value) : text;
}

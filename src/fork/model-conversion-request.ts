import { effortForThinkingBudget } from "../claude/inbound-model-options";
import { stripOneMillionMarker } from "../claude/context-windows";
import { codexAccountNamespaceForModel, codexProviderNamespaceKey } from "../codex/account-namespace-match";
import { codexEffortRank, isDeclaredReasoningEffort, mapReasoningEffort } from "../reasoning-effort";
import { parseFastOnlyRowId, parseSyntheticRowId } from "../server/fast-row";
import type { OcxConfig } from "../types";
import type { ModelConversionRule } from "./model-conversion-config";

export type ConversionProtocol = "responses" | "chat" | "messages" | "compact";
export type ConversionTurn = Readonly<{
  clientModel: string;
  targetModel: string;
  maxEffort: string;
  observedModels?: Set<string>;
  priority?: true;
  clientMetadata?: Record<string, unknown>;
}>;

export class ModelConversionRequestError extends Error {
  constructor() {
    super("Invalid model conversion request");
    this.name = "ModelConversionRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matchesGlob(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let retry = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
      p++;
      v++;
    } else if (pattern[p] === "*") {
      star = p++;
      retry = v;
    } else if (star >= 0) {
      p = star + 1;
      v = ++retry;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

function modelPart(selector: string, identity: Pick<OcxConfig, "providers" | "codexAccountNamespaces">): string | undefined {
  if (selector.length === 0 || selector.length > 128 || !/^[A-Za-z0-9._:/@\-]+$/.test(selector)) return undefined;
  const slash = selector.indexOf("/");
  if (slash < 0) return selector;
  const namespace = selector.slice(0, slash);
  const providers = identity.providers ?? {};
  const recognizedProvider = Object.keys(providers).some(name => codexProviderNamespaceKey(name) === codexProviderNamespaceKey(namespace));
  if (!recognizedProvider && !codexAccountNamespaceForModel(identity.codexAccountNamespaces, selector)) return undefined;
  return selector.slice(slash + 1) || undefined;
}

function matchingRule(selector: string, rules: readonly ModelConversionRule[], identity: OcxConfig): ModelConversionRule | undefined {
  const part = modelPart(selector, identity);
  return part === undefined ? undefined : rules.find(candidate =>
    matchesGlob(candidate.match, part) && !candidate.exclude?.some(pattern => matchesGlob(pattern, part)));
}

function effortRank(effort: string): number {
  if (effort === "none") return -2;
  if (effort === "minimal") return -1;
  return codexEffortRank(effort);
}

function cappedEffort(value: unknown, maxEffort: string): string {
  if (!isDeclaredReasoningEffort(maxEffort)) throw new ModelConversionRequestError();
  if (value === undefined || value === null) return maxEffort;
  if (typeof value !== "string" || !isDeclaredReasoningEffort(value)) throw new ModelConversionRequestError();
  return effortRank(value) > effortRank(maxEffort) ? maxEffort : value;
}

function cappedReasoning(value: unknown, maxEffort: string, ensureEffort: boolean): unknown {
  if (value === undefined || value === null) return ensureEffort ? { effort: maxEffort } : value;
  if (!isRecord(value)) throw new ModelConversionRequestError();
  if (!ensureEffort && !Object.hasOwn(value, "effort")) return value;
  const effort = cappedEffort(value.effort, maxEffort);
  return value.effort === effort ? value : { ...value, effort };
}

function capConfigurationUpdates(value: unknown, maxEffort: string): unknown {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const output = value.map(item => {
    if (!isRecord(item) || item.type !== "configuration_update" || !Object.hasOwn(item, "reasoning")) return item;
    const reasoning = cappedReasoning(item.reasoning, maxEffort, false);
    if (reasoning === item.reasoning) return item;
    changed = true;
    return { ...item, reasoning };
  });
  return changed ? output : value;
}

function capMessages(output: Record<string, unknown>, maxEffort: string, rowEffort?: string): void {
  const rawConfig = output.output_config;
  if (rawConfig !== undefined && rawConfig !== null && !isRecord(rawConfig)) throw new ModelConversionRequestError();
  const config = isRecord(rawConfig) ? rawConfig : {};
  const thinking = output.thinking;
  const disabled = isRecord(thinking) && thinking.type === "disabled";
  const budget = isRecord(thinking) && thinking.type === "enabled" && typeof thinking.budget_tokens === "number"
    ? effortForThinkingBudget(thinking.budget_tokens) : undefined;
  const effort = cappedEffort(rowEffort ?? config.effort ?? (disabled ? "none" : budget), maxEffort);
  if (effort === "none" && (!disabled || rowEffort !== undefined)) output.thinking = { type: "disabled" };
  else if (rowEffort !== undefined && effort !== "none") delete output.thinking;
  if (rowEffort !== undefined || !disabled || Object.hasOwn(config, "effort")) {
    // Normalize the protocol vocabulary without applying destination-specific effort policies.
    const wireEffort = mapReasoningEffort({ adapter: "", baseUrl: "" }, "", effort);
    if (wireEffort !== undefined) output.output_config = { ...config, effort: wireEffort };
    else if (Object.hasOwn(config, "effort")) {
      const remainingConfig = { ...config };
      delete remainingConfig.effort;
      if (Object.keys(remainingConfig).length > 0) output.output_config = remainingConfig;
      else delete output.output_config;
    }
  }
}

export function convertModelRequest(
  value: unknown,
  rules: readonly ModelConversionRule[],
  identity: OcxConfig,
  inherited?: ConversionTurn,
  protocol: ConversionProtocol = "responses",
): { value: unknown; turn?: ConversionTurn; changed: boolean } {
  if (!isRecord(value)) return { value, changed: false };
  const explicitModel = Object.hasOwn(value, "model");
  if (explicitModel && typeof value.model !== "string") {
    if (inherited) throw new ModelConversionRequestError();
    return { value, changed: false };
  }

  let turn: ConversionTurn | undefined;
  let rowEffort: string | undefined;
  const control = value.type === "response.inject" || value.type === "response.steer";
  if (inherited && (control || !explicitModel)) {
    if (explicitModel && value.model !== inherited.clientModel && value.model !== inherited.targetModel) {
      throw new ModelConversionRequestError();
    }
    turn = inherited;
  } else if (typeof value.model === "string") {
    const sourceModel = protocol === "messages" ? stripOneMillionMarker(value.model) : value.model;
    if (rules.length === 0) return { value, changed: false };
    const rows = protocol === "compact"
      ? { fastRow: parseFastOnlyRowId(identity, () => sourceModel), effortRow: null }
      : parseSyntheticRowId(sourceModel, identity);
    const row = rows.effortRow ?? rows.fastRow;
    const rule = matchingRule(row?.baseId ?? sourceModel, rules, identity);
    if (!rule) return { value, changed: false };
    rowEffort = rows.effortRow?.effort;
    let targetModel = rule.model;
    if (protocol === "messages" && rows.fastRow) {
      const targetRow = parseSyntheticRowId(targetModel, identity).fastRow;
      if (!targetRow) {
        const candidate = `${targetModel}--fast`;
        if (candidate.length > 128 || parseSyntheticRowId(candidate, identity).fastRow?.baseId !== targetModel) {
          throw new ModelConversionRequestError();
        }
        targetModel = candidate;
      }
    }
    turn = {
      clientModel: value.model,
      targetModel,
      maxEffort: rule.maxEffort,
      observedModels: new Set(),
      ...(rows.fastRow ? { priority: true as const } : {}),
      ...(isRecord(value.metadata) ? { clientMetadata: structuredClone(value.metadata) } : {}),
    };
  }
  if (!turn) return { value, changed: false };

  const output: Record<string, unknown> = { ...value };
  const forcedEffort = rowEffort === undefined ? undefined : cappedEffort(rowEffort, turn.maxEffort);
  if (explicitModel || value.type === "response.create") output.model = turn.targetModel;
  if (turn.priority && protocol !== "messages" && !control) output.service_tier = "priority";
  if (protocol === "messages" && !control) capMessages(output, turn.maxEffort, forcedEffort);
  if (protocol === "chat" && !control) output.reasoning_effort = forcedEffort ?? cappedEffort(value.reasoning_effort, turn.maxEffort);
  if (Object.hasOwn(value, "reasoning_effort") && (protocol !== "chat" || control)) {
    output.reasoning_effort = forcedEffort ?? cappedEffort(value.reasoning_effort, turn.maxEffort);
  }
  const ensureReasoning = !control && (protocol === "responses" || protocol === "compact");
  if (ensureReasoning || Object.hasOwn(value, "reasoning")) {
    output.reasoning = forcedEffort === undefined
      ? cappedReasoning(value.reasoning, turn.maxEffort, ensureReasoning)
      : { ...(isRecord(value.reasoning) ? value.reasoning : {}), effort: forcedEffort };
  }
  if (Object.hasOwn(value, "input")) output.input = capConfigurationUpdates(value.input, turn.maxEffort);
  const changed = Object.keys(output).some(key => output[key] !== value[key]) || Object.keys(output).length !== Object.keys(value).length;
  return { value: changed ? output : value, turn, changed };
}

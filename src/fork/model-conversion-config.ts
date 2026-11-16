import * as z from "zod/v4";
import { isDeclaredReasoningEffort } from "../reasoning-effort";

export type ModelConversionRule = Readonly<{
  match: string;
  exclude?: readonly string[];
  model: string;
  maxEffort: string;
}>;

const patternSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:/@?*\-]+$/);
const modelSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:/@\-]+$/);
const ruleSchema = z.object({
  match: patternSchema,
  exclude: z.array(patternSchema).max(32).optional(),
  model: modelSchema,
  maxEffort: z.string().refine(isDeclaredReasoningEffort),
}).strict();
const policySchema = z.object({
  enabled: z.boolean(),
  rules: z.array(ruleSchema).max(128).optional(),
}).strict();

const defaultRules = [{
  match: "gpt-*",
  exclude: ["*luna*"],
  model: "gpt-6.1-terra",
  maxEffort: "medium",
}];

export class ModelConversionConfigurationError extends Error {
  constructor() {
    super("Invalid API key model conversion configuration");
    this.name = "ModelConversionConfigurationError";
  }
}

class ConversionSnapshot implements ReadonlyMap<string, readonly ModelConversionRule[]> {
  readonly #rules: Map<string, readonly ModelConversionRule[]>;

  constructor(rules: Map<string, readonly ModelConversionRule[]>) {
    this.#rules = rules;
    Object.freeze(this);
  }

  get size(): number { return this.#rules.size; }
  get(key: string): readonly ModelConversionRule[] | undefined { return this.#rules.get(key); }
  has(key: string): boolean { return this.#rules.has(key); }
  entries() { return this.#rules.entries(); }
  keys() { return this.#rules.keys(); }
  values() { return this.#rules.values(); }
  [Symbol.iterator]() { return this.entries(); }
  forEach(callback: (value: readonly ModelConversionRule[], key: string, map: ReadonlyMap<string, readonly ModelConversionRule[]>) => void, thisArg?: unknown): void {
    this.#rules.forEach((value, key) => callback.call(thisArg, value, key, this));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function compileModelConversions(apiKeys: readonly unknown[]): ReadonlyMap<string, readonly ModelConversionRule[]> {
  const counts = new Map<string, number>();
  for (const value of apiKeys) {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id) continue;
    counts.set(value.id, (counts.get(value.id) ?? 0) + 1);
  }

  const snapshot = new Map<string, readonly ModelConversionRule[]>();
  for (const value of apiKeys) {
    if (!isRecord(value) || !Object.hasOwn(value, "modelConversion")) continue;
    const policy = policySchema.safeParse(value.modelConversion);
    if (!policy.success || typeof value.id !== "string" || !value.id || value.id.length > 256 || counts.get(value.id) !== 1) {
      throw new ModelConversionConfigurationError();
    }
    if (!policy.data.enabled) continue;
    const rules = (policy.data.rules ?? defaultRules).map(rule => Object.freeze({
      match: rule.match,
      ...(rule.exclude !== undefined ? { exclude: Object.freeze([...rule.exclude]) } : {}),
      model: rule.model,
      maxEffort: rule.maxEffort,
    }));
    snapshot.set(value.id, Object.freeze(rules));
  }
  return new ConversionSnapshot(snapshot);
}

import { createHash } from "node:crypto";
import { isTranslatorBudgetExceededError } from "../lib/translator-budget";
import { RETAINED_PREFIX, RETAINED_SUFFIX, reasoningTextOf } from "../responses/reasoning-retention";
import type { OcxReasoningReplayScopeRef } from "../types";

type Rec = Record<string, unknown>;

const MAX_SCOPES = 64;
const MAX_ITEMS_PER_SCOPE = 256;
const TTL_MS = 60 * 60 * 1000;

interface NativeScope {
  identity: string;
  at: number;
  items: Set<string>;
}

const nativeReasoning = new Map<string, NativeScope>();

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopeIdentity(scope: OcxReasoningReplayScopeRef | undefined): { key: string; identity: string } | undefined {
  const current = scope?.current;
  if (!scope?.clientThreadId || !current?.providerDestinationDurableIdentity || !current.credentialDurableIdentity) return undefined;
  return {
    key: JSON.stringify([scope.clientPrincipalId ?? null, scope.clientThreadId]),
    identity: JSON.stringify([
      current.providerName,
      current.providerDestinationDurableIdentity,
      current.adapterName,
      current.modelId,
      current.credentialDurableIdentity,
    ]),
  };
}

function itemKeys(item: Rec): string[] {
  return [
    ["encrypted_content", item.encrypted_content],
    ["id", item.id],
  ].flatMap(([name, value]) => typeof value === "string" && value.length > 0
    ? [createHash("sha256").update(name + "\0" + value).digest("hex")]
    : []);
}

function nativeScope(scope: OcxReasoningReplayScopeRef | undefined, at: number): { entry: NativeScope; key: string; identity: string } | undefined {
  const bound = scopeIdentity(scope);
  if (!bound) return undefined;
  const entry = nativeReasoning.get(bound.key);
  if (entry && at - entry.at >= TTL_MS) {
    nativeReasoning.delete(bound.key);
    return undefined;
  }
  if (entry && entry.identity !== bound.identity) {
    nativeReasoning.delete(bound.key);
    return undefined;
  }
  return { entry: entry ?? { identity: bound.identity, at, items: new Set() }, key: bound.key, identity: bound.identity };
}

export function rememberKimiNativeReasoning(output: unknown, scope: OcxReasoningReplayScopeRef | undefined): void {
  if (!Array.isArray(output)) return;
  const keys = output.flatMap(item => isRec(item) && item.type === "reasoning" ? itemKeys(item) : []);
  if (keys.length === 0) return;
  const bound = scopeIdentity(scope);
  if (!bound) return;
  const at = Date.now();
  const current = nativeScope(scope, at);
  const entry: NativeScope = current?.entry ?? { identity: bound.identity, at, items: new Set() };
  entry.at = at;
  for (const key of keys) {
    entry.items.delete(key);
    entry.items.add(key);
    while (entry.items.size > MAX_ITEMS_PER_SCOPE) entry.items.delete(entry.items.values().next().value!);
  }
  nativeReasoning.delete(bound.key);
  nativeReasoning.set(bound.key, entry);
  while (nativeReasoning.size > MAX_SCOPES) nativeReasoning.delete(nativeReasoning.keys().next().value!);
}

function isCurrentKimiNative(item: Rec, scope: OcxReasoningReplayScopeRef | undefined): boolean {
  const bound = nativeScope(scope, Date.now());
  return bound?.entry !== undefined && itemKeys(item).some(key => bound.entry.items.has(key));
}

function readableText(item: Rec): string {
  try {
    return reasoningTextOf(item);
  } catch (error) {
    if (isTranslatorBudgetExceededError(error)) return "";
    throw error;
  }
}

/** Project foreign reasoning into readable history only when the destination cannot consume its native state. */
export function projectForeignKimiReasoning(body: unknown, scope?: OcxReasoningReplayScopeRef): unknown {
  if (!isRec(body) || !Array.isArray(body.input)) return body;
  if (!scope?.current) return body;
  let changed = false;
  const input: unknown[] = [];
  for (const item of body.input) {
    if (!isRec(item) || item.type !== "reasoning") {
      input.push(item);
      continue;
    }
    if (isCurrentKimiNative(item, scope)) {
      input.push(item);
      continue;
    }
    const text = readableText(item);
    changed = true;
    if (text.length > 0) {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${RETAINED_PREFIX}${text}${RETAINED_SUFFIX}` }],
      });
    }
  }
  return changed ? { ...body, input } : body;
}

import { createHash } from "node:crypto";
import { isTranslatorBudgetExceededError } from "../lib/translator-budget";
import { RETAINED_PREFIX, RETAINED_SUFFIX, reasoningTextOf } from "../responses/reasoning-retention";
import { durableReplayDestinationIdentity } from "../responses/reasoning-replay-cache";
import { currentRequestIsPrimaryLoopback } from "../lib/request-peer-scope";
import { connectionReplayScopeForThread, connectionReplayScopeOwnerKey, type ConnectionReplayScope } from "../responses/state/connection-scope";
import type { HandleResponsesOptions } from "../server/responses/core-options";
import type { OcxReasoningReplayScopeRef } from "../types";

type Rec = Record<string, unknown>;

const MAX_SCOPES = 64;
const MAX_ITEMS_PER_SCOPE = 256;
const TTL_MS = 60 * 60 * 1000;

interface NativeScope {
  at: number;
  items: Map<string, NativeItem>;
}

interface NativeItem {
  id?: string;
  ciphertext?: string;
}

const nativeReasoning = new Map<string, NativeScope>();
type LocalAuthority = { kind: "http" } | { kind: "websocket"; scope: ConnectionReplayScope; thread: string; key: string };
const localAuthorities = new WeakMap<OcxReasoningReplayScopeRef, LocalAuthority>();

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasPrincipal(scope: OcxReasoningReplayScopeRef | undefined): boolean {
  return typeof scope?.clientPrincipalId === "string" && scope.clientPrincipalId.trim().length > 0;
}

export function bindKimiLocalReplayScope(
  scope: OcxReasoningReplayScopeRef | undefined,
  options: Pick<HandleResponsesOptions, "admission" | "inboundTransport" | "replayScope">,
  ownThread: string | undefined,
): void {
  if (!scope) return;
  localAuthorities.delete(scope);
  if (hasPrincipal(scope) || options.admission?.kind !== "loopback" || !currentRequestIsPrimaryLoopback()) return;
  if (options.inboundTransport !== "websocket") {
    localAuthorities.set(scope, { kind: "http" });
    return;
  }
  const connection = connectionReplayScopeForThread(options.replayScope, ownThread);
  const key = connectionReplayScopeOwnerKey(connection);
  if (connection && key && ownThread) localAuthorities.set(scope, { kind: "websocket", scope: connection, thread: ownThread, key });
}

function callerNamespace(scope: OcxReasoningReplayScopeRef | undefined): string | undefined {
  if (hasPrincipal(scope)) return JSON.stringify(["principal", scope!.clientPrincipalId]);
  const authority = scope && localAuthorities.get(scope);
  if (authority?.kind === "http") return JSON.stringify(["local", "http"]);
  if (authority?.kind === "websocket" && connectionReplayScopeForThread(authority.scope, authority.thread)) {
    return JSON.stringify(["local", "websocket", authority.key]);
  }
  return undefined;
}

function scopeIdentity(scope: OcxReasoningReplayScopeRef | undefined): string | undefined {
  const current = scope?.current;
  const owner = scope?.nativeReasoningOwner;
  const fields = [callerNamespace(scope), scope?.clientThreadId, current?.providerName,
    current?.providerDestinationIdentity, current?.providerDestinationDurableIdentity,
    current?.adapterName, current?.modelId, current?.credentialIdentity,
    current?.credentialDurableIdentity, owner?.destination, owner?.credential, scope?.nativeReasoningEndpoint];
  return fields.every(value => typeof value === "string" && value.trim().length > 0)
    ? JSON.stringify(fields) : undefined;
}

export function kimiReplayScopeForEndpoint(
  scope: OcxReasoningReplayScopeRef | undefined,
  url: string,
): OcxReasoningReplayScopeRef | undefined {
  if (!scope) return undefined;
  const snapshot: OcxReasoningReplayScopeRef = {
    ...scope,
    ...(scope.current ? { current: { ...scope.current } } : {}),
    ...(scope.nativeReasoningOwner ? { nativeReasoningOwner: { ...scope.nativeReasoningOwner } } : {}),
    nativeReasoningEndpoint: durableReplayDestinationIdentity(url),
  };
  const authority = localAuthorities.get(scope);
  if (authority) localAuthorities.set(snapshot, authority);
  return snapshot;
}

function itemIdentity(item: Rec): NativeItem | undefined {
  const hasId = Object.hasOwn(item, "id");
  const hasCiphertext = Object.hasOwn(item, "encrypted_content");
  if (!hasId && !hasCiphertext) return undefined;
  if (hasId && (typeof item.id !== "string" || !item.id.trim())) return undefined;
  if (hasCiphertext && (typeof item.encrypted_content !== "string" || !item.encrypted_content.trim())) return undefined;
  return {
    ...(hasId ? { id: createHash("sha256").update(`id\0${item.id}`).digest("hex") } : {}),
    ...(hasCiphertext ? { ciphertext: createHash("sha256").update(`encrypted_content\0${item.encrypted_content}`).digest("hex") } : {}),
  };
}

function itemKey(item: NativeItem): string {
  return JSON.stringify([item.id ?? null, item.ciphertext ?? null]);
}

function nativeScope(scope: OcxReasoningReplayScopeRef | undefined, at: number): { entry: NativeScope; key: string } | undefined {
  const key = scopeIdentity(scope);
  if (!key) return undefined;
  const entry = nativeReasoning.get(key);
  if (entry && at - entry.at >= TTL_MS) {
    nativeReasoning.delete(key);
    return { entry: { at, items: new Map() }, key };
  }
  return { entry: entry ?? { at, items: new Map() }, key };
}

export function rememberKimiNativeReasoning(output: unknown, scope: OcxReasoningReplayScopeRef | undefined): void {
  if (!Array.isArray(output)) return;
  const at = Date.now();
  const current = nativeScope(scope, at);
  if (!current) return;
  const items = output.flatMap(item => isRec(item) && item.type === "reasoning" ? [itemIdentity(item)] : [])
    .filter((item): item is NativeItem => item !== undefined && (hasPrincipal(scope) || item.ciphertext !== undefined));
  if (items.length === 0) return;
  const { entry, key } = current;
  entry.at = at;
  for (const item of items) {
    const itemId = itemKey(item);
    entry.items.delete(itemId);
    entry.items.set(itemId, item);
    while (entry.items.size > MAX_ITEMS_PER_SCOPE) entry.items.delete(entry.items.keys().next().value!);
  }
  nativeReasoning.delete(key);
  nativeReasoning.set(key, entry);
  while (nativeReasoning.size > MAX_SCOPES) nativeReasoning.delete(nativeReasoning.keys().next().value!);
}

function isCurrentKimiNative(item: Rec, scope: OcxReasoningReplayScopeRef | undefined): boolean {
  const bound = nativeScope(scope, Date.now());
  const identity = itemIdentity(item);
  if (!bound || !identity) return false;
  if (!hasPrincipal(scope) && !identity.ciphertext) return false;
  if (identity.id && identity.ciphertext) return bound.entry.items.has(itemKey(identity));
  return [...bound.entry.items.values()].some(candidate => identity.id
    ? candidate.id === identity.id : candidate.ciphertext === identity.ciphertext);
}

export function containsRetainedKimiNativeReasoning(body: unknown, scope: OcxReasoningReplayScopeRef | undefined): boolean {
  return isRec(body) && Array.isArray(body.input) && body.input.some(item =>
    isRec(item) && item.type === "reasoning" && typeof item.encrypted_content === "string"
    && item.encrypted_content.length > 0 && isCurrentKimiNative(item, scope));
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
export function projectForeignKimiReasoning(body: unknown, scope?: OcxReasoningReplayScopeRef, forceForeign = false): unknown {
  if (!isRec(body) || !Array.isArray(body.input)) return body;
  if (!scope?.current) return body;
  let changed = false;
  const input: unknown[] = [];
  const removedIds = new Set<string>();
  for (const item of body.input) {
    if (!isRec(item) || item.type !== "reasoning") {
      input.push(item);
      continue;
    }
    if (!forceForeign && isCurrentKimiNative(item, scope)) {
      input.push(item);
      continue;
    }
    const text = readableText(item);
    changed = true;
    if (typeof item.id === "string" && item.id.length > 0) removedIds.add(item.id);
    if (text.length > 0) {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${RETAINED_PREFIX}${text}${RETAINED_SUFFIX}` }],
      });
    }
  }
  if (!changed) return body;
  return { ...body, input: input.filter(item => !isRec(item) || item.type !== "item_reference"
    || typeof item.id !== "string" || !removedIds.has(item.id)) };
}

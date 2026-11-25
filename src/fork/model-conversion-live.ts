import { closeSync, fstatSync, openSync, readFileSync, statSync, type BigIntStats } from "node:fs";
import { normalizeApiKeyIds } from "../config/load-degrade";
import { apiKeyEntrySchema, isUsableApiKeySecret } from "../config/schema/leaf-validators";
import type { OcxApiKeyEntry, OcxConfig } from "../types";
import { compileModelConversions, type ModelConversionRule } from "./model-conversion-config";

function version(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compileSnapshot(
  entries: readonly unknown[],
  previous: ReadonlyMap<string, readonly ModelConversionRule[]>,
  invalidIds: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, readonly ModelConversionRule[]> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (record(entry) && typeof entry.id === "string" && entry.id) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  }
  const next = new Map<string, readonly ModelConversionRule[]>();
  for (const id of invalidIds) {
    const rules = previous.get(id);
    if (rules) next.set(id, rules);
  }
  for (const entry of entries) {
    if (!record(entry) || typeof entry.id !== "string" || !entry.id) continue;
    const id = entry.id;
    const policy = entry.modelConversion;
    if (counts.get(id) === 1 && (policy === undefined || (record(policy) && policy.enabled === false))) {
      next.delete(id);
      continue;
    }
    try {
      if (counts.get(id) !== 1) throw new Error("Duplicate API key id");
      const rules = compileModelConversions([entry]).get(id);
      if (rules?.length) next.set(id, rules);
      else next.delete(id);
    } catch {
      const rules = previous.get(id);
      if (rules) next.set(id, rules);
    }
  }
  return next;
}

function credentials(entry: unknown, now: number, nextExpiry: { value: number }): string[] {
  if (!record(entry)) return [];
  const parsed = apiKeyEntrySchema.safeParse({ key: entry.key, pendingRotation: entry.pendingRotation });
  if (!parsed.success) return [];
  const result = [parsed.data.key];
  const pending = parsed.data.pendingRotation;
  const expiresAt = pending ? Date.parse(pending.expiresAt) : 0;
  if (pending && expiresAt > now) {
    result.push(pending.key);
    nextExpiry.value = Math.min(nextExpiry.value, expiresAt);
  }
  return result;
}

function compileFileSnapshot(
  rows: readonly unknown[],
  runtimeEntries: readonly unknown[],
  previous: ReadonlyMap<string, readonly ModelConversionRule[]>,
  now: number,
  nextExpiry: { value: number },
  sources: Map<string, "generated" | "explicit">,
): ReadonlyMap<string, readonly ModelConversionRule[]> {
  const runtimeCounts = new Map<string, number>();
  for (const entry of runtimeEntries) {
    if (record(entry) && typeof entry.id === "string" && entry.id) {
      runtimeCounts.set(entry.id, (runtimeCounts.get(entry.id) ?? 0) + 1);
    }
  }
  const owners = new Map<string, Set<string>>();
  const runtimeIds = new Set<string>();
  for (const entry of runtimeEntries) {
    if (!record(entry) || typeof entry.id !== "string" || !entry.id || runtimeCounts.get(entry.id) !== 1) continue;
    const secrets = credentials(entry, now, nextExpiry);
    if (!secrets.length) continue;
    runtimeIds.add(entry.id);
    for (const secret of secrets) {
      const ids = owners.get(secret) ?? new Set<string>();
      ids.add(entry.id);
      owners.set(secret, ids);
    }
  }

  const fileIdCounts = new Map<string, number>();
  for (const row of rows) {
    if (record(row) && typeof row.id === "string" && row.id) {
      fileIdCounts.set(row.id, (fileIdCounts.get(row.id) ?? 0) + 1);
    }
  }
  const invalidIds = new Set<string>();
  const matched = new Map<string, Record<string, unknown>>();
  const ownerCounts = new Map<string, number>();
  const fileEntries: Array<{
    id: string | undefined;
    namedOwner: string | undefined;
    candidates: Set<string>;
    owner: string | undefined;
    parsed: OcxApiKeyEntry | undefined;
  }> = [];
  for (const row of rows) {
    if (!record(row)) continue;
    const id = typeof row.id === "string" && row.id ? row.id : undefined;
    const secrets = credentials(row, now, nextExpiry);
    const candidates = new Set(secrets.flatMap(secret => [...(owners.get(secret) ?? [])]));
    const namedOwner = id && runtimeIds.has(id) ? id : undefined;
    const owner = candidates.size === 1 ? candidates.values().next().value : undefined;
    if (owner) ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
    const parsed = apiKeyEntrySchema.safeParse(row);
    fileEntries.push({ id, namedOwner, candidates, owner, parsed: parsed.success ? parsed.data as OcxApiKeyEntry : undefined });
  }
  const nextSources = new Map([...sources].filter(([id]) => runtimeIds.has(id)));
  const normalizedRows = fileEntries.filter(entry => entry.parsed !== undefined);
  const normalizedEntries = normalizedRows.map(entry => ({ ...entry.parsed! }));
  normalizeApiKeyIds({ apiKeys: normalizedEntries } as OcxConfig);
  normalizedRows.forEach((entry, index) => {
    if (!entry.owner || nextSources.has(entry.owner) || ownerCounts.get(entry.owner) !== 1
      || (entry.id && fileIdCounts.get(entry.id) !== 1)) return;
    if (!entry.id && normalizedEntries[index]!.id === entry.owner) nextSources.set(entry.owner, "generated");
    else if (entry.id === entry.owner) nextSources.set(entry.owner, "explicit");
  });

  for (const { id, namedOwner, candidates, owner, parsed } of fileEntries) {
    const generatedId = owner && namedOwner && nextSources.get(owner) === "generated"
      && nextSources.get(namedOwner) === "generated";
    if ((id && fileIdCounts.get(id) !== 1) || candidates.size > 1
      || (namedOwner && candidates.size > 0 && !candidates.has(namedOwner) && !generatedId)) {
      for (const candidate of candidates) invalidIds.add(candidate);
      if (namedOwner) invalidIds.add(namedOwner);
      continue;
    }
    if (!owner) {
      if (namedOwner) invalidIds.add(namedOwner);
      continue;
    }
    if (!parsed || matched.has(owner)) {
      invalidIds.add(owner);
      continue;
    }
    matched.set(owner, { ...parsed, id: owner });
  }
  const entries = [...matched].filter(([id]) => !invalidIds.has(id)).map(([, entry]) => entry);
  const snapshot = compileSnapshot(entries, previous, invalidIds);
  sources.clear();
  for (const [id, source] of nextSources) sources.set(id, source);
  return snapshot;
}

export function createLiveModelConversions(
  path: string,
  initialEntries: readonly unknown[] | (() => readonly unknown[]) = [],
): () => ReadonlyMap<string, readonly ModelConversionRule[]> {
  const getEntries = typeof initialEntries === "function" ? initialEntries : () => initialEntries;
  let observedVersion: string | undefined;
  let observedRuntime: WeakRef<readonly unknown[]> | undefined;
  let observedLength = -1;
  let observedExpiry = Infinity;
  let snapshot = compileSnapshot(getEntries(), new Map());
  const sources = new Map<string, "generated" | "explicit">();

  return () => {
    try {
      const runtimeEntries = getEntries();
      const now = Date.now();
      const sameRuntime = runtimeEntries.length === observedLength
        && (runtimeEntries.length === 0 || observedRuntime?.deref() === runtimeEntries);
      if (!sameRuntime && sources.size > 0) {
        const currentIds = new Set<string>();
        const duplicateIds = new Set<string>();
        for (const entry of runtimeEntries) {
          if (!record(entry) || typeof entry.id !== "string" || !entry.id || !isUsableApiKeySecret(entry.key)) continue;
          if (currentIds.has(entry.id)) duplicateIds.add(entry.id);
          currentIds.add(entry.id);
        }
        for (const id of sources.keys()) {
          if (!currentIds.has(id) || duplicateIds.has(id)) sources.delete(id);
        }
      }
      const currentVersion = version(statSync(path, { bigint: true }));
      if (currentVersion === observedVersion && sameRuntime && now < observedExpiry) return snapshot;
      const remember = (expiresAt = Infinity) => {
        observedVersion = currentVersion;
        observedRuntime = new WeakRef(runtimeEntries);
        observedLength = runtimeEntries.length;
        observedExpiry = expiresAt;
      };
      const fd = openSync(path, "r");
      let raw: string;
      try {
        if (version(fstatSync(fd, { bigint: true })) !== currentVersion) return snapshot;
        raw = readFileSync(fd, "utf8");
        if (version(fstatSync(fd, { bigint: true })) !== currentVersion
          || version(statSync(path, { bigint: true })) !== currentVersion) return snapshot;
      } finally {
        closeSync(fd);
      }

      let config: unknown;
      try { config = JSON.parse(raw.replace(/^\uFEFF/, "")); }
      catch { remember(); return snapshot; }
      if (!record(config) || (config.apiKeys !== undefined && !Array.isArray(config.apiKeys))) {
        remember();
        return snapshot;
      }

      const nextExpiry = { value: Infinity };
      snapshot = compileFileSnapshot(config.apiKeys ?? [], runtimeEntries, snapshot, now, nextExpiry, sources);
      remember(nextExpiry.value);
    } catch {
      observedVersion = undefined;
    }
    return snapshot;
  };
}

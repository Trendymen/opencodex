type PermissionDescriptor = { key: string; group: "request" | "response" | "headers" | "localErrors"; defaultValue: true };

export const CODEX_PASSTHROUGH_CATALOG = [
  { key: "normalizeRequestParameters", group: "request", defaultValue: true },
  { key: "expandRequestHistory", group: "request", defaultValue: true },
  { key: "normalizeEncryptedContent", group: "request", defaultValue: true },
  { key: "snapshotSkillsCatalog", group: "request", defaultValue: true },
  { key: "rewriteAnnotationInstructions", group: "request", defaultValue: true },
  { key: "bridgeLiteMetadata", group: "request", defaultValue: true },
  { key: "backfillResponseFields", group: "response", defaultValue: true },
  { key: "repairResponseToolCalls", group: "response", defaultValue: true },
  { key: "redactUpstreamErrors", group: "response", defaultValue: true },
  { key: "privateSseReadDeadline", group: "response", defaultValue: true },
  { key: "upstreamWsSilenceDeadline", group: "response", defaultValue: true },
  { key: "privateErrorBodyReadDeadline", group: "response", defaultValue: true },
  { key: "synthesizeTerminalFailure", group: "response", defaultValue: true },
  { key: "normalizeHostedImages", group: "response", defaultValue: true },
  { key: "synthesizeRoutingHint", group: "headers", defaultValue: true },
  { key: "synthesizeSessionId", group: "headers", defaultValue: true },
  { key: "addResponseRequestId", group: "headers", defaultValue: true },
  { key: "addResponseBrowserHeaders", group: "headers", defaultValue: true },
  { key: "resetReplayRefusal", group: "localErrors", defaultValue: true },
  { key: "requestPacingAdmission", group: "localErrors", defaultValue: true },
  { key: "inputAdmissionPrecheck", group: "localErrors", defaultValue: true },
  { key: "accountSoftPrecheck", group: "localErrors", defaultValue: true },
  { key: "transportErrorMapping", group: "localErrors", defaultValue: true },
] as const satisfies readonly PermissionDescriptor[];

type Descriptor = typeof CODEX_PASSTHROUGH_CATALOG[number];
export type CodexPassthroughCompatKey = Exclude<Descriptor, { group: "localErrors" }>["key"];
export type CodexLocalErrorPolicyKey = Extract<Descriptor, { group: "localErrors" }>["key"];
export type PermissionPath = CodexPassthroughCompatKey | `localErrorPolicies.${CodexLocalErrorPolicyKey}`;
export type CodexPassthroughConfig = Partial<Record<CodexPassthroughCompatKey, boolean>> & {
  localErrorPolicies?: Partial<Record<CodexLocalErrorPolicyKey, boolean>>;
};
export type CodexPassthroughPatch = Partial<Record<CodexPassthroughCompatKey, boolean | null>> & {
  localErrorPolicies?: Partial<Record<CodexLocalErrorPolicyKey, boolean | null>> | null;
};
export type CodexPassthroughPermissions = Readonly<Record<CodexPassthroughCompatKey, boolean>> & {
  readonly localErrorPolicies: Readonly<Record<CodexLocalErrorPolicyKey, boolean>>;
};

const compatKeys = CODEX_PASSTHROUGH_CATALOG.filter(row => row.group !== "localErrors").map(row => row.key);
const localKeys = CODEX_PASSTHROUGH_CATALOG.filter(row => row.group === "localErrors").map(row => row.key);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)) ? value as Record<string, unknown> : undefined;
}

function permissions(defaultValue: boolean): CodexPassthroughPermissions {
  return Object.freeze({
    ...Object.fromEntries(compatKeys.map(key => [key, defaultValue])),
    localErrorPolicies: Object.freeze(Object.fromEntries(localKeys.map(key => [key, defaultValue]))),
  }) as CodexPassthroughPermissions;
}

export const CODEX_PASSTHROUGH_DEFAULTS = permissions(true);

export function resolveCodexPassthroughPermissions(value: CodexPassthroughConfig | undefined): CodexPassthroughPermissions {
  const resolved = { ...CODEX_PASSTHROUGH_DEFAULTS, localErrorPolicies: { ...CODEX_PASSTHROUGH_DEFAULTS.localErrorPolicies } };
  for (const key of compatKeys) if (typeof value?.[key] === "boolean") resolved[key] = value[key];
  for (const key of localKeys) if (typeof value?.localErrorPolicies?.[key] === "boolean") resolved.localErrorPolicies[key] = value.localErrorPolicies[key];
  Object.freeze(resolved.localErrorPolicies);
  return Object.freeze(resolved);
}

function candidateError(value: unknown, allowClear: boolean): string | null {
  if (value === undefined || (allowClear && value === null)) return null;
  const root = record(value);
  if (!root) return "codexPassthrough must be a plain object";
  for (const [key, leaf] of Object.entries(root)) {
    if (key === "localErrorPolicies") {
      if (leaf === undefined || (allowClear && leaf === null)) continue;
      const local = record(leaf);
      if (!local) return "codexPassthrough.localErrorPolicies must be a plain object";
      for (const [localKey, localLeaf] of Object.entries(local)) {
        if (!localKeys.some(key => key === localKey)) return "codexPassthrough.localErrorPolicies contains an unsupported field";
        if (localLeaf !== undefined && typeof localLeaf !== "boolean" && !(allowClear && localLeaf === null)) {
          return `codexPassthrough.localErrorPolicies.${localKey} must be a boolean`;
        }
      }
    } else {
      if (!compatKeys.some(known => known === key)) return "codexPassthrough contains an unsupported field";
      if (leaf !== undefined && typeof leaf !== "boolean" && !(allowClear && leaf === null)) return `codexPassthrough.${key} must be a boolean`;
    }
  }
  return null;
}

export function codexPassthroughCandidateError(value: unknown): string | null {
  return candidateError(value, false);
}

export function configCodexPassthroughCandidateError(value: unknown): string | null {
  const providers = record(record(value)?.providers);
  for (const provider of Object.values(providers ?? {})) {
    const error = codexPassthroughCandidateError(record(provider)?.codexPassthrough);
    if (error) return error;
  }
  return null;
}

export function readCodexPassthroughConfig(value: unknown): { value: CodexPassthroughConfig | undefined; warnings: readonly string[] } {
  if (value === undefined) return { value: undefined, warnings: [] };
  const root = record(value);
  if (!root) {
    const disabled = permissions(false);
    return { value: { ...disabled, localErrorPolicies: { ...disabled.localErrorPolicies } },
      warnings: ["codexPassthrough is invalid; all compatibility permissions disabled"] };
  }
  const result: CodexPassthroughConfig = {};
  const warnings: string[] = [];
  if (Object.keys(root).some(key => key !== "localErrorPolicies" && !compatKeys.some(known => known === key))) {
    warnings.push("codexPassthrough contains unsupported fields; ignored");
  }
  for (const key of compatKeys) {
    if (root[key] === undefined) continue;
    result[key] = typeof root[key] === "boolean" ? root[key] : false;
    if (typeof root[key] !== "boolean") warnings.push(`codexPassthrough.${key} is invalid; permission disabled`);
  }
  if (root.localErrorPolicies !== undefined) {
    const local = record(root.localErrorPolicies);
    if (!local) {
      result.localErrorPolicies = { ...permissions(false).localErrorPolicies };
      warnings.push("codexPassthrough.localErrorPolicies is invalid; local permissions disabled");
    } else {
      result.localErrorPolicies = {};
      if (Object.keys(local).some(key => !localKeys.some(known => known === key))) warnings.push("codexPassthrough.localErrorPolicies contains unsupported fields; ignored");
      for (const key of localKeys) {
        if (local[key] === undefined) continue;
        result.localErrorPolicies[key] = typeof local[key] === "boolean" ? local[key] : false;
        if (typeof local[key] !== "boolean") warnings.push(`codexPassthrough.localErrorPolicies.${key} is invalid; permission disabled`);
      }
    }
  }
  return { value: result, warnings };
}

export function mergeCodexPassthroughPatch(current: CodexPassthroughConfig | undefined, patch: unknown):
  { ok: true; value: CodexPassthroughConfig | undefined } | { ok: false; error: string } {
  const error = candidateError(patch, true);
  if (error) return { ok: false, error };
  if (patch === null) return { ok: true, value: undefined };
  const next = { ...current, ...(current?.localErrorPolicies ? { localErrorPolicies: { ...current.localErrorPolicies } } : {}) };
  const root = record(patch) ?? {};
  for (const key of compatKeys) {
    if (root[key] === null) delete next[key];
    else if (typeof root[key] === "boolean") next[key] = root[key];
  }
  if (root.localErrorPolicies === null) delete next.localErrorPolicies;
  else if (root.localErrorPolicies !== undefined) {
    const local = { ...next.localErrorPolicies };
    const localPatch = record(root.localErrorPolicies)!;
    for (const key of localKeys) {
      if (localPatch[key] === null) delete local[key];
      else if (typeof localPatch[key] === "boolean") local[key] = localPatch[key];
    }
    if (Object.keys(local).length) next.localErrorPolicies = local;
    else delete next.localErrorPolicies;
  }
  return { ok: true, value: Object.keys(next).length ? next : undefined };
}

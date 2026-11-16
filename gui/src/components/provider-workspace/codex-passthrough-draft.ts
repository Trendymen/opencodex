import {
  CODEX_PASSTHROUGH_CATALOG, mergeCodexPassthroughPatch, resolveCodexPassthroughPermissions,
  type CodexPassthroughConfig, type CodexPassthroughPatch,
} from "../../../../src/fork/codex-passthrough-contract";

export function editCodexPassthrough(
  value: CodexPassthroughConfig | undefined,
  baseline: CodexPassthroughConfig | undefined,
  edit: CodexPassthroughConfig,
): { value: CodexPassthroughConfig | undefined; forceAllOff: boolean } {
  const merged = mergeCodexPassthroughPatch(value, edit);
  if (!merged.ok) return { value, forceAllOff: false };
  const allOff = CODEX_PASSTHROUGH_CATALOG.every(row => row.group === "localErrors"
    ? edit.localErrorPolicies?.[row.key] === false : edit[row.key] === false);
  if (allOff) return { value: merged.value, forceAllOff: true };

  const resolvedBaseline = resolveCodexPassthroughPermissions(baseline);
  const restore: CodexPassthroughPatch = {};
  for (const row of CODEX_PASSTHROUGH_CATALOG) {
    if (row.group === "localErrors") {
      const edited = edit.localErrorPolicies?.[row.key];
      if (edited !== undefined && edited === resolvedBaseline.localErrorPolicies[row.key]) {
        (restore.localErrorPolicies ??= {})[row.key] = baseline?.localErrorPolicies?.[row.key] ?? null;
      }
    } else if (edit[row.key] !== undefined && edit[row.key] === resolvedBaseline[row.key]) {
      restore[row.key] = baseline?.[row.key] ?? null;
    }
  }
  const restored = mergeCodexPassthroughPatch(merged.value, restore);
  return { value: restored.ok ? restored.value : merged.value, forceAllOff: false };
}

export function codexPassthroughDelta(
  baseline: CodexPassthroughConfig | undefined,
  value: CodexPassthroughConfig | undefined,
  forceAllOff = false,
): CodexPassthroughPatch | undefined {
  const patch: CodexPassthroughPatch = {};
  const resolved = resolveCodexPassthroughPermissions(value);
  for (const row of CODEX_PASSTHROUGH_CATALOG) {
    if (row.group === "localErrors") {
      const next = value?.localErrorPolicies?.[row.key];
      if (forceAllOff || next !== baseline?.localErrorPolicies?.[row.key]) {
        (patch.localErrorPolicies ??= {})[row.key] = forceAllOff ? resolved.localErrorPolicies[row.key] : next ?? null;
      }
    } else {
      const next = value?.[row.key];
      if (forceAllOff || next !== baseline?.[row.key]) patch[row.key] = forceAllOff ? resolved[row.key] : next ?? null;
    }
  }
  return Object.keys(patch).length ? patch : undefined;
}

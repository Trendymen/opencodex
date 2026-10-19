import { useState } from "react";
import {
  CODEX_PASSTHROUGH_CATALOG, mergeCodexPassthroughPatch, resolveCodexPassthroughPermissions,
  type CodexPassthroughConfig,
} from "../../../../src/fork/codex-passthrough-contract";

export function useCodexPassthroughDraft(saved: CodexPassthroughConfig | undefined) {
  const signature = JSON.stringify(CODEX_PASSTHROUGH_CATALOG.map(row => row.group === "localErrors"
    ? saved?.localErrorPolicies?.[row.key] ?? null : saved?.[row.key] ?? null));
  const [draft, setDraft] = useState<{ signature: string; patch?: CodexPassthroughConfig; confirmed?: CodexPassthroughConfig }>({ signature });
  if (draft.signature !== signature) setDraft({ signature });
  const patch = draft.signature === signature ? draft.patch : undefined;
  const confirmed = draft.signature === signature ? draft.confirmed : undefined;
  const base = mergeCodexPassthroughPatch(saved, confirmed);
  const baselineValue = base.ok ? base.value : saved;

  const change = (edit: CodexPassthroughConfig) => {
    const allOff = CODEX_PASSTHROUGH_CATALOG.every(row => row.group === "localErrors"
      ? edit.localErrorPolicies?.[row.key] === false : edit[row.key] === false);
    if (allOff) { setDraft({ signature, confirmed, patch: edit }); return; }
    const baseline = resolveCodexPassthroughPermissions(baselineValue);
    setDraft(previous => {
      const merged = mergeCodexPassthroughPatch(previous.signature === signature ? previous.patch : undefined, edit);
      if (!merged.ok) return previous;
      const next = mergeCodexPassthroughPatch(merged.value, {
        ...Object.fromEntries(CODEX_PASSTHROUGH_CATALOG.filter(row => row.group !== "localErrors"
          && edit[row.key] === baseline[row.key]).map(row => [row.key, null])),
        ...(merged.value?.localErrorPolicies ? { localErrorPolicies: Object.fromEntries(
          CODEX_PASSTHROUGH_CATALOG.filter(row => row.group === "localErrors"
            && edit.localErrorPolicies?.[row.key] === baseline.localErrorPolicies[row.key]).map(row => [row.key, null]),
        ) } : {}),
      });
      return next.ok ? { signature, confirmed, patch: next.value } : previous;
    });
  };
  const acknowledge = () => setDraft(previous => {
    if (previous.signature !== signature || previous.patch !== patch) return previous;
    const merged = mergeCodexPassthroughPatch(previous.confirmed, patch);
    return merged.ok ? { signature, confirmed: merged.value } : previous;
  });
  const merged = mergeCodexPassthroughPatch(baselineValue, patch);
  return { value: merged.ok ? merged.value : baselineValue, patch, dirty: patch !== undefined, acknowledge,
    change, discard: () => setDraft({ signature, confirmed }) };
}

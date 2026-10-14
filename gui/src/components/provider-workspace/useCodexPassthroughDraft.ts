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
      const next = merged.value ?? {};
      for (const row of CODEX_PASSTHROUGH_CATALOG) {
        if (row.group === "localErrors") {
          if (next.localErrorPolicies && edit.localErrorPolicies?.[row.key] === baseline.localErrorPolicies[row.key]) delete next.localErrorPolicies[row.key];
        } else if (edit[row.key] === baseline[row.key]) delete next[row.key];
      }
      if (next.localErrorPolicies && !Object.keys(next.localErrorPolicies).length) delete next.localErrorPolicies;
      return { signature, confirmed, patch: Object.keys(next).length ? next : undefined };
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

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../helpers/repo-root";

const repoUrl = pathToFileURL(repoRoot() + "/");
const packageText = readFileSync(new URL("package.json", repoUrl), "utf8");
const changes = readFileSync(new URL("FORK_CHANGES.md", repoUrl), "utf8");
const automation = readFileSync(new URL("docs/fork-sync-automation.md", repoUrl), "utf8");
const localRules = readFileSync(new URL("AGENTS.local.md", repoUrl), "utf8");

const packageVersion = JSON.parse(packageText).version as string;
const officialVersion = packageVersion.replace(/-ben\.\d+$/, "");
const ATOMIC_REFSET = [
  ["branch", "main", "leased-force", "RELEASE_COMMIT:refs/heads/main"],
  ["branch", "dev", "leased-force", "RELEASE_COMMIT:refs/heads/dev"],
  ["branch", "sync", "leased-force", "RELEASE_COMMIT:refs/heads/sync/vX.Y.Z"],
  ["branch", "marker", "leased-force", "OFFICIAL_COMMIT:refs/heads/upstream-release"],
  ["tag", "official", "no-force-no-lease", "refs/tags/vX.Y.Z:refs/tags/vX.Y.Z"],
  ["tag", "fork", "no-force-no-lease", "refs/tags/vX.Y.Z-ben.N:refs/tags/vX.Y.Z-ben.N"],
] as const;
const CONTRACTS = {
  "fork-release-lifecycle": {
    rebase_branch: "dev",
    rebase_request: "full_steps_1_to_15_unless_user_explicitly_stops",
    sync_role: "single-mutable-release-pointer-per-official-baseline",
    release_instant_dev: "must-equal-RELEASE_COMMIT",
    post_release_advanced_dev: "must-not-reset",
    sync_update: "exact-oid-leased-force-to-RELEASE_COMMIT",
    final_convergence: "local-remote-main-dev-RELEASE_SYNC_REF-fork-tag-equal-RELEASE_COMMIT",
  },
  "sync-audit-ref-policy": {
    ref_scope: "single-mutable-ref-per-official-baseline",
    release_sync_ref: "refs/heads/sync/vX.Y.Z",
    revision_specific_ref: "forbidden",
    initial_creation: "expected-absent-lease",
    existing_update: "exact-oid-leased-force-allowed",
    ancestry_requirement: "none",
    release_instant: "main-dev-RELEASE_SYNC_REF-fork-tag-equal-RELEASE_COMMIT",
  },
  "same-base-ben-preflight": {
    scope: "strict-local-and-remote-vX.Y.Z-ben.N",
    snapshot: "name-raw-peeled",
    pre_local_tag: "freeze-local-baseline-and-remote-baseline",
    pre_push: "local-baseline-plus-exact-target-and-remote-baseline",
    post_push: "remote-baseline-or-remote-baseline-plus-exact-target",
    higher_revision: "fail-closed-at-every-checkpoint",
    other_drift: "fail-closed",
    post_success: "required-before-github-release",
    serialization: "single-publisher-required",
    toctou: "final-recheck-to-push-window-is-residual-risk",
  },
  "local-ref-cas-transaction": {
    transport: "git-update-ref-stdin",
    transaction: "start-prepare-commit",
    main_update: "refs/heads/main RELEASE_COMMIT EXPECTED_OLD_LOCAL_MAIN",
    sync_update: "refs/heads/sync/vX.Y.Z RELEASE_COMMIT EXPECTED_OLD_LOCAL_SYNC",
    marker_update: "refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER",
    atomicity: "all-or-none",
    sequential_updates: "forbidden",
  },
  "fork-squash-release-policy": {
    target_count: "task-fixed-N-ge-2",
    task_inputs: "OFFICIAL_COMMIT,INITIAL_SOURCE_HEAD,INITIAL_SOURCE_TREE,SQUASH_TARGET_COUNT",
    content_snapshot: "append-only-SK-source-tree-manifests-C1-through-CN-minus-1",
    push_attempt: "append-only-AJ-content-snapshot-CN-candidate-push-ci",
    final_commit: "CN-docs-only-FORK_CHANGES-parent-CN-minus-1",
    same_tree_retry: "amend-CN-attempt-marker-no-N-plus-1",
    material_fix: "fold-into-owner-and-rebuild-all-successors-new-SK-AJ",
    candidate_push: "dev-exact-oid-force-with-lease",
    candidate_ci: "exact-push-dev-head-sha-completed-success-aggregate-ci",
    workflow_security_review: "pre-candidate-push-content-snapshot-ci-yml-blob-pass",
    regular_reviews: "post-candidate-ci-final-CN-sha-pass",
    pre_release_ci: "exact-dev-candidate-and-main-ci-success-same-CN-sha",
    tagged_failure: "immutable-tag-consumed-revision-release-blocked",
    external_evidence: "task-and-release-notes-not-candidate-tree",
  },
  "rebase-review-package": {
    fixed_shas: "task:OLD_OFFICIAL,NEW_OFFICIAL,PRE_REBASE_DEV,POST_REBASE_HEAD;round:IMPLEMENTATION_HEAD_RN,RELEASE_COMMIT_RN",
    path_sets: "OFFICIAL_CHANGED_PATHS,OLD_FORK_NET_PATHS,OLD_FORK_TOUCHED_PATHS,NET_OVERLAP_PATHS,OVERLAP_PATHS,CONTENT_CONFLICTS,NON_OVERLAP_CONFLICTS,AUTO_MERGES",
    conflict_ledger: "one-entry-per-content-conflict-path",
    conflict_fields: "path,symbols,official_change,fork_change,resolution,official_coverage,conflict_snapshots,focused_tests,residual_risk",
    risk_fields: "on-specific-reviewer-evidence-request-only:downstream_consumers,failure_paths,state_edges,ordering_edges,risk_domains",
    full_fork_diff: "FULL_FORK_DIFF:git-diff-NEW_OFFICIAL-to-RELEASE_COMMIT_RN",
    rebase_resolution_diff: "REBASE_RESOLUTION_DIFF:git-range-diff-OLD_OFFICIAL..PRE_REBASE_DEV-to-NEW_OFFICIAL..POST_REBASE_HEAD",
    post_rebase_fix_diff: "POST_REBASE_FIX_DIFF:git-diff-POST_REBASE_HEAD-to-IMPLEMENTATION_HEAD_RN",
    spec_recomputation: "required-independent-for-endpoint-and-touched-sets",
    conflict_reconciliation: "captured-stop-union-plus-conditional-shadow-replay",
    review_rounds: "append-only-latest-round-binds-review",
    review_verdicts: "PASS,FAIL",
    quality_named_risks: "required",
  },
  "mechanical-recomputation": {
    official_changed_paths: "git-diff-name-only-no-renames-OLD_OFFICIAL-to-NEW_OFFICIAL",
    old_fork_net_paths: "git-diff-name-only-no-renames-OLD_OFFICIAL-to-PRE_REBASE_DEV",
    old_fork_touched_paths: "union-of-per-nonmerge-commit-no-renames-paths",
    net_overlap_paths: "OFFICIAL_CHANGED_PATHS-intersect-OLD_FORK_NET_PATHS",
    overlap_paths: "OFFICIAL_CHANGED_PATHS-intersect-OLD_FORK_TOUCHED_PATHS",
    content_conflicts: "captured-union-from-all-rebase-stops",
    non_overlap_conflicts: "CONTENT_CONFLICTS-minus-OVERLAP_PATHS-retained-and-explained",
    auto_merges: "OVERLAP_PATHS-minus-CONTENT_CONFLICTS",
    counts: "derived-from-recomputed-sets",
    copied_constants: "forbidden",
    verdict: "SPEC_COMPLIANCE:FAIL-on-missing-or-mismatch",
  },
  "review-round-lifecycle": {
    task_immutable: "OLD_OFFICIAL,NEW_OFFICIAL,PRE_REBASE_DEV,POST_REBASE_HEAD",
    attempt_id: "A-positive-integer-before-completed-round",
    attempt_state: "abandoned-on-implementation-change-or-promoted-after-verification",
    round_assignment: "only-after-IMPLEMENTATION_HEAD-and-RELEASE_COMMIT-pair-exists",
    round_id: "R-positive-integer-append-only",
    review_phase: "INITIAL-before-first-dispatch;RE_REVIEW-after-prior-verdict",
    round_outputs: "IMPLEMENTATION_HEAD_RN,RELEASE_COMMIT_RN",
    round_immutability: "append-only-never-overwrite",
    latest_binding: "all-diffs-verification-review-package-use-latest-round",
    prior_binding: "reviewed-rounds-only-retained-in-PRIOR_FINDINGS",
    implementation_change: "requires-new-round-and-full-verification",
  },
  "conflict-snapshot-contract": {
    per_stop: "rebase-step,REBASE_HEAD,resolution-action,resolved-index-tree,post-action-HEAD-tree",
    per_path: "path,stage1-mode-blob,stage2-mode-blob,stage3-mode-blob,combined-diff,stage0-mode-blob-or-deleted",
    resolution_action: "continue-created-commit,skip-empty,continue-kept-empty",
    commit_mapping: "REBASE_HEAD-to-replayed-commit-or-dropped-with-reason",
    hunk_id: "sha256-rebase-step-REBASE_HEAD-path-stage-mode-blobs-normalized-hunk",
    hunk_dedupe: "exact-hunk-id-only",
    captured_union: "all-unresolved-paths-from-all-stops",
    replay_environment: "pre-rebase-git-version-invocation-config-attributes-and-rerere-disabled",
    replay_manifest_digest: "optional-summary-not-release-gate",
    shadow_trigger: "ambiguous-source-or-nonlinear-history-or-custom-driver-or-rerere-or-incomplete-evidence-or-history-rewrite-or-mechanical-mismatch-or-reviewer-request",
    shadow_clone: "created-only-when-triggered-and-preserves-PRE_REBASE_DEV",
    object_access: "shared-source-objects-cat-file-verified-before-replay",
    shadow_replay: "conditional-isolated-temp-clone-fixed-task-shas-recorded-resolutions",
    shadow_match: "actions-mappings-stops-paths-hunk-ids-produced-trees-and-final-tree-must-equal-before-review",
    mismatch_verdict: "SPEC_COMPLIANCE:FAIL",
  },
  "rebase-conflict-named-risks": {
    final_consumers: "secondary-defaulting-and-final-projection",
    nullish_values: "undefined,absent,null,false,empty",
    failure_paths: "abort,retry-exhausted,one-shot,timeout,body-ceiling,resource-release",
    stream_ordering: "sparse,out-of-order,duplicate,terminal,flush,dispose",
    rebuild_parity: "initial-build-versus-rebuild",
    round_trip: "schema,load,POST,PATCH,GET,DTO,persistence,runtime-consumer",
    capability_reachability: "official-and-fork-capabilities-remain-reachable",
    minimal_official_diff: "required-per-file-necessity-and-no-unrelated-change",
  },
  "rebase-review-escalation": {
    default_reviewers: "SPEC_COMPLIANCE,CODE_QUALITY",
    review_priority: "paths-hunks-and-symbols-cover-sensitive-and-shared-boundaries",
    explorer: "optional-evidence-only-not-release-gate",
    annex: "on-specific-reviewer-evidence-request-only",
    narrow_review_trigger: "dual-reviewer-unresolved-specific-cross-boundary-path-symbol-or-edge-or-owner-specific-uncertainty",
    narrow_review_mode: "CODE_QUALITY",
    narrow_review_scope: "exact-unresolved-paths-symbols-and-edges-only",
    generic_reviewer_expansion: "forbidden",
  },
} as const;

function machineBlock(source: string, name: string): string {
  expect([...source.matchAll(new RegExp("<!-- " + name + ":start -->", "g"))]).toHaveLength(1);
  expect([...source.matchAll(new RegExp("<!-- " + name + ":end -->", "g"))]).toHaveLength(1);
  const match = source.match(new RegExp(
    "<!-- " + name + ":start -->\\n([\\s\\S]*?)\\n<!-- " + name + ":end -->",
  ));
  expect(match, "missing " + name + " machine block").not.toBeNull();
  return match![1]!;
}

function strictContract(
  source: string,
  name: keyof typeof CONTRACTS,
): Record<string, string> {
  const expected = CONTRACTS[name];
  const entries = machineBlock(source, name).split("\n").map((line): [string, string] => {
    const match = line.match(/^([a-z0-9_]+)=(.+)$/);
    if (!match) throw new Error("invalid " + name + " row: " + line);
    return [match[1]!, match[2]!];
  });
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length || JSON.stringify(keys) !== JSON.stringify(Object.keys(expected))) {
    throw new Error(name + " keys differ from the exact contract");
  }
  const parsed = Object.fromEntries(entries);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error(name + " values differ from the exact contract");
  }
  return parsed;
}

function strictRebaseContracts(source: string): void {
  for (const name of [
    "rebase-review-package",
    "mechanical-recomputation",
    "review-round-lifecycle",
    "conflict-snapshot-contract",
    "rebase-conflict-named-risks",
    "rebase-review-escalation",
  ] as const) {
    strictContract(source, name);
  }
}

function parseAtomicRefset(source: string): string[][] {
  const rows = source.split("\n").map((line) => {
    const fields = line.split("|");
    if (fields.length !== 4 || fields.some(field => !field)) {
      throw new Error("invalid atomic refset row: " + line);
    }
    return fields;
  });
  if (JSON.stringify(rows) !== JSON.stringify(ATOMIC_REFSET)) {
    throw new Error("atomic refset differs from the release contract");
  }
  return rows;
}

function section(title: string): string {
  const start = changes.indexOf("### " + title + "\n");
  expect(start, "missing section " + title).toBeGreaterThanOrEqual(0);
  const next = changes.slice(start + 1).search(/\n#{1,3} /);
  return next === -1 ? changes.slice(start) : changes.slice(start, start + 1 + next);
}

function currentBaseline(source: string): RegExpMatchArray {
  const baselines = [...source.matchAll(/^- 上游基线：`([^`]+)`（`([0-9a-f]{40})`）。$/gm)];
  expect(baselines).toHaveLength(1);
  return baselines[0]!;
}

function documentEntryExists(entry: string): boolean {
  if (entry.includes("*")) {
    return !new Bun.Glob(entry).scanSync({ cwd: repoRoot(), onlyFiles: true }).next().done;
  }
  return existsSync(new URL(entry, repoUrl));
}

describe("Fork maintenance truth", () => {
  test("keeps FORK_CHANGES as the current baseline capability list", () => {
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+-ben\.\d+$/);
    const baseline = currentBaseline(changes);
    expect(baseline[1]).toBe("v" + officialVersion);
    expect(changes).not.toContain("<!--");
    expect(changes).not.toMatch(/^#{1,6}\s+.*(?:历史|rebase)/im);
    expect(changes).not.toMatch(/^#{1,6}\s+.*(?:\bv\d+\.\d+\.\d+\b|\b\d+\.\d+\.\d+-ben\.\d+\b)/im);
    expect(() => currentBaseline(changes + "\n" + baseline[0])).toThrow();
  });

  test("grounds current capability sections in implementation and coverage entry points", () => {
    const evidence: Record<string, string[]> = {
      "火山方舟 Agent Plan GLM/Kimi 与智谱 GLM Responses 兼容": ["src/fork/glm-kimi-compat.ts", "tests/providers/fork-volcengine-empty-assistant-content.test.ts"],
      "Ark quota 在 Codex Desktop 中的展示": ["src/fork/ark-quota-display.ts", "tests/providers/fork-ark-weekly-quota.test.ts"],
      "自定义模型配置、工具模式与公开投影": ["src/config/custom-models.ts", "src/server/management/model-routes.ts", "tests/config/fork-custom-model-config-schema.test.ts"],
      "本地源码包安装": ["scripts/install-local-vendor.ts", "scripts/install-local.ts", "tests/ci-workflows/fork-install-local-*.test.ts"],
      "SSE block rewrite flush 与终态兼容": ["src/server/sse-payload-rewrite.ts", "tests/responses/fork-sse-block-rewrite-flush.test.ts"],
      "GUI Logs/Debug 增量": ["gui/src/pages/Logs.tsx", "gui/src/pages/Debug.tsx", "gui/src/i18n/"],
      "`ben` Fork 修订版本策略": ["src/fork/version-policy.mjs", "tests/update/fork-version-policy.test.ts"],
      "Standalone web search 能力注入": ["src/codex/inject.ts"],
      "智谱 BigModel Codex 模型发现": ["src/providers/model-discovery.ts", "tests/providers/zhipu-bigmodel-codex-provider.test.ts"],
      "测试、CI 与维护规则": ["tests/update/update-stop-first.test.ts", "tests/service/shutdown-launcher.test.ts", "scripts/prepare-fork-official-base.ts"],
    };
    for (const [title, paths] of Object.entries(evidence)) {
      const capability = section(title);
      for (const path of paths) {
        expect(capability).toContain(path);
        expect(documentEntryExists(path)).toBeTrue();
      }
    }
  });

  test("keeps release lifecycle, refset, and sync policy exact in automation", () => {
    expect(strictContract(automation, "fork-release-lifecycle")).toEqual(CONTRACTS["fork-release-lifecycle"]);
    expect(strictContract(automation, "sync-audit-ref-policy")).toEqual(CONTRACTS["sync-audit-ref-policy"]);
    const refset = machineBlock(automation, "official-atomic-refset");
    expect(parseAtomicRefset(refset)).toEqual(ATOMIC_REFSET);
    expect(automation).toContain("git rebase --onto <new-tag-sha> <old-upstream-release-sha> dev");
    expect(automation).not.toContain("maintenance_revision_ref=refs/heads/sync/vX.Y.Z-ben.N");
    expect(localRules).toContain("禁止创建 `sync/vX.Y.Z-ben.N`");
    expect(() => strictContract(
      automation.replace("revision_specific_ref=forbidden", "revision_specific_ref=allowed"),
      "sync-audit-ref-policy",
    )).toThrow();
    expect(() => strictContract(
      automation.replace("existing_update=exact-oid-leased-force-allowed", "existing_update=fast-forward-only"),
      "sync-audit-ref-policy",
    )).toThrow();
    expect(() => strictContract(
      automation.replace("ancestry_requirement=none", "ancestry_requirement=required"),
      "sync-audit-ref-policy",
    )).toThrow();
    expect(() => parseAtomicRefset(refset.replace(
      "branch|main|leased-force", "branch|main|unleased",
    ))).toThrow();
    expect(() => parseAtomicRefset(refset.replace(
      "tag|official|no-force-no-lease|refs/tags/vX.Y.Z:refs/tags/vX.Y.Z",
      "tag|official|no-force-no-lease|+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z",
    ))).toThrow();
    expect(() => parseAtomicRefset(refset + "\nbranch|extra|leased-force|extra:refs/heads/extra")).toThrow();
    expect(() => machineBlock(
      automation + "\n<!-- official-atomic-refset:start -->\nbranch|main|unleased|RELEASE_COMMIT:refs/heads/main\n<!-- official-atomic-refset:end -->",
      "official-atomic-refset",
    )).toThrow();
    expect(() => strictContract(automation.replace(
      "rebase_branch=dev",
      "rebase_branch=dev\nrebase_branch=dev",
    ), "fork-release-lifecycle")).toThrow();
  });

  test("keeps same-base Tag and local ref CAS publication fail-closed in automation", () => {
    expect(strictContract(automation, "same-base-ben-preflight")).toEqual(CONTRACTS["same-base-ben-preflight"]);
    expect(strictContract(automation, "local-ref-cas-transaction")).toEqual(CONTRACTS["local-ref-cas-transaction"]);
    expect(automation).toContain("update refs/heads/main RELEASE_COMMIT EXPECTED_OLD_LOCAL_MAIN");
    expect(automation).toContain("update refs/heads/sync/vX.Y.Z RELEASE_COMMIT EXPECTED_OLD_LOCAL_SYNC");
    expect(automation).toContain("update refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER");
    expect(() => strictContract(automation.replace(
      "local-baseline-plus-exact-target-and-remote-baseline",
      "local-baseline-plus-any-target-and-remote-baseline",
    ), "same-base-ben-preflight")).toThrow();
    expect(() => strictContract(automation.replace(
      "refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER",
      "refs/heads/upstream-release OFFICIAL_COMMIT",
    ), "local-ref-cas-transaction")).toThrow();
    expect(() => strictContract(automation.replace(
      "transaction=start-prepare-commit",
      "transaction=sequential-updates",
    ), "local-ref-cas-transaction")).toThrow();
    expect(() => strictContract(automation.replace(
      "refs/heads/sync/vX.Y.Z RELEASE_COMMIT EXPECTED_OLD_LOCAL_SYNC",
      "refs/heads/sync/vX.Y.Z RELEASE_COMMIT",
    ), "local-ref-cas-transaction")).toThrow();
  });

  test("keeps the squash contract exact in automation and applicable local rules", () => {
    for (const source of [automation, localRules]) {
      expect(strictContract(source, "fork-squash-release-policy")).toEqual(CONTRACTS["fork-squash-release-policy"]);
    }
    expect(() => strictContract(automation.replace(
      "target_count=task-fixed-N-ge-2", "target_count=mutable-N",
    ), "fork-squash-release-policy")).toThrow();
    expect(() => strictContract(automation.replace(
      "same_tree_retry=amend-CN-attempt-marker-no-N-plus-1",
      "same_tree_retry=amend-CN-attempt-marker-append-N-plus-1",
    ), "fork-squash-release-policy")).toThrow();
    expect(() => strictContract(automation.replace(
      "pre_release_ci=exact-dev-candidate-and-main-ci-success-same-CN-sha",
      "pre_release_ci=exact-dev-candidate-and-main-ci-success-any-prior-ci-success",
    ), "fork-squash-release-policy")).toThrow();
  });

  test("keeps rebase evidence, review, and mechanical recomputation contracts exact in automation", () => {
    expect(() => strictRebaseContracts(automation)).not.toThrow();
    expect(localRules).toContain("docs/fork-sync-automation.md");
    expect(localRules).toContain("逐冲突证据账本");
    expect(localRules).toContain("命名风险清单");
    for (const [from, to] of [
      ["copied_constants=forbidden", "copied_constants=allowed"],
      ["conflict_ledger=one-entry-per-content-conflict-path", "conflict_ledger=summary-only"],
      ["narrow_review_scope=exact-unresolved-paths-symbols-and-edges-only", "narrow_review_scope=full-diff-again"],
      ["round_immutability=append-only-never-overwrite", "round_immutability=overwrite-latest"],
      ["hunk_dedupe=exact-hunk-id-only", "hunk_dedupe=path-only"],
      ["stage0-mode-blob-or-deleted", "resolved-stage0-blob"],
      ["continue-created-commit,skip-empty,continue-kept-empty", "continue-created-commit"],
      ["pre-rebase-git-version-invocation-config-attributes-and-rerere-disabled", "post-rebase-best-effort-config"],
      ["explorer=optional-evidence-only-not-release-gate", "explorer=mandatory-release-gate"],
      ["review_verdicts=PASS,FAIL", "review_verdicts=Approved,Needs-Changes"],
    ]) {
      expect(() => strictRebaseContracts(automation.replace(from, to))).toThrow();
    }
  });
});

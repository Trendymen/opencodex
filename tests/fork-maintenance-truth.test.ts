import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const repoUrl = new URL("../", import.meta.url);
const packageText = readFileSync(new URL("package.json", repoUrl), "utf8");
const changes = readFileSync(new URL("FORK_CHANGES.md", repoUrl), "utf8");
const automation = readFileSync(new URL("docs/fork-sync-automation.md", repoUrl), "utf8");
const localRules = readFileSync(new URL("AGENTS.local.md", repoUrl), "utf8");
const repairPlan = readFileSync(
  new URL("docs/superpowers/plans/2026-09-01-v238-fork-important-repairs.md", repoUrl),
  "utf8",
);

function currentGitBlob(path: string): string {
  const bytes = readFileSync(new URL(path, repoUrl));
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

const EXPECTED_OVERLAPS = [
  "gui/src/i18n/de.ts",
  "gui/src/i18n/en.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh-TW.ts",
  "gui/src/i18n/zh.ts",
  "package.json",
  "src/adapters/base.ts",
  "src/adapters/openai-responses.ts",
  "src/server/responses/core.ts",
  "src/usage/log.ts",
  "tests/openai-responses-passthrough.test.ts",
  "tests/update-stop-first.test.ts",
] as const;

const EXPECTED_AUTO_MERGES = EXPECTED_OVERLAPS.filter(path => path !== "package.json");
const EXPECTED_V238_OVERLAP_PATHS = [
  "bin/ocx.mjs",
  "gui/src/i18n/de.ts",
  "gui/src/i18n/en.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh-TW.ts",
  "gui/src/i18n/zh.ts",
  "package.json",
  "src/codex/catalog/provider-fetch.ts",
  "src/codex/catalog/sync.ts",
  "src/config.ts",
  "src/server/management/provider-routes.ts",
  "src/update/index.ts",
  "structure/04_transports-and-sidecars.md",
] as const;
const EXPECTED_V238_CONFLICT_PATHS = ["package.json"] as const;
const EXPECTED_PACKAGE_DECISION = {
  official: "version 2.38.0",
  fork: "install:local script",
  resolution: "双方保留并收敛为 2.38.0-ben.2",
  tests: "tests/release-version-line.test.ts,tests/fork-version-policy.test.ts",
} as const;
const EXPECTED_DEV_PROMOTION = "发布瞬间当前已验证 dev 与 main/sync/Fork Tag 收敛到 RELEASE_COMMIT；发布后 advanced dev 不得被自动重置回旧 RELEASE_COMMIT";
const EXPECTED_V238_KEYS = [
  "official_old",
  "official_new",
  "candidate_branch",
  "candidate_before",
  "candidate_after",
  "overlap_path_count",
  "auto_merge_path_count",
  "overlap_paths",
  "content_conflict_count",
  "content_conflicts",
  "decision_package_json",
  "dev_promotion",
  "tests",
] as const;
const EXPECTED_V239_OVERLAP_PATHS = [
  "bin/ocx.mjs",
  "gui/src/i18n/de.ts",
  "gui/src/i18n/en.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh-TW.ts",
  "gui/src/i18n/zh.ts",
  "gui/src/pages/Logs.tsx",
  "package.json",
  "src/adapters/openai-responses.ts",
  "src/codex/catalog/provider-fetch.ts",
  "src/server/responses/encrypted-payload.ts",
  "src/update/index.ts",
  "tests/openai-responses-passthrough.test.ts",
  "tests/responses-state.test.ts",
  "tests/update-stop-first.test.ts",
] as const;
const EXPECTED_V239_CONFLICT_PATHS = ["bin/ocx.mjs", "package.json"] as const;
const EXPECTED_V239_KEYS = [
  "official_old",
  "official_new",
  "candidate_branch",
  "candidate_before",
  "candidate_after",
  "overlap_path_count",
  "auto_merge_path_count",
  "overlap_paths",
  "content_conflict_count",
  "content_conflicts",
  "decision_bin_ocx_mjs",
  "decision_package_json",
  "external_actions",
  "tests",
] as const;
const EXPECTED_V239_BIN_DECISION = "official=hasPendingTeardownIn；fork=forkUpdateDecision；resolution=双方 import 与调用链均保留；tests=tests/fork-version-policy.test.ts,tests/update-stop-first.test.ts";
const EXPECTED_V239_PACKAGE_DECISION = "official=version 2.39.0 与 package 表面；fork=install:local 与 ben 版本策略；resolution=保留官方表面并收敛为 2.39.0-ben.1；tests=tests/fork-version-policy.test.ts";
const EXPECTED_V239_EXTERNAL_ACTIONS = "full_release；rebase 默认要求完成验证、双审和 annotated Fork Tag，再用一次 git push --atomic 同时更新 main、dev、sync/vX.Y.Z、upstream-release、Fork Tag 与官方 Tag，并创建 GitHub Release；仅用户明确叫停时中止";
const EXPECTED_V239_TESTS = "tests/fork-maintenance-truth.test.ts,tests/fork-version-policy.test.ts";
const EXPECTED_V240_OVERLAP_PATHS = [
  ".github/workflows/dev-version-bump.yml",
  "docs-site/src/content/docs/guides/codex-integration.md",
  "docs-site/src/content/docs/reference/configuration/providers.md",
  "docs-site/src/content/docs/reference/proxy-formats.md",
  "docs-site/src/content/docs/zh-cn/guides/codex-integration.md",
  "docs-site/src/content/docs/zh-cn/reference/configuration/providers.md",
  "gui/src/i18n/de.ts",
  "gui/src/i18n/en.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh-TW.ts",
  "gui/src/i18n/zh.ts",
  "package.json",
  "src/adapters/cursor/request-builder.ts",
  "src/adapters/openai-chat.ts",
  "src/adapters/openai-responses.ts",
  "src/cli/models-runtime.ts",
  "src/cli/models.ts",
  "src/codex/catalog/aggregation.ts",
  "src/codex/catalog/provider-fetch.ts",
  "src/codex/inject.ts",
  "src/config.ts",
  "src/providers/registry.ts",
  "src/router.ts",
  "src/server/auth-cors.ts",
  "src/server/management/model-routes.ts",
  "src/server/management/model-rows.ts",
  "src/server/management/provider-routes.ts",
  "src/server/responses/agent-task-recovery.ts",
  "src/server/responses/core.ts",
  "src/types/provider.ts",
  "src/usage/log.ts",
  "structure/04_transports-and-sidecars.md",
  "tests/bump-dev-version.test.ts",
  "tests/cli-status-json.test.ts",
  "tests/openai-responses-passthrough.test.ts",
  "tests/project-config-warnings.test.ts",
  "tests/responses-state.test.ts",
  "tests/server-auth.test.ts",
  "tests/shutdown-launcher.test.ts",
  "tests/update-stop-first.test.ts",
] as const;
const EXPECTED_V240_CONFLICT_PATHS = [
  "docs-site/src/content/docs/reference/configuration/providers.md",
  "package.json",
  "src/adapters/cursor/request-builder.ts",
  "src/codex/catalog/provider-fetch.ts",
  "src/codex/inject.ts",
  "src/config.ts",
  "src/server/auth-cors.ts",
  "src/server/management/provider-routes.ts",
  "src/server/responses/core.ts",
  "tests/cli-status-json.test.ts",
  "tests/responses-state.test.ts",
  "tests/server-auth.test.ts",
] as const;
const EXPECTED_V240_KEYS = [
  "official_old",
  "official_new",
  "candidate_branch",
  "candidate_before",
  "candidate_after",
  "overlap_path_count",
  "auto_merge_path_count",
  "overlap_paths",
  "content_conflict_count",
  "content_conflicts",
  "conflict_resolution",
  "external_actions",
  "tests",
] as const;
const EXPECTED_V242_OVERLAP_PATHS = [
  "docs-site/src/content/docs/guides/codex-integration.md",
  "docs-site/src/content/docs/guides/providers.md",
  "docs-site/src/content/docs/reference/management-api.md",
  "docs-site/src/content/docs/reference/proxy-formats.md",
  "gui/src/i18n/de.ts",
  "gui/src/i18n/en.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh-TW.ts",
  "gui/src/i18n/zh.ts",
  "gui/src/pages/Logs.tsx",
  "package.json",
  "src/adapters/google.ts",
  "src/adapters/identity.ts",
  "src/adapters/openai-responses.ts",
  "src/cli/registry.ts",
  "src/codex/catalog/aggregation.ts",
  "src/codex/catalog/parsing.ts",
  "src/codex/catalog/provider-fetch.ts",
  "src/codex/inject.ts",
  "src/config.ts",
  "src/lib/app-owned-memory-stores.ts",
  "src/providers/registry.ts",
  "src/server/auth-cors.ts",
  "src/server/chat-native.ts",
  "src/server/management/logs-usage-routes.ts",
  "src/server/management/provider-routes.ts",
  "src/server/responses/core.ts",
  "src/usage/log.ts",
  "tests/ci-workflows.test.ts",
  "tests/codex-catalog.test.ts",
  "tests/memory-watchdog.test.ts",
  "tests/openai-responses-passthrough.test.ts",
  "tests/responses-state.test.ts",
  "tests/shutdown-launcher.test.ts",
] as const;
const EXPECTED_V242_CONFLICT_PATHS = [
  "package.json",
  "src/codex/catalog/provider-fetch.ts",
  "src/lib/app-owned-memory-stores.ts",
  "src/server/auth-cors.ts",
  "src/server/responses/core.ts",
  "tests/ci-workflows.test.ts",
  "tests/codex-catalog.test.ts",
  "tests/shutdown-launcher.test.ts",
] as const;
const EXPECTED_V242_HUNK_IDS = [
  "1506feca25c3046db7a409b0beffdea5d17efc88d02e184ea888926652afa738",
  "2705a63636d9955c82f3bbb2a91568d7e0268cfcd0b85c3aedbae0cb7a1340bc",
  "3765a3564c4bcef605964189ec05920a6850551319d75a527fb359d590904d95",
  "65dbc31f100a0ec7f984efc7740a4f5aa173272a92041c033c0713e76233a3f7",
  "681be6196942eae40ac4bc663495483fe8fb4141a2e40b0c86b2e8fd69f2968e",
  "6f7418b738e24c83ed85e5b0e03f327a73d257a4506f4ae21107d2b49b40060c",
  "7b6b4dfb987fba42c1e653c71c6adf28fa5fdd9bbe878824f0a3e462f30eb33e",
  "d54645903050f445d616521aae7d50497bd94717ed0370dfe26cd834b78092f4",
  "dbd348a5a005af2d4e4275a4149675873124d94db3e010cc11a42e42c3edbdaa",
  "f1efdeafd214de44b9ac73524a34b0f9b1f0df409446dcf4c38661a2891ca38f",
] as const;
const EXPECTED_V242_KEYS = [
  "official_old",
  "official_new",
  "old_official_commit",
  "new_official_commit",
  "pre_rebase_dev",
  "post_rebase_head",
  "candidate_branch",
  "package_version",
  "fork_tag",
  "release_sync_ref",
  "official_changed_path_count",
  "old_fork_net_path_count",
  "old_fork_touched_path_count",
  "net_overlap_path_count",
  "overlap_path_count",
  "content_conflict_count",
  "content_hunk_count",
  "non_overlap_conflict_count",
  "auto_merge_path_count",
  "overlap_paths",
  "content_conflicts",
  "content_hunk_ids",
  "replay_manifest_sha256",
  "shadow_replay",
  "implementation_head",
  "release_commit",
  "verification",
  "reviews",
  "tag_state",
  "atomic_push",
  "github_release",
] as const;
const EXPECTED_V242_CONFLICT_FIELDS = [
  "path",
  "symbols",
  "official_change",
  "fork_change",
  "resolution",
  "official_coverage",
  "downstream_consumers",
  "failure_paths",
  "state_edges",
  "ordering_edges",
  "risk_domains",
  "conflict_snapshots",
  "focused_tests",
  "residual_risk",
] as const;
const EXPECTED_RELEASE_LIFECYCLE = [
  "rebase_branch=dev",
  "rebase_request=full_steps_1_to_15_unless_user_explicitly_stops",
  "sync_role=single-mutable-release-pointer-per-official-baseline",
  "release_instant_dev=must-equal-RELEASE_COMMIT",
  "post_release_advanced_dev=must-not-reset",
  "sync_update=exact-oid-leased-force-to-RELEASE_COMMIT",
  "final_convergence=local-remote-main-dev-RELEASE_SYNC_REF-fork-tag-equal-RELEASE_COMMIT",
].join("\n");
const EXPECTED_RELEASE_LIFECYCLE_KEYS = [
  "rebase_branch",
  "rebase_request",
  "sync_role",
  "release_instant_dev",
  "post_release_advanced_dev",
  "sync_update",
  "final_convergence",
] as const;
const EXPECTED_RELEASE_LIFECYCLE_RECORD = {
  rebase_branch: "dev",
  rebase_request: "full_steps_1_to_15_unless_user_explicitly_stops",
  sync_role: "single-mutable-release-pointer-per-official-baseline",
  release_instant_dev: "must-equal-RELEASE_COMMIT",
  post_release_advanced_dev: "must-not-reset",
  sync_update: "exact-oid-leased-force-to-RELEASE_COMMIT",
  final_convergence: "local-remote-main-dev-RELEASE_SYNC_REF-fork-tag-equal-RELEASE_COMMIT",
} as const;
const EXPECTED_ATOMIC_REFSET = [
  ["branch", "main", "leased-force", "RELEASE_COMMIT:refs/heads/main"],
  ["branch", "dev", "leased-force", "RELEASE_COMMIT:refs/heads/dev"],
  ["branch", "sync", "leased-force", "RELEASE_COMMIT:refs/heads/sync/vX.Y.Z"],
  ["branch", "marker", "leased-force", "OFFICIAL_COMMIT:refs/heads/upstream-release"],
  ["tag", "official", "no-force-no-lease", "refs/tags/vX.Y.Z:refs/tags/vX.Y.Z"],
  ["tag", "fork", "no-force-no-lease", "refs/tags/vX.Y.Z-ben.N:refs/tags/vX.Y.Z-ben.N"],
] as const;
const EXPECTED_SYNC_AUDIT_POLICY_KEYS = [
  "ref_scope",
  "release_sync_ref",
  "revision_specific_ref",
  "initial_creation",
  "existing_update",
  "ancestry_requirement",
  "release_instant",
] as const;
const EXPECTED_SYNC_AUDIT_POLICY = {
  ref_scope: "single-mutable-ref-per-official-baseline",
  release_sync_ref: "refs/heads/sync/vX.Y.Z",
  revision_specific_ref: "forbidden",
  initial_creation: "expected-absent-lease",
  existing_update: "exact-oid-leased-force-allowed",
  ancestry_requirement: "none",
  release_instant: "main-dev-RELEASE_SYNC_REF-fork-tag-equal-RELEASE_COMMIT",
} as const;
const EXPECTED_SAME_BASE_TAG_PREFLIGHT_KEYS = [
  "scope",
  "snapshot",
  "pre_local_tag",
  "pre_push",
  "post_push",
  "higher_revision",
  "other_drift",
  "post_success",
  "serialization",
  "toctou",
] as const;
const EXPECTED_SAME_BASE_TAG_PREFLIGHT = {
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
} as const;
const EXPECTED_LOCAL_REF_CAS_KEYS = [
  "transport",
  "transaction",
  "main_update",
  "sync_update",
  "marker_update",
  "atomicity",
  "sequential_updates",
] as const;
const EXPECTED_LOCAL_REF_CAS = {
  transport: "git-update-ref-stdin",
  transaction: "start-prepare-commit",
  main_update: "refs/heads/main RELEASE_COMMIT EXPECTED_OLD_LOCAL_MAIN",
  sync_update: "refs/heads/sync/vX.Y.Z RELEASE_COMMIT EXPECTED_OLD_LOCAL_SYNC",
  marker_update: "refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER",
  atomicity: "all-or-none",
  sequential_updates: "forbidden",
} as const;
const EXPECTED_SQUASH_POLICY_KEYS = [
  "target_count",
  "task_inputs",
  "content_snapshot",
  "push_attempt",
  "final_commit",
  "same_tree_retry",
  "material_fix",
  "candidate_push",
  "candidate_ci",
  "workflow_security_review",
  "regular_reviews",
  "pre_release_ci",
  "tagged_failure",
  "external_evidence",
] as const;
const EXPECTED_SQUASH_POLICY = {
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
} as const;
const EXPECTED_V240_BEN3_SQUASH_KEYS = [
  "official_base",
  "source_release",
  "source_commit_count",
  "target_commit_count",
  "content_snapshot",
  "manifest_1_sha256",
  "manifest_2_sha256",
  "manifest_3_sha256",
  "manifest_4_sha256",
  "c1",
  "c2",
  "c3",
  "expected_tree",
  "release_commit",
  "candidate_ci",
  "workflow_security_review",
  "regular_reviews",
  "tag",
  "atomic_promotion",
  "main_ci",
  "github_release",
] as const;

const EXPECTED_REBASE_REVIEW_PACKAGE_KEYS = [
  "fixed_shas",
  "path_sets",
  "conflict_ledger",
  "conflict_fields",
  "full_fork_diff",
  "rebase_resolution_diff",
  "post_rebase_fix_diff",
  "spec_recomputation",
  "conflict_reconciliation",
  "review_rounds",
  "review_verdicts",
  "quality_named_risks",
] as const;
const EXPECTED_REBASE_REVIEW_PACKAGE = {
  fixed_shas: "task:OLD_OFFICIAL,NEW_OFFICIAL,PRE_REBASE_DEV,POST_REBASE_HEAD;round:IMPLEMENTATION_HEAD_RN,RELEASE_COMMIT_RN",
  path_sets: "OFFICIAL_CHANGED_PATHS,OLD_FORK_NET_PATHS,OLD_FORK_TOUCHED_PATHS,NET_OVERLAP_PATHS,OVERLAP_PATHS,CONTENT_CONFLICTS,NON_OVERLAP_CONFLICTS,AUTO_MERGES",
  conflict_ledger: "one-entry-per-content-conflict-path",
  conflict_fields: "path,symbols,official_change,fork_change,resolution,official_coverage,downstream_consumers,failure_paths,state_edges,ordering_edges,risk_domains,conflict_snapshots,focused_tests,residual_risk",
  full_fork_diff: "FULL_FORK_DIFF:git-diff-NEW_OFFICIAL-to-RELEASE_COMMIT_RN",
  rebase_resolution_diff: "REBASE_RESOLUTION_DIFF:git-range-diff-OLD_OFFICIAL..PRE_REBASE_DEV-to-NEW_OFFICIAL..POST_REBASE_HEAD",
  post_rebase_fix_diff: "POST_REBASE_FIX_DIFF:git-diff-POST_REBASE_HEAD-to-IMPLEMENTATION_HEAD_RN",
  spec_recomputation: "required-independent-for-endpoint-and-touched-sets",
  conflict_reconciliation: "captured-union-must-equal-isolated-shadow-replay-union",
  review_rounds: "append-only-latest-round-binds-review",
  review_verdicts: "PASS,FAIL",
  quality_named_risks: "required",
} as const;
const EXPECTED_MECHANICAL_RECOMPUTATION_KEYS = [
  "official_changed_paths",
  "old_fork_net_paths",
  "old_fork_touched_paths",
  "net_overlap_paths",
  "overlap_paths",
  "content_conflicts",
  "non_overlap_conflicts",
  "auto_merges",
  "counts",
  "copied_constants",
  "verdict",
] as const;
const EXPECTED_MECHANICAL_RECOMPUTATION = {
  official_changed_paths: "git-diff-name-only-no-renames-OLD_OFFICIAL-to-NEW_OFFICIAL",
  old_fork_net_paths: "git-diff-name-only-no-renames-OLD_OFFICIAL-to-PRE_REBASE_DEV",
  old_fork_touched_paths: "union-of-per-nonmerge-commit-no-renames-paths",
  net_overlap_paths: "OFFICIAL_CHANGED_PATHS-intersect-OLD_FORK_NET_PATHS",
  overlap_paths: "OFFICIAL_CHANGED_PATHS-intersect-OLD_FORK_TOUCHED_PATHS",
  content_conflicts: "captured-union-equals-isolated-shadow-replay-union",
  non_overlap_conflicts: "CONTENT_CONFLICTS-minus-OVERLAP_PATHS-retained-and-explained",
  auto_merges: "OVERLAP_PATHS-minus-CONTENT_CONFLICTS",
  counts: "derived-from-recomputed-sets",
  copied_constants: "forbidden",
  verdict: "SPEC_COMPLIANCE:FAIL-on-missing-or-mismatch",
} as const;
const EXPECTED_REVIEW_ROUND_LIFECYCLE_KEYS = [
  "task_immutable",
  "attempt_id",
  "attempt_state",
  "round_assignment",
  "round_id",
  "review_phase",
  "round_outputs",
  "round_immutability",
  "latest_binding",
  "prior_binding",
  "implementation_change",
] as const;
const EXPECTED_REVIEW_ROUND_LIFECYCLE = {
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
} as const;
const EXPECTED_CONFLICT_SNAPSHOT_KEYS = [
  "per_stop",
  "per_path",
  "resolution_action",
  "commit_mapping",
  "hunk_id",
  "hunk_dedupe",
  "captured_union",
  "replay_environment",
  "shadow_clone",
  "object_access",
  "shadow_replay",
  "shadow_match",
  "mismatch_verdict",
] as const;
const EXPECTED_CONFLICT_SNAPSHOT = {
  per_stop: "rebase-step,REBASE_HEAD,resolution-action,resolved-index-tree,post-action-HEAD-tree",
  per_path: "path,stage1-mode-blob,stage2-mode-blob,stage3-mode-blob,combined-diff,stage0-mode-blob-or-deleted",
  resolution_action: "continue-created-commit,skip-empty,continue-kept-empty",
  commit_mapping: "REBASE_HEAD-to-replayed-commit-or-dropped-with-reason",
  hunk_id: "sha256-rebase-step-REBASE_HEAD-path-stage-mode-blobs-normalized-hunk",
  hunk_dedupe: "exact-hunk-id-only",
  captured_union: "all-unresolved-paths-from-all-stops",
  replay_environment: "pre-rebase-git-version-invocation-config-attributes-and-rerere-disabled",
  shadow_clone: "created-before-main-rebase-and-preserves-PRE_REBASE_DEV",
  object_access: "shared-source-objects-cat-file-verified-before-replay",
  shadow_replay: "isolated-temp-clone-fixed-task-shas-recorded-resolutions",
  shadow_match: "actions-mappings-stops-paths-hunk-ids-produced-trees-and-final-tree-must-equal-before-review",
  mismatch_verdict: "SPEC_COMPLIANCE:FAIL",
} as const;
const EXPECTED_REBASE_NAMED_RISK_KEYS = [
  "final_consumers",
  "nullish_values",
  "failure_paths",
  "stream_ordering",
  "rebuild_parity",
  "round_trip",
  "capability_reachability",
  "minimal_official_diff",
] as const;
const EXPECTED_REBASE_NAMED_RISKS = {
  final_consumers: "secondary-defaulting-and-final-projection",
  nullish_values: "undefined,absent,null,false,empty",
  failure_paths: "abort,retry-exhausted,one-shot,timeout,body-ceiling,resource-release",
  stream_ordering: "sparse,out-of-order,duplicate,terminal,flush,dispose",
  rebuild_parity: "initial-build-versus-rebuild",
  round_trip: "schema,load,POST,PATCH,GET,DTO,persistence,runtime-consumer",
  capability_reachability: "official-and-fork-capabilities-remain-reachable",
  minimal_official_diff: "required-per-file-necessity-and-no-unrelated-change",
} as const;
const EXPECTED_REBASE_REVIEW_ESCALATION_KEYS = [
  "default_reviewers",
  "sensitive_scope",
  "sensitive_identifiers",
  "sensitive_scan",
  "shared_entrypoints",
  "conflict_hunk_count",
  "explorer_trigger",
  "explorer_scope",
  "boundary_set",
  "cross_boundary_edges",
  "third_reviewer_trigger",
  "third_reviewer_mode",
  "third_reviewer_scope",
  "generic_reviewer_expansion",
] as const;
const EXPECTED_REBASE_REVIEW_ESCALATION = {
  default_reviewers: "SPEC_COMPLIANCE,CODE_QUALITY",
  sensitive_scope: "exact-path-or-sensitive-substring-in-all-diff-hunks-and-ledger-symbols",
  sensitive_identifiers: "auth,oauth,credential,token,secret,api-key,apikey,keyring",
  sensitive_scan: "case-insensitive-conservative-no-comment-or-string-exclusion",
  shared_entrypoints: "src/router.ts,src/server/lifecycle.ts,src/server/responses/core.ts,src/codex/inject.ts",
  conflict_hunk_count: "unique-hunk-id-count",
  explorer_trigger: "sensitive-scope-or-shared-entrypoint-or-5-plus-conflict-paths-or-10-plus-unique-hunks",
  explorer_scope: "evidence-only-no-verdict",
  boundary_set: "runtime,config,persistence,ui,release",
  cross_boundary_edges: "consumer-chain-edges-not-category-count",
  third_reviewer_trigger: "cross-boundary-edge-or-explorer-unresolved-risk",
  third_reviewer_mode: "CODE_QUALITY",
  third_reviewer_scope: "exact-cross-boundary-paths-symbols-and-edges-only",
  generic_reviewer_expansion: "forbidden",
} as const;

const EXPECTED_V236_CONFLICT_PATHS = [
  "package.json",
  "src/adapters/openai-responses.ts",
  "src/config.ts",
  "src/lib/upstream-retry.ts",
  "src/server/responses/core.ts",
] as const;

const EXPECTED_V236_OVERLAP_PATHS = [
  "docs-site/src/content/docs/reference/configuration/providers.md",
  "docs-site/src/content/docs/zh-cn/reference/configuration/providers.md",
  "gui/src/i18n/de.ts",
  "gui/src/i18n/en.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh-TW.ts",
  "gui/src/i18n/zh.ts",
  "gui/src/pages/Logs.tsx",
  "package.json",
  "src/adapters/openai-responses.ts",
  "src/config.ts",
  "src/lib/upstream-retry.ts",
  "src/providers/registry.ts",
  "src/server/auth-cors.ts",
  "src/server/chat-native.ts",
  "src/server/management/provider-routes.ts",
  "src/server/responses-undeclared-tool-guard.ts",
  "src/server/responses/agent-task-recovery.ts",
  "src/server/responses/core.ts",
  "src/types/provider.ts",
  "tests/openai-responses-passthrough.test.ts",
] as const;

function machineBlock(source: string, name: string): string {
  const match = source.match(new RegExp(
    `<!-- ${name}:start -->\n([\\s\\S]*?)\n<!-- ${name}:end -->`,
  ));
  expect(match, `missing ${name} machine block`).not.toBeNull();
  return match![1]!;
}

function strictKeyValueBlock(
  source: string,
  name: string,
  expectedKeys: readonly string[],
): Record<string, string> {
  expect([...source.matchAll(new RegExp(`<!-- ${name}:start -->`, "g"))]).toHaveLength(1);
  expect([...source.matchAll(new RegExp(`<!-- ${name}:end -->`, "g"))]).toHaveLength(1);
  const lines = machineBlock(source, name).split("\n");
  if (lines.some(line => line.length === 0)) throw new Error(`${name} contains a blank row`);
  const entries: Array<[string, string]> = lines.map((line) => {
    const match = line.match(/^([a-z0-9_]+)=(.+)$/);
    if (!match) throw new Error(`invalid ${name} row: ${line}`);
    return [match[1]!, match[2]!];
  });
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length) throw new Error(`${name} contains a duplicate key`);
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${name} keys differ from the exact contract`);
  }
  return Object.fromEntries(entries);
}

function strictSquashPolicy(source: string): Record<string, string> {
  const parsed = strictKeyValueBlock(
    source,
    "fork-squash-release-policy",
    EXPECTED_SQUASH_POLICY_KEYS,
  );
  if (JSON.stringify(parsed) !== JSON.stringify(EXPECTED_SQUASH_POLICY)) {
    throw new Error("fork squash release policy differs from the exact contract");
  }
  return parsed;
}

function parsePackageDecision(value: string): Record<string, string> {
  const expectedKeys = Object.keys(EXPECTED_PACKAGE_DECISION);
  const entries: Array<[string, string]> = value.split("；").map((part) => {
    const match = part.match(/^([a-z_]+)=(.+)$/);
    if (!match) throw new Error(`invalid package decision part: ${part}`);
    return [match[1]!, match[2]!];
  });
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length) throw new Error("package decision contains a duplicate key");
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error("package decision keys differ from the exact contract");
  }
  const parsed = Object.fromEntries(entries);
  if (JSON.stringify(parsed) !== JSON.stringify(EXPECTED_PACKAGE_DECISION)) {
    throw new Error("package decision values differ from the exact contract");
  }
  return parsed;
}

function strictReleaseLifecycle(source: string): string {
  const parsed = strictKeyValueBlock(source, "fork-release-lifecycle", EXPECTED_RELEASE_LIFECYCLE_KEYS);
  if (JSON.stringify(parsed) !== JSON.stringify(EXPECTED_RELEASE_LIFECYCLE_RECORD)) {
    throw new Error("release lifecycle values differ from the exact contract");
  }
  return machineBlock(source, "fork-release-lifecycle");
}

function strictSameBaseTagPreflight(source: string): Record<string, string> {
  const parsed = strictKeyValueBlock(
    source,
    "same-base-ben-preflight",
    EXPECTED_SAME_BASE_TAG_PREFLIGHT_KEYS,
  );
  if (JSON.stringify(parsed) !== JSON.stringify(EXPECTED_SAME_BASE_TAG_PREFLIGHT)) {
    throw new Error("same-base ben preflight values differ from the exact contract");
  }
  return parsed;
}

function strictLocalRefCas(source: string): Record<string, string> {
  const parsed = strictKeyValueBlock(
    source,
    "local-ref-cas-transaction",
    EXPECTED_LOCAL_REF_CAS_KEYS,
  );
  if (JSON.stringify(parsed) !== JSON.stringify(EXPECTED_LOCAL_REF_CAS)) {
    throw new Error("local ref CAS transaction differs from the exact contract");
  }
  return parsed;
}

function strictSyncAuditPolicy(source: string): Record<string, string> {
  const parsed = strictKeyValueBlock(
    source,
    "sync-audit-ref-policy",
    EXPECTED_SYNC_AUDIT_POLICY_KEYS,
  );
  if (JSON.stringify(parsed) !== JSON.stringify(EXPECTED_SYNC_AUDIT_POLICY)) {
    throw new Error("sync audit ref policy differs from the exact contract");
  }
  return parsed;
}

function strictRebaseReviewContract(source: string): void {
  const blocks = [
    ["rebase-review-package", EXPECTED_REBASE_REVIEW_PACKAGE_KEYS, EXPECTED_REBASE_REVIEW_PACKAGE],
    ["mechanical-recomputation", EXPECTED_MECHANICAL_RECOMPUTATION_KEYS, EXPECTED_MECHANICAL_RECOMPUTATION],
    ["review-round-lifecycle", EXPECTED_REVIEW_ROUND_LIFECYCLE_KEYS, EXPECTED_REVIEW_ROUND_LIFECYCLE],
    ["conflict-snapshot-contract", EXPECTED_CONFLICT_SNAPSHOT_KEYS, EXPECTED_CONFLICT_SNAPSHOT],
    ["rebase-conflict-named-risks", EXPECTED_REBASE_NAMED_RISK_KEYS, EXPECTED_REBASE_NAMED_RISKS],
    ["rebase-review-escalation", EXPECTED_REBASE_REVIEW_ESCALATION_KEYS, EXPECTED_REBASE_REVIEW_ESCALATION],
  ] as const;

  for (const [name, keys, expected] of blocks) {
    const parsed = strictKeyValueBlock(source, name, keys);
    if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
      throw new Error(`${name} values differ from the exact contract`);
    }
  }
}

function containsSensitiveReviewEvidence(value: string): boolean {
  return /(auth|oauth|credential|token|secret|api[_-]?key|apikey|keyring)/i.test(value);
}

function isConflictResolutionAction(value: string): boolean {
  return ["continue-created-commit", "skip-empty", "continue-kept-empty"].includes(value);
}

function backtickedPaths(lines: string[]): string[] {
  return lines.map((line) => {
    const match = line.match(/^- `([^`]+)`$/);
    expect(match, `invalid path row: ${line}`).not.toBeNull();
    return match![1]!;
  });
}

function section(title: string): string {
  const start = changes.indexOf(`### ${title}\n`);
  expect(start, `missing section ${title}`).toBeGreaterThanOrEqual(0);
  const next = changes.slice(start + 1).search(/\n#{1,3} /);
  return next === -1 ? changes.slice(start) : changes.slice(start, start + 1 + next);
}

function majorSection(title: string): string {
  const start = changes.indexOf(`## ${title}\n`);
  expect(start, `missing section ${title}`).toBeGreaterThanOrEqual(0);
  const next = changes.slice(start + 1).search(/\n## /);
  return next === -1 ? changes.slice(start) : changes.slice(start, start + 1 + next);
}

function parseAtomicRefset(block: string): string[][] {
  const lines = block.split("\n");
  if (lines.some(line => line.length === 0)) throw new Error("atomic refset contains a blank row");
  const rows = lines.map((line) => {
    const fields = line.split("|");
    if (fields.length !== 4 || fields.some(field => !field)) {
      throw new Error(`invalid atomic refset row: ${line}`);
    }
    return fields;
  });
  if (rows.length !== 6) throw new Error("atomic refset must contain exactly six rows");
  if (JSON.stringify(rows) !== JSON.stringify(EXPECTED_ATOMIC_REFSET)) {
    throw new Error("atomic refset differs from the exact main/dev/sync/marker/Fork-Tag/official-Tag contract");
  }
  for (const [kind, name, policy, refspec] of rows) {
    if (kind === "branch" && !policy.startsWith("leased-")) throw new Error(`${name} branch is not leased`);
    if (kind === "tag" && policy !== "no-force-no-lease") throw new Error(`${name} tag policy is invalid`);
    if (kind === "tag" && refspec.startsWith("+")) throw new Error(`${name} tag refspec is forced`);
  }
  return rows;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

describe("Fork maintenance truth", () => {
  test("records the exact current ben package version and preserves historical ben.2 overlap truth", () => {
    const version = JSON.parse(packageText).version;
    expect(version).toMatch(/^\d+\.\d+\.\d+-ben\.\d+$/);
    expect(changes).toContain(`| Fork 包版本 | \`${version}\` |`);
    expect(changes).toContain(`| 本轮派生 Tag | \`v${version}\``);
    expect(changes).toContain("16 paths");
    expect(changes).not.toContain("当前为\n  `2.34.0-ben.2`");

    const lines = machineBlock(changes, "ben2-overlap").split("\n");
    expect(lines[0]).toBe("Conflict (1):");
    const autoMerge = lines.indexOf("Auto-merge (15):");
    expect(autoMerge).toBe(3);
    expect(lines.slice(1, autoMerge)).toEqual(["- `package.json`", ""]);

    const conflicts = backtickedPaths(lines.slice(1, autoMerge).filter(Boolean));
    const merges = backtickedPaths(lines.slice(autoMerge + 1));
    const union = [...conflicts, ...merges].sort();

    expect(conflicts).toEqual(["package.json"]);
    expect(merges).toEqual(EXPECTED_AUTO_MERGES);
    expect(union).toEqual(EXPECTED_OVERLAPS);
    expect(conflicts).toHaveLength(1);
    expect(merges).toHaveLength(15);
    expect(union).toHaveLength(16);
  });

  test("preserves the v2.40.0-ben.3 four-commit audit as historical evidence", () => {
    const rows = strictKeyValueBlock(changes, "v240-ben3-squash", EXPECTED_V240_BEN3_SQUASH_KEYS);
    expect(rows).toEqual({
      official_base: "35ff3a462e786bd5efc394dfb1a8a5cc946e454f",
      source_release: "569f0e7b7d3388758b05553fda9ba2a13208433f",
      source_commit_count: "10",
      target_commit_count: "4",
      content_snapshot: expect.stringMatching(/^S[1-9][0-9]*$/),
      manifest_1_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      manifest_2_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      manifest_3_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      manifest_4_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      c1: expect.stringMatching(/^[0-9a-f]{40}$/),
      c2: expect.stringMatching(/^[0-9a-f]{40}$/),
      c3: expect.stringMatching(/^[0-9a-f]{40}$/),
      expected_tree: "external-task-evidence",
      release_commit: "docs-only-current-head",
      candidate_ci: "pending external gate",
      workflow_security_review: "pending external gate",
      regular_reviews: "pending external gate",
      tag: "pending external gate",
      atomic_promotion: "pending external gate",
      main_ci: "pending external gate",
      github_release: "pending external gate",
    });
  });

  test("records the exact v2.42.0 rebase inputs, replay reconciliation, and per-conflict ledger", () => {
    expect(JSON.parse(packageText).version).toBe("2.42.0-ben.1");
    const rows = strictKeyValueBlock(changes, "v242-rebase", EXPECTED_V242_KEYS);
    expect(rows).toMatchObject({
      official_old: "v2.40.0",
      official_new: "v2.42.0",
      old_official_commit: "35ff3a462e786bd5efc394dfb1a8a5cc946e454f",
      new_official_commit: "48f8186647d9ffb108d226dcfa91a64225aae2a7",
      pre_rebase_dev: "1aae7085e32e86e7043d0280b0097119a1e1e726",
      post_rebase_head: "6032e2cc5e131febda1a8d5c328e3323095ac7d3",
      candidate_branch: "dev",
      package_version: "2.42.0-ben.1",
      fork_tag: "v2.42.0-ben.1",
      release_sync_ref: "refs/heads/sync/v2.42.0",
      official_changed_path_count: "476",
      old_fork_net_path_count: "204",
      old_fork_touched_path_count: "204",
      net_overlap_path_count: "38",
      overlap_path_count: "38",
      content_conflict_count: "8",
      content_hunk_count: "10",
      non_overlap_conflict_count: "0",
      auto_merge_path_count: "30",
      replay_manifest_sha256: "20380ff5b865d9da8c676482acb5258b9d8ebeda281d390d6a1e1f5cbe774b59",
      shadow_replay: "pass-exact-commit-tree-stops-paths-stages-hunks-actions",
      implementation_head: expect.stringMatching(/^[0-9a-f]{40}$/),
      release_commit: "docs-only-current-head",
      verification: expect.stringMatching(/^(pending|pass)-/),
      reviews: "pending",
      tag_state: "pending",
      atomic_push: "pending",
      github_release: "pending",
    });

    const overlaps = rows.overlap_paths.split(",");
    const conflicts = rows.content_conflicts.split(",");
    const hunks = rows.content_hunk_ids.split(",");
    expect(overlaps).toEqual(EXPECTED_V242_OVERLAP_PATHS);
    expect(conflicts).toEqual(EXPECTED_V242_CONFLICT_PATHS);
    expect(hunks).toEqual(EXPECTED_V242_HUNK_IDS);
    expect(new Set(overlaps).size).toBe(38);
    expect(new Set(conflicts).size).toBe(8);
    expect(new Set(hunks).size).toBe(10);
    for (const path of conflicts) expect(overlaps).toContain(path);

    for (const path of EXPECTED_V242_CONFLICT_PATHS) {
      const id = path.replaceAll("/", "_").replaceAll(".", "_").replaceAll("-", "_");
      const ledger = strictKeyValueBlock(changes, `v242-conflict-${id}`, EXPECTED_V242_CONFLICT_FIELDS);
      expect(ledger.path).toBe(path);
      for (const field of EXPECTED_V242_CONFLICT_FIELDS.slice(1)) {
        const value = ledger[field];
        expect(value, `${path} missing ${field}`).toBeDefined();
        expect(value!.trim(), `${path} has empty ${field}`).not.toBe("");
        if (value!.startsWith("n/a")) expect(value).toMatch(/^n\/a:.+/);
      }
      expect(ledger.conflict_snapshots).toMatch(/step=[13];REBASE_HEAD=[0-9a-f]{40};hunk_ids=[0-9a-f]{64}/);
    }
  });

  test("records the current v2.36 rebase conflict decisions separately from the historical ben.1 overlap", () => {
    const current = machineBlock(changes, "v236-rebase-conflicts");
    const rows = Object.fromEntries(current.split("\n").map((line) => {
      const match = line.match(/^([a-z0-9_]+)=(.+)$/);
      expect(match, `invalid v236-rebase-conflicts row: ${line}`).not.toBeNull();
      return [match![1]!, match![2]!];
    }));

    expect(rows.official_old).toBe("v2.35.0");
    expect(rows.official_new).toBe("v2.36.0");
    expect(rows.overlap_path_count).toBe("25");
    expect(rows.content_conflict_count).toBe("5");
    const overlapPaths = rows.overlap_paths?.split(",");
    expect(overlapPaths).toEqual(EXPECTED_V236_OVERLAP_PATHS);
    expect(new Set(overlapPaths).size).toBe(25);
    expect(rows.content_conflicts?.split(",")).toEqual(EXPECTED_V236_CONFLICT_PATHS);
    for (const path of EXPECTED_V236_CONFLICT_PATHS) expect(overlapPaths).toContain(path);

    for (const path of EXPECTED_V236_CONFLICT_PATHS) {
      const key = `decision_${path.replaceAll("/", "_").replaceAll(".", "_").replaceAll("-", "_")}`;
      const decision = rows[key];
      expect(decision, `missing v2.36 decision for ${path}`).toBeDefined();
      expect(decision).toContain("official=");
      expect(decision).toContain("fork=");
      expect(decision).toContain("resolution=");
      expect(decision).toContain("tests=");
    }

    expect(changes.indexOf("<!-- ben2-overlap:start -->")).toBeGreaterThan(current.indexOf("official_old=v2.35.0"));
  });

  test("records the complete current v2.38 overlap and conflict account", () => {
    const rows = strictKeyValueBlock(changes, "v238-rebase", EXPECTED_V238_KEYS);

    expect(rows.official_old).toBe("v2.37.0");
    expect(rows.official_new).toBe("v2.38.0");
    expect(rows.candidate_branch).toBe("dev");
    expect(rows.candidate_before).toBe("09fbd1453fa2c374d5d0e9cad9ae15cf86cf7e8f");
    expect(rows.candidate_after).toBe("fac328f9465b4ce17abddf7fec2df006c9a58aa0");
    expect(rows.overlap_path_count).toBe("17");
    expect(rows.auto_merge_path_count).toBe("16");
    expect(rows.content_conflict_count).toBe("1");
    const overlapPaths = rows.overlap_paths?.split(",");
    expect(overlapPaths).toEqual(EXPECTED_V238_OVERLAP_PATHS);
    expect(new Set(overlapPaths).size).toBe(17);
    expect(rows.content_conflicts?.split(",")).toEqual(EXPECTED_V238_CONFLICT_PATHS);
    for (const path of EXPECTED_V238_CONFLICT_PATHS) expect(overlapPaths).toContain(path);
    expect(parsePackageDecision(rows.decision_package_json)).toEqual(EXPECTED_PACKAGE_DECISION);
    expect(rows.dev_promotion).toBe(EXPECTED_DEV_PROMOTION);
    expect(rows.tests).toBe("tests/fork-maintenance-truth.test.ts,tests/fork-version-policy.test.ts,tests/fork-ci-official-baseline.test.ts");
  });

  test("rejects ambiguous or incomplete current rebase machine blocks", () => {
    const valid = machineBlock(changes, "v238-rebase");
    const wrap = (block: string) => `<!-- v238-rebase:start -->\n${block}\n<!-- v238-rebase:end -->`;
    expect(() => strictKeyValueBlock(wrap(`${valid}\nofficial_old=v2.37.0`), "v238-rebase", EXPECTED_V238_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(wrap(`${valid}\nunknown=value`), "v238-rebase", EXPECTED_V238_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(wrap(valid.replace(/^tests=.+$/m, "")), "v238-rebase", EXPECTED_V238_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(`${wrap(valid)}\n${wrap(valid)}`, "v238-rebase", EXPECTED_V238_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(wrap(valid.replace("official_new=v2.38.0", "official_new=v2.38.0\n")), "v238-rebase", EXPECTED_V238_KEYS)).toThrow();
    const decision = `official=${EXPECTED_PACKAGE_DECISION.official}；fork=${EXPECTED_PACKAGE_DECISION.fork}；resolution=${EXPECTED_PACKAGE_DECISION.resolution}；tests=${EXPECTED_PACKAGE_DECISION.tests}`;
    expect(() => parsePackageDecision(`${decision}；official=wrong`)).toThrow();
    expect(() => parsePackageDecision(decision.replace("version 2.38.0", "wrong"))).toThrow();
    expect(() => {
      const altered = strictKeyValueBlock(
        wrap(valid.replace(EXPECTED_DEV_PROMOTION, "发布瞬间允许 advanced dev；发布后自动重置")),
        "v238-rebase",
        EXPECTED_V238_KEYS,
      );
      if (altered.dev_promotion !== EXPECTED_DEV_PROMOTION) throw new Error("invalid dev promotion contract");
    }).toThrow();
  });

  test("records the complete current v2.39 overlap and conflict account", () => {
    const rows = strictKeyValueBlock(changes, "v239-rebase", EXPECTED_V239_KEYS);
    expect(rows.official_old).toBe("v2.38.0");
    expect(rows.official_new).toBe("v2.39.0");
    expect(rows.candidate_branch).toBe("dev");
    expect(rows.candidate_before).toBe("1092cfb48b2e8f478c21e3fa9daf09bb002e7bef");
    expect(rows.candidate_after).toBe("6835e7ea163144c52d520231ed6df2830a9dac5d");
    expect(rows.overlap_path_count).toBe("19");
    expect(rows.auto_merge_path_count).toBe("17");
    expect(rows.content_conflict_count).toBe("2");
    const overlapPaths = rows.overlap_paths?.split(",");
    expect(overlapPaths).toEqual(EXPECTED_V239_OVERLAP_PATHS);
    expect(new Set(overlapPaths).size).toBe(19);
    expect(rows.content_conflicts?.split(",")).toEqual(EXPECTED_V239_CONFLICT_PATHS);
    for (const path of EXPECTED_V239_CONFLICT_PATHS) expect(overlapPaths).toContain(path);
    expect(rows.decision_bin_ocx_mjs).toBe(EXPECTED_V239_BIN_DECISION);
    expect(rows.decision_package_json).toBe(EXPECTED_V239_PACKAGE_DECISION);
    expect(rows.external_actions).toBe(EXPECTED_V239_EXTERNAL_ACTIONS);
    expect(rows.tests).toBe(EXPECTED_V239_TESTS);
  });

  test("rejects ambiguous or incomplete v2.39 rebase machine blocks", () => {
    const valid = machineBlock(changes, "v239-rebase");
    const wrap = (block: string) => `<!-- v239-rebase:start -->\n${block}\n<!-- v239-rebase:end -->`;
    const assertSemantics = (source: string) => {
      const rows = strictKeyValueBlock(source, "v239-rebase", EXPECTED_V239_KEYS);
      expect(rows.decision_bin_ocx_mjs).toBe(EXPECTED_V239_BIN_DECISION);
      expect(rows.decision_package_json).toBe(EXPECTED_V239_PACKAGE_DECISION);
      expect(rows.external_actions).toBe(EXPECTED_V239_EXTERNAL_ACTIONS);
      expect(rows.tests).toBe(EXPECTED_V239_TESTS);
    };
    expect(() => strictKeyValueBlock(wrap(`${valid}\nofficial_old=v2.38.0`), "v239-rebase", EXPECTED_V239_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(wrap(`${valid}\nunknown=value`), "v239-rebase", EXPECTED_V239_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(wrap(valid.replace(/^tests=.+$/m, "")), "v239-rebase", EXPECTED_V239_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(`${wrap(valid)}\n${wrap(valid)}`, "v239-rebase", EXPECTED_V239_KEYS)).toThrow();
    expect(() => assertSemantics(wrap(valid.replace(EXPECTED_V239_BIN_DECISION, EXPECTED_V239_BIN_DECISION.replace("双方 import 与调用链均保留", "只保留官方"))))).toThrow();
    expect(() => assertSemantics(wrap(valid.replace(EXPECTED_V239_EXTERNAL_ACTIONS, "none；未授权 Tag，但 push 已发生")))).toThrow();
    expect(() => assertSemantics(wrap(valid.replace(EXPECTED_V239_TESTS, "tests/fork-maintenance-truth.test.ts")))).toThrow();
  });

  test("records the complete current v2.40 overlap and conflict account", () => {
    const rows = strictKeyValueBlock(changes, "v240-rebase", EXPECTED_V240_KEYS);
    expect(rows.official_old).toBe("v2.39.0");
    expect(rows.official_new).toBe("v2.40.0");
    expect(rows.candidate_branch).toBe("dev");
    expect(rows.candidate_before).toBe("b5d4694b1de65c9c2faf9adc063ed8b5719fb9a9");
    expect(rows.candidate_after).toBe("91ae57de114dae18842e44067563db4493525b30");
    expect(rows.overlap_path_count).toBe("44");
    expect(rows.auto_merge_path_count).toBe("32");
    expect(rows.content_conflict_count).toBe("12");
    expect(rows.overlap_paths?.split(",")).toEqual(EXPECTED_V240_OVERLAP_PATHS);
    expect(rows.content_conflicts?.split(",")).toEqual(EXPECTED_V240_CONFLICT_PATHS);
    expect(rows.conflict_resolution).toContain("官方 v2.40.0");
    expect(rows.conflict_resolution).toContain("Fork");
    expect(rows.external_actions).toBe(EXPECTED_V239_EXTERNAL_ACTIONS);
    expect(rows.tests).toBe(EXPECTED_V239_TESTS);
  });

  test("records the ben.3 39-to-5 squash boundary and pending external gates", () => {
    const block = machineBlock(changes, "ben3-squash");
    const rows = Object.fromEntries(block.split("\n").map((line) => {
      const match = line.match(/^([a-z0-9_]+)=(.+)$/);
      expect(match, `invalid ben3-squash row: ${line}`).not.toBeNull();
      return [match![1]!, match![2]!];
    }));

    expect(rows).toEqual({
      source_tag: "v2.35.0-ben.2",
      source_peeled: "42282c405dc4c3dcb4f1e2877b89ac6ab49eeaba",
      source_tree: "8499fcec058d61a42a4fa382118e4c7f92bbff58",
      source_commit_count: "39",
      squashed_commit_count: "5",
      c1: "4d91209a587a7dbc970cd179a14ce7cf21ec1642",
      c2: "7a35c99ec2529aac4fd011733b1617164248023b",
      c3: "b67df10538bd77556c72d12c3ea6167175049a79",
      c3_shared_tree: "8499fcec058d61a42a4fa382118e4c7f92bbff58",
      c3_shared_path_count: "112",
      c3_new_document_paths: "docs/superpowers/plans/2026-08-29-v2350-ben3-squash.md,docs/superpowers/specs/2026-08-29-v2350-ben3-squash-design.md",
      c3_total_delta_path_count: "114",
      c4: "fba9eadce2535cae6e76efee02695e9050262829",
      ben2_history: "immutable",
      ben3_annotated_tag: "pending external gate",
      candidate_cross_platform_ci: "pending external gate",
      atomic_promotion: "pending external gate",
      final_main_cross_platform_ci: "pending external gate",
      github_release: "pending external gate",
    });

    const squash = majorSection("v2.35.0-ben.3 全量历史压缩与发布边界");
    expect(squash).toContain("39 个线性");
    expect(squash).toContain("恰好 5 个语义提交");
    expect(squash).toContain("112 个共享路径逐 blob 等于 ben.2 tree");
    expect(squash).toContain("共有 114 个路径");
    expect(squash).toContain("保持不可变，不移动、不删除、不重建");
    expect(squash).toContain("尚未发生");
  });

  test("leaves external tagged-snapshot gates explicitly pending", () => {
    const block = machineBlock(changes, "ben2-external-gates");
    const lines = block.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "| Gate | Tagged snapshot state |",
      "| --- | --- |",
    ]);

    const rows = Object.fromEntries(lines.slice(2).map((line) => {
      const match = line.match(/^\| (.+) \| `(.+)` \|$/);
      expect(match, `invalid external-gate row: ${line}`).not.toBeNull();
      return [match![1]!, match![2]!];
    }));
    expect(rows).toEqual({
      "S2R candidate Cross-platform CI": "pending external gate",
      "发布用 `git push --atomic`": "pending external gate",
      "Final main Cross-platform CI": "pending external gate",
      "GitHub Release": "pending external gate",
    });
    expect(block).not.toMatch(/https?:\/\//);
    expect(block).not.toMatch(/\brun\s+#?\d+/i);
    expect(block).not.toMatch(/\b(?:success|passed|completed)\b/i);
  });

  test("records the complete S2R candidate chain and preserved official Tags", () => {
    const block = machineBlock(changes, "ben2-s2r");
    const normalized = compactWhitespace(block);

    expect(normalized).toContain("`d5558096bb229b5fbf5607a6468c2871b2b1213e`");
    expect(normalized).toContain("`33234936660`");
    expect(normalized).toContain("`Prepare verified Fork official base`");
    expect(normalized).toContain("annotated-only");
    expect(normalized).toContain("type=`commit`");
    expect(normalized).toContain(
      "raw=peeled=marker=`fc4de772b58c13f7b16b5029b1e981d612a5db06`",
    );
    expect(normalized).toContain("`d252cb0e0ed67789c62d9aad5d2308aa5d04889b`");
    expect(normalized).toContain("`33236405510`");
    expect(normalized).toContain("official-base preparation 在 Linux/macOS 全部通过");
    expect(normalized).toContain("verifier-oracle");
    expect(normalized).toContain("process-wide verifier-root namespace为空");
    expect(normalized).toContain("`5548eb2a0d71d84bee03a4fa8424750bfdc78b85`");
    expect(normalized).toContain("`33236921544`");
    expect(normalized).toContain("成功但不可复用于新的 descendant");
    expect(normalized).toContain("Fork origin 对每个已 rebase 的官方版本保留同名官方 Tag");
    expect(normalized).toContain("`v2.34.0`");
    expect(normalized).toContain("raw=peeled=`80fff9a7f47332a4445df2b26ea175053fa55b0b`");
    expect(normalized).toContain("`v2.35.0`");
    expect(normalized).toContain("raw=peeled=`fc4de772b58c13f7b16b5029b1e981d612a5db06`");
    expect(normalized).toContain("同一次 `git push --atomic` 中补齐");

    for (const gate of [
      "v2.35.0-ben.2 Tag",
      "发布用 `git push --atomic`",
      "Final main Cross-platform CI",
      "GitHub Release",
    ]) {
      expect(normalized).toContain(`${gate}：未发生`);
    }

    const gates = machineBlock(changes, "ben2-external-gates");
    expect(gates).toContain("| S2R candidate Cross-platform CI | `pending external gate` |");
    expect(gates).toContain("| 发布用 `git push --atomic` | `pending external gate` |");
    expect(gates).toContain("| Final main Cross-platform CI | `pending external gate` |");
    expect(gates).toContain("| GitHub Release | `pending external gate` |");
  });

  test("requires the exact main/dev/sync/marker/Fork-Tag/official-Tag atomic refset in every release contract", () => {
    const flows = [
      majorSection("没有新官方版本时的幂等收敛"),
      majorSection("每次稳定版 rebase 的强制流程"),
      automation,
    ];

    for (const flow of flows) {
      expect([...flow.matchAll(/<!-- official-atomic-refset:start -->/g)]).toHaveLength(1);
      expect([...flow.matchAll(/<!-- official-atomic-refset:end -->/g)]).toHaveLength(1);
      const block = machineBlock(flow, "official-atomic-refset");
      expect(parseAtomicRefset(block)).toEqual(EXPECTED_ATOMIC_REFSET);
      expect(strictReleaseLifecycle(flow)).toBe(EXPECTED_RELEASE_LIFECYCLE);
      expect(strictSyncAuditPolicy(flow)).toEqual(EXPECTED_SYNC_AUDIT_POLICY);
      expect(strictLocalRefCas(flow)).toEqual(EXPECTED_LOCAL_REF_CAS);
    }
  });

  test("uses one leased-force sync pointer for every release on an official baseline", () => {
    expect(strictSyncAuditPolicy(automation)).toEqual(EXPECTED_SYNC_AUDIT_POLICY);
    expect(automation).toContain("`sync/vX.Y.Z`");
    expect(automation).toContain("精确 expected-OID lease");
    expect(automation).toContain("允许 non-fast-forward");
    expect(automation).not.toContain("maintenance_revision_ref=refs/heads/sync/vX.Y.Z-ben.N");
    expect(localRules).toContain("禁止创建 `sync/vX.Y.Z-ben.N`");
    expect(changes).not.toContain("release_sync_ref=refs/heads/sync/v2.40.0-ben.2");
    expect(machineBlock(changes, "v240-ben2-candidate")).toContain(
      "release_sync_ref=refs/heads/sync/v2.40.0",
    );

    expect(() => strictSyncAuditPolicy(automation.replace(
      "revision_specific_ref=forbidden",
      "revision_specific_ref=allowed",
    ))).toThrow();
    expect(() => strictSyncAuditPolicy(automation.replace(
      "existing_update=exact-oid-leased-force-allowed",
      "existing_update=fast-forward-only",
    ))).toThrow();
    expect(() => strictSyncAuditPolicy(automation.replace(
      "ancestry_requirement=none",
      "ancestry_requirement=required",
    ))).toThrow();
  });

  test("freezes the complete same-base Fork Tag namespace before maintenance publication", () => {
    const flows = [
      majorSection("没有新官方版本时的幂等收敛"),
      majorSection("每次稳定版 rebase 的强制流程"),
      automation,
      repairPlan,
    ];
    for (const flow of flows) {
      expect(strictSameBaseTagPreflight(flow)).toEqual(EXPECTED_SAME_BASE_TAG_PREFLIGHT);
    }

    const valid = machineBlock(automation, "same-base-ben-preflight");
    const duplicate = `${automation}\n<!-- same-base-ben-preflight:start -->\n${valid}\n<!-- same-base-ben-preflight:end -->`;
    expect(() => strictSameBaseTagPreflight(duplicate)).toThrow();
    expect(() => strictSameBaseTagPreflight(automation.replace(
      "local-baseline-plus-exact-target-and-remote-baseline",
      "local-baseline-plus-any-target-and-remote-baseline",
    ))).toThrow();
  });

  test("updates local main, sync, and upstream-release atomically with captured old OIDs", () => {
    const flows = [
      majorSection("没有新官方版本时的幂等收敛"),
      majorSection("每次稳定版 rebase 的强制流程"),
      automation,
    ];
    for (const flow of flows) {
      expect(strictLocalRefCas(flow)).toEqual(EXPECTED_LOCAL_REF_CAS);
    }
    expect([...automation.matchAll(/严格按 `local-ref-cas-transaction`/g)]).toHaveLength(2);

    expect(() => strictLocalRefCas(automation.replace(
      "transaction=start-prepare-commit",
      "transaction=sequential-updates",
    ))).toThrow();
    expect(() => strictLocalRefCas(automation.replace(
      "refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER",
      "refs/heads/upstream-release OFFICIAL_COMMIT",
    ))).toThrow();
    expect(() => strictLocalRefCas(automation.replace(
      "refs/heads/sync/vX.Y.Z RELEASE_COMMIT EXPECTED_OLD_LOCAL_SYNC",
      "refs/heads/sync/vX.Y.Z RELEASE_COMMIT",
    ))).toThrow();

    const audit = majorSection("最小可复现审计命令");
    expect(audit).toContain("update refs/heads/main RELEASE_COMMIT EXPECTED_OLD_LOCAL_MAIN");
    expect(audit).toContain("update refs/heads/sync/vX.Y.Z RELEASE_COMMIT EXPECTED_OLD_LOCAL_SYNC");
    expect(audit).toContain("update refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER");
    expect(audit).toContain("git rev-parse refs/heads/upstream-release");
    expect(audit).toContain("git ls-remote origin refs/heads/upstream-release");
  });

  test("keeps every squash release at its task-fixed commit count until CI and Release", () => {
    const flows = [
      majorSection("没有新官方版本时的幂等收敛"),
      majorSection("每次稳定版 rebase 的强制流程"),
      automation,
      localRules,
    ];
    for (const flow of flows) {
      expect(strictSquashPolicy(flow)).toEqual(EXPECTED_SQUASH_POLICY);
    }
    expect(automation).toContain("同一 peeled SHA 的成功 candidate CI 和 main CI");

    const valid = machineBlock(automation, "fork-squash-release-policy");
    expect(() => strictSquashPolicy(automation.replace(
      "target_count=task-fixed-N-ge-2",
      "target_count=mutable-N",
    ))).toThrow();
    expect(() => strictSquashPolicy(automation.replace(
      "same_tree_retry=amend-CN-attempt-marker-no-N-plus-1",
      "same_tree_retry=amend-CN-attempt-marker-append-N-plus-1",
    ))).toThrow();
    expect(() => strictSquashPolicy(automation.replace(
      "pre_release_ci=exact-dev-candidate-and-main-ci-success-same-CN-sha",
      "pre_release_ci=exact-dev-candidate-and-main-ci-success-any-prior-ci-success",
    ))).toThrow();
    expect(valid).toContain("external_evidence=task-and-release-notes-not-candidate-tree");
  });

  test("requires a mechanically recomputable, conflict-by-conflict rebase review package", () => {
    expect(() => strictRebaseReviewContract(automation)).not.toThrow();
    expect(localRules).toContain("docs/fork-sync-automation.md");
    expect(localRules).toContain("逐冲突证据账本");
    expect(localRules).toContain("命名风险清单");

    const packageBlock = machineBlock(automation, "rebase-review-package");
    expect(packageBlock).toContain("FULL_FORK_DIFF");
    expect(packageBlock).toContain("REBASE_RESOLUTION_DIFF");
    expect(packageBlock).toContain("POST_REBASE_FIX_DIFF");
    expect(automation).toContain("现有 `pre-push` hook");
    expect(automation).toContain("不能证明双审通过");

    expect(() => strictRebaseReviewContract(automation.replace(
      "copied_constants=forbidden",
      "copied_constants=allowed",
    ))).toThrow();
    expect(() => strictRebaseReviewContract(automation.replace(
      "conflict_ledger=one-entry-per-content-conflict-path",
      "conflict_ledger=summary-only",
    ))).toThrow();
    expect(() => strictRebaseReviewContract(automation.replace(
      "third_reviewer_scope=exact-cross-boundary-paths-symbols-and-edges-only",
      "third_reviewer_scope=full-diff-again",
    ))).toThrow();
    expect(() => strictRebaseReviewContract(automation.replace(
      "round_immutability=append-only-never-overwrite",
      "round_immutability=overwrite-latest",
    ))).toThrow();
    expect(() => strictRebaseReviewContract(automation.replace(
      "hunk_dedupe=exact-hunk-id-only",
      "hunk_dedupe=path-only",
    ))).toThrow();
    expect(() => strictRebaseReviewContract(automation.replace(
      "stage0-mode-blob-or-deleted",
      "resolved-stage0-blob",
    ))).toThrow();
    expect(() => strictRebaseReviewContract(automation.replace(
      "continue-created-commit,skip-empty,continue-kept-empty",
      "continue-created-commit",
    ))).toThrow();
    expect(() => strictRebaseReviewContract(automation.replace(
      "pre-rebase-git-version-invocation-config-attributes-and-rerere-disabled",
      "post-rebase-best-effort-config",
    ))).toThrow();
    expect(() => strictRebaseReviewContract(automation.replace(
      "sensitive-substring-in-all-diff-hunks-and-ledger-symbols",
      "sensitive-token-in-conflict-ledger-only",
    ))).toThrow();
    expect(() => strictRebaseReviewContract(automation.replace(
      "review_verdicts=PASS,FAIL",
      "review_verdicts=Approved,Needs-Changes",
    ))).toThrow();
    expect(automation).toContain("尚无轮次时创建 `R1`");
    expect(automation).toContain("当前最大 `N + 1`");
    expect(automation).not.toContain("以 `R1` 捕获固定");
    expect(automation).toContain("验证失败的 `AK`");
    expect(automation).toContain("不得占用 `RN`");
    expect(containsSensitiveReviewEvidence("+ const apiKey = resolveProvider();")).toBeTrue();
    expect(containsSensitiveReviewEvidence("tokenProvider")).toBeTrue();
    expect(containsSensitiveReviewEvidence("ordinaryCatalogField")).toBeFalse();
    expect(isConflictResolutionAction("continue-created-commit")).toBeTrue();
    expect(isConflictResolutionAction("skip-empty")).toBeTrue();
    expect(isConflictResolutionAction("continue-kept-empty")).toBeTrue();
    expect(isConflictResolutionAction("forced-empty-commit")).toBeFalse();
    expect(automation).not.toContain("结论必须为 Needs Changes");
    expect(automation).not.toContain("（Approved）");
  });

  test("rejects duplicate or contradictory release lifecycle blocks", () => {
    const valid = machineBlock(automation, "fork-release-lifecycle");
    const duplicate = `${automation}\n<!-- fork-release-lifecycle:start -->\n${valid.replace("must-not-reset", "may-reset")}\n<!-- fork-release-lifecycle:end -->`;
    expect(() => strictReleaseLifecycle(duplicate)).toThrow();
  });

  test("rejects atomic refsets with an extra row, missing lease, or forced Tag", () => {
    const valid = EXPECTED_ATOMIC_REFSET.map(row => row.join("|")).join("\n");
    expect(() => parseAtomicRefset(`${valid}\nbranch|extra|leased|extra:refs/heads/extra`)).toThrow();
    expect(() => parseAtomicRefset(valid.replace("branch|main|leased", "branch|main|unleased"))).toThrow();
    expect(() => parseAtomicRefset(valid.replace(
      "tag|official|no-force-no-lease|refs/tags/vX.Y.Z:refs/tags/vX.Y.Z",
      "tag|official|no-force-no-lease|+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z",
    ))).toThrow();
    expect(() => parseAtomicRefset(valid.replace("\nbranch|dev", "\n\nbranch|dev"))).toThrow();
  });

  test("keeps dev as the rebase line and sync as the audit ref", () => {
    expect(automation).toContain("git rebase --onto <new-tag-sha> <old-upstream-release-sha> dev");
    expect(automation).not.toContain("git rebase --onto <new-tag-sha> <old-upstream-release-sha> sync/vX.Y.Z");
    expect(automation).toContain("RELEASE_COMMIT");
    expect(automation).toContain("OFFICIAL_COMMIT");
    expect(automation).not.toContain('git merge-base --is-ancestor "$EXPECTED_REMOTE_RELEASE_SYNC" "$RELEASE_COMMIT"');
    expect(automation).toContain("本地/远端 `main`、`dev`、`RELEASE_SYNC_REF`");
    expect(automation).toContain("post_release_advanced_dev=must-not-reset");
  });

  test("grounds every active official comparison in v2.42.0 evidence", () => {
    const evidence = {
      "火山方舟 Agent Plan GLM/Kimi 与智谱 GLM Responses 兼容": [
        "`v2.42.0:src/adapters/openai-responses.ts`（blob `d9ec1fb01ab8dd36c99179c1fd1f12073ad84654`）",
        `\`src/fork/glm-kimi-compat.ts\`（blob \`${currentGitBlob("src/fork/glm-kimi-compat.ts")}\`）`,
        `\`tests/fork-volcengine-empty-assistant-content.test.ts\`（blob \`${currentGitBlob("tests/fork-volcengine-empty-assistant-content.test.ts")}\`）`,
      ],
      "Ark quota 在 Codex Desktop 中的展示": [
        "`v2.42.0:src/adapters/openai-responses.ts`（blob `d9ec1fb01ab8dd36c99179c1fd1f12073ad84654`）",
        `\`src/fork/ark-quota-display.ts\`（blob \`${currentGitBlob("src/fork/ark-quota-display.ts")}\`）`,
        `\`tests/fork-ark-weekly-quota.test.ts\`（blob \`${currentGitBlob("tests/fork-ark-weekly-quota.test.ts")}\`）`,
      ],
      "自定义模型配置、工具模式与公开投影": [
        "`v2.42.0:src/config.ts`（blob `6cd87ef29f0e06a0d0980fab26b20080243975e3`）",
        `\`src/config/custom-models.ts\`（blob \`${currentGitBlob("src/config/custom-models.ts")}\`）`,
        `\`src/config.ts\`（blob \`${currentGitBlob("src/config.ts")}\`）`,
        `\`src/server/management/model-routes.ts\`（blob \`${currentGitBlob("src/server/management/model-routes.ts")}\`）`,
        `\`tests/fork-custom-model-config-schema.test.ts\`（blob \`${currentGitBlob("tests/fork-custom-model-config-schema.test.ts")}\`）`,
        `\`tests/fork-custom-model-tool-mode-contract.test.ts\`（blob \`${currentGitBlob("tests/fork-custom-model-tool-mode-contract.test.ts")}\`）`,
      ],
      "本地源码包安装": [
        "`v2.42.0:package.json`（blob `6c7c80d9e471282778d67df6c7bacfe511278cdb`）",
        `\`scripts/install-local-vendor.ts\`（blob \`${currentGitBlob("scripts/install-local-vendor.ts")}\`）`,
        `\`scripts/install-local.ts\`（blob \`${currentGitBlob("scripts/install-local.ts")}\`）`,
        `\`tests/fork-install-local-staging.test.ts\`（blob \`${currentGitBlob("tests/fork-install-local-staging.test.ts")}\`）`,
        `\`tests/fork-install-local-manifest-lifecycle.test.ts\`（blob \`${currentGitBlob("tests/fork-install-local-manifest-lifecycle.test.ts")}\`）`,
        `\`tests/fork-install-local-guard-recovery.test.ts\`（blob \`${currentGitBlob("tests/fork-install-local-guard-recovery.test.ts")}\`）`,
      ],
      "GUI Logs/Debug 恢复标签与 sidecar 契约": [
        "`v2.42.0:gui/src/pages/Logs.tsx`（blob `0bbe286a887d6f811c9243d53e544cf4928700cd`）",
        `\`gui/src/pages/Logs.tsx\`（blob \`${currentGitBlob("gui/src/pages/Logs.tsx")}\`）`,
        "`v2.42.0:gui/src/pages/Debug.tsx`（blob `05207fbb9097dc665c94fdef24d665782ac2f9ce`）",
        `\`gui/src/pages/Debug.tsx\`（blob \`${currentGitBlob("gui/src/pages/Debug.tsx")}\`）`,
        `\`gui/src/i18n/de.ts\`（blob \`${currentGitBlob("gui/src/i18n/de.ts")}\`）`,
        `\`gui/src/i18n/en.ts\`（blob \`${currentGitBlob("gui/src/i18n/en.ts")}\`）`,
        `\`gui/src/i18n/fr.ts\`（blob \`${currentGitBlob("gui/src/i18n/fr.ts")}\`）`,
        `\`gui/src/i18n/ja.ts\`（blob \`${currentGitBlob("gui/src/i18n/ja.ts")}\`）`,
        `\`gui/src/i18n/ko.ts\`（blob \`${currentGitBlob("gui/src/i18n/ko.ts")}\`）`,
        `\`gui/src/i18n/ru.ts\`（blob \`${currentGitBlob("gui/src/i18n/ru.ts")}\`）`,
        `\`gui/src/i18n/tr.ts\`（blob \`${currentGitBlob("gui/src/i18n/tr.ts")}\`）`,
        `\`gui/src/i18n/zh-TW.ts\`（blob \`${currentGitBlob("gui/src/i18n/zh-TW.ts")}\`）`,
        `\`gui/src/i18n/zh.ts\`（blob \`${currentGitBlob("gui/src/i18n/zh.ts")}\`）`,
        "`gui/tests/sidecar-layout.test.ts`（blob `e140a627260bbf952708e7f710874a5f76cc5b2b`，与官方 v2.42.0 相同）",
      ],
      "`ben` Fork 修订版本策略": [
        "`v2.42.0:package.json`（blob `6c7c80d9e471282778d67df6c7bacfe511278cdb`）",
        `\`src/fork/version-policy.mjs\`（blob \`${currentGitBlob("src/fork/version-policy.mjs")}\`）`,
        `\`tests/fork-version-policy.test.ts\`（blob \`${currentGitBlob("tests/fork-version-policy.test.ts")}\`）`,
      ],
      "Standalone web search 能力注入": [
        "`v2.42.0:src/codex/inject.ts`（blob `cb8e1434b39dc03867734ed9683b76ee37c4ee89`）",
        `当前实现的 \`src/codex/inject.ts\` blob 为 \`${currentGitBlob("src/codex/inject.ts")}\``,
      ],
      "智谱 BigModel Codex 模型发现": [
        "`v2.42.0:src/providers/model-discovery.ts`（blob `ada0bd2aecc196e003d0b1720c96d864e4793dbc`）",
        `\`src/providers/model-discovery.ts\`（blob \`${currentGitBlob("src/providers/model-discovery.ts")}\`）`,
        `\`tests/zhipu-bigmodel-codex-provider.test.ts\`（blob \`${currentGitBlob("tests/zhipu-bigmodel-codex-provider.test.ts")}\`）`,
      ],
      "默认测试 runner 与负载敏感隔离": [
        "`v2.42.0:tests/update-stop-first.test.ts`（blob `95b6bd53daf1ef37b0fd2044aad8909cb0657355`）",
        `\`src/responses/state.ts\`（blob \`${currentGitBlob("src/responses/state.ts")}\`）`,
        `\`tests/responses-state.test.ts\`（blob \`${currentGitBlob("tests/responses-state.test.ts")}\`）`,
        `\`tests/shutdown-launcher.test.ts\`（blob \`${currentGitBlob("tests/shutdown-launcher.test.ts")}\`）`,
      ],
      "Prepush 与 GitHub CI": [],
    } as const;
    for (const [title, anchors] of Object.entries(evidence)) {
      const active = section(title);
      expect(active).toContain("v2.42.0");
      expect(active).not.toContain("v2.34.0");
      for (const anchor of anchors) expect(compactWhitespace(active)).toContain(anchor);
    }
  });

  test("binds active mutable-file anchors to the current Git blob identity", () => {
    const paths = [
      "gui/src/pages/Logs.tsx",
      "gui/src/pages/Debug.tsx",
      "gui/src/i18n/de.ts",
      "gui/src/i18n/en.ts",
      "gui/src/i18n/fr.ts",
      "gui/src/i18n/ja.ts",
      "gui/src/i18n/ko.ts",
      "gui/src/i18n/ru.ts",
      "gui/src/i18n/tr.ts",
      "gui/src/i18n/zh-TW.ts",
      "gui/src/i18n/zh.ts",
      "src/responses/state.ts",
      "tests/responses-state.test.ts",
      "tests/shutdown-launcher.test.ts",
    ] as const;
    for (const path of paths) {
      expect(compactWhitespace(changes)).toContain(
        compactWhitespace(`\`${path}\`（blob \`${currentGitBlob(path)}\``),
      );
    }
  });

  test("separates Fork strict backend recovery from the current official recovery surface", () => {
    const recovery = section("原生加密子任务恢复接力");
    expect(compactWhitespace(recovery)).toContain(
      "`v2.42.0:src/server/responses/agent-task-recovery.ts`（blob `e1c35932ff4610251364078bbcb966f97465157b`）",
    );
    expect(recovery).not.toContain("官方恢复模块（`agent-task-recovery.ts`）扩展了 strict backend ciphertext 的 envelope 识别");
    expect(compactWhitespace(recovery)).toContain("Fork 行为：strict non-Fernet envelope recognition、admission、routed trigger 与 fail-closed forwarding");
    expect(compactWhitespace(recovery)).toContain("官方 `v2.42.0` 仍只覆盖 turn termination 与通用 recovery admission");
  });
});

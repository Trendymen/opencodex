# v2.38 Fork Important Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user selected inline execution in the current workspace; do not create a worktree or dispatch implementers.

**Goal:** Produce a reviewable `2.38.0-ben.2` candidate from `94ed4ca95` that repairs every confirmed Important finding without losing official v2.38 or verified Fork behavior.

**Architecture:** Keep every repair inside its owning narrow boundary: rebase/release contracts in their canonical documents and contract test, Ark quota parsing in the existing Fork module, custom-model normalization in a new shared config module, packaging isolation in the existing local-vendor helper, and GUI repair in the defective test only. Each task follows RED/GREEN, commits by functional boundary, and receives independent review before the final ben.2 snapshot and trailing maintenance document are created.

**Tech Stack:** Bun 1.4, TypeScript 7, Zod 4, Bun test, npm pack/install, React/Vite GUI tests, Git.

**Spec:** `docs/superpowers/specs/2026-09-01-v238-fork-important-repairs-design.md`

## Global Constraints

- Start from `94ed4ca95612c2f640127fb61ac1330449258dd6` on the current `dev` workspace; preserve unrelated concurrent/user edits.
- Official comparison refs are `v2.37.0=54e2274c`, `v2.38.0=ebb4d552e`, and pre-rebase Fork `09fbd1453`.
- Do not reuse, cherry-pick, or restore discarded candidates `01917463f` or `ee4a6f56f`.
- Do not create a worktree, tag, push, move refs, publish a Release, install/replace global OpenCodex, or restart/repair a service.
- Keep official v2.38 behavior and every verified Fork behavior unless current source and tests prove equivalent official coverage.
- New Fork behavior uses dedicated new `tests/fork-*.test.ts` files. Existing tests may be edited only where the confirmed defect is in that test or the contract itself must change.
- Production and test changes precede the final `IMPLEMENTATION_HEAD`; the trailing `RELEASE_COMMIT` changes only `FORK_CHANGES.md`.
- Commit messages are Chinese and grouped by independently understandable functional boundaries.
- `docs/fork-sync-automation.md` is the operational topology authority. `FORK_CHANGES.md` and tests must mirror it.
- Packaging/release/security changes require an additional independent security review.
- Every Critical or Important review finding blocks; re-review reuses the same reviewer and mode.

---

### Task 1: Correct the v2.38 rebase ledger and release topology contract

**Files:**
- Modify: `tests/fork-maintenance-truth.test.ts`
- Modify: `docs/fork-sync-automation.md`
- Modify: `FORK_CHANGES.md`
- Add to this functional commit: `docs/superpowers/specs/2026-09-01-v238-fork-important-repairs-design.md`
- Add to this functional commit: `docs/superpowers/plans/2026-09-01-v238-fork-important-repairs.md`

**Interfaces:**
- Consumes: fixed refs and the approved six-member contract from the Spec.
- Produces: `v238-rebase` machine block; identical six-row `official-atomic-refset` blocks; canonical `IMPLEMENTATION_HEAD`, `RELEASE_COMMIT`, and `OFFICIAL_COMMIT` terminology.

- [ ] **Step 1: Extend the contract test first**

Add exact constants near the existing historical arrays:

```ts
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

const EXPECTED_ATOMIC_REFSET = [
  ["branch", "main", "leased-force", "RELEASE_COMMIT:refs/heads/main"],
  ["branch", "dev", "leased-force", "RELEASE_COMMIT:refs/heads/dev"],
  ["branch", "sync", "leased-fast-forward", "RELEASE_COMMIT:refs/heads/sync/vX.Y.Z"],
  ["branch", "marker", "leased-force", "OFFICIAL_COMMIT:refs/heads/upstream-release"],
  ["tag", "official", "no-force-no-lease", "refs/tags/vX.Y.Z:refs/tags/vX.Y.Z"],
  ["tag", "fork", "no-force-no-lease", "refs/tags/vX.Y.Z-ben.N:refs/tags/vX.Y.Z-ben.N"],
] as const;
```

Add a test that parses `machineBlock(changes, "v238-rebase")`, requires `17/16/1`, exact ordered paths, conflict subset, old/new refs, and the package decision. Update `parseAtomicRefset()` to require six rows and verify each policy. Add source assertions that `docs/fork-sync-automation.md` says rebase on `dev`, does not say rebase on `sync/vX.Y.Z`, and contains the same six-row block.

- [ ] **Step 2: Run RED**

Run:

```bash
bun test --isolate tests/fork-maintenance-truth.test.ts
```

Expected: FAIL because the current `v238-rebase` block says 6 overlap paths, the generic refset has five rows, and the canonical document still contains contradictory branch timing.

- [ ] **Step 3: Update the canonical topology document**

Edit `docs/fork-sync-automation.md` so every generic flow uses:

```text
IMPLEMENTATION_HEAD = final implementation/test/version commit
RELEASE_COMMIT = trailing FORK_CHANGES-only commit
OFFICIAL_COMMIT = peeled official stable tag commit
```

Require rebase on `dev`; local/remote `sync` is an audit/release ref. Replace the old refset with the approved six rows. State that this task performs no ref movement. Explain release-instant `dev` publication separately from the ban on resetting a later advanced `dev`.

- [ ] **Step 4: Update the maintenance truth**

Edit `FORK_CHANGES.md` current v2.38 prose and machine block to record 17 overlap paths, 16 automatic merges, the sole `package.json` conflict, and the semantic conclusion that official/Fork behavior survived all 17 paths. Update both generic release flows and both machine refsets to mirror `docs/fork-sync-automation.md` exactly. Do not yet claim final ben.2 implementation SHA or final verification.

- [ ] **Step 5: Run GREEN and static checks**

Run:

```bash
bun test --isolate tests/fork-maintenance-truth.test.ts tests/fork-ci-official-baseline.test.ts
git diff --check
```

Expected: all selected tests pass and `git diff --check` produces no output.

- [ ] **Step 6: Commit the functional contract repair**

```bash
git add tests/fork-maintenance-truth.test.ts docs/fork-sync-automation.md FORK_CHANGES.md \
  docs/superpowers/specs/2026-09-01-v238-fork-important-repairs-design.md \
  docs/superpowers/plans/2026-09-01-v238-fork-important-repairs.md
git diff --cached --check
git commit -m "fix(fork): 对齐 v2.38 变基与发布契约"
```

- [ ] **Step 7: Review Task 1**

Dispatch independent `SPEC_COMPLIANCE` and `CODE_QUALITY` reviewers with only this task's requirements, `94ed4ca95..HEAD` scoped diff, and real test output. Add a separate security-focused reviewer because release topology changes are security-sensitive. Fix and re-review every Critical/Important finding before Task 2.

---

### Task 2: Recognize the observed Ark weekly usage quota

**Files:**
- Create: `tests/fork-ark-weekly-quota.test.ts`
- Modify: `src/fork/ark-quota-display.ts`

**Interfaces:**
- Consumes: `arkQuotaClientError(bodyText: string)` and existing passthrough behavior.
- Produces: closed matcher accepting no-window, numeric-hour, and weekly quota windows.

- [ ] **Step 1: Write the failing dedicated test**

Create tests that call the real function:

```ts
import { describe, expect, test } from "bun:test";
import { arkQuotaClientError } from "../src/fork/ark-quota-display";

const body = (message: string, code = "QuotaExhausted") =>
  JSON.stringify({ error: { message, code } });

describe("Fork Ark weekly quota compatibility", () => {
  test("accepts no-window, numeric-hour, and weekly quota forms", () => {
    for (const prefix of [
      "You have exceeded the usage quota.",
      "You have exceeded the 5-hour usage quota.",
      "You have exceeded the weekly usage quota.",
    ]) {
      expect(arkQuotaClientError(body(
        `${prefix} It will reset at 2026-09-08 10:00:00 +0800 CST. Request id: redacted`,
      ))).toMatchObject({ status: 400 });
    }
  });

  test("keeps the accepted window vocabulary closed", () => {
    for (const window of ["monthly", "week", "rolling-weekly"]) {
      expect(arkQuotaClientError(body(`You have exceeded the ${window} usage quota. It will reset at 2026-09-08 10:00:00 +0800 CST.`))).toBeUndefined();
    }
  });

  test("does not remap usage_limit_reached or ordinary overloads", () => {
    expect(arkQuotaClientError(body("Your usage limit has been reached", "usage_limit_reached"))).toBeUndefined();
    expect(arkQuotaClientError(body("vendor overloaded"))).toBeUndefined();
    expect(arkQuotaClientError("not-json")).toBeUndefined();
    expect(arkQuotaClientError(body("You have exceeded the weekly usage quota. It will reset tomorrow."))).toBeUndefined();
  });
});
```

The same file asserts `rendersArkQuotaAsClientError("volcengine-agent-plan") === true` and a
non-target provider returns false, so the new regression is self-contained.

- [ ] **Step 2: Run RED**

```bash
bun test --isolate tests/fork-ark-weekly-quota.test.ts
```

Expected: the weekly positive case fails; no-window/hour positives and negative cases pass.

- [ ] **Step 3: Implement the minimal matcher change**

Replace only the optional window fragment in `arkQuotaClientError`:

```ts
const QUOTA_WINDOW = /(?:(?:\d+-hour|weekly) )?/;
```

Use a single anchored regex or an escaped string construction that accepts exactly the Spec forms while retaining the strict reset timestamp. Do not change status mapping, error body, provider gate, or retry logic.

- [ ] **Step 4: Run GREEN**

```bash
bun test --isolate tests/fork-ark-weekly-quota.test.ts tests/fork-latest-compat.test.ts tests/fork-ark-quota-error.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit and review**

```bash
git add src/fork/ark-quota-display.ts tests/fork-ark-weekly-quota.test.ts
git diff --cached --check
git commit -m "fix(volcengine): 识别 weekly usage quota"
```

Run Task 2 `SPEC_COMPLIANCE` and `CODE_QUALITY` review; reuse reviewers after fixes.

---

### Task 3: Add deterministic `customModels` load salvage and strict write validation

**Files:**
- Create: `src/config/custom-models.ts`
- Create: `tests/fork-custom-model-config-schema.test.ts`
- Modify: `src/config.ts`

**Interfaces:**
- Produces:

```ts
export type CustomModelSalvageResult = Readonly<{
  value: OcxCustomModel[] | undefined;
  changed: boolean;
  droppedRows: number;
  changedFields: number;
}>;

export function salvageCustomModelsForLoad(value: unknown): CustomModelSalvageResult;
export function customModelsCandidateError(value: unknown): string | null;
export function knownCustomModelProjection(model: OcxCustomModel): OcxCustomModel;
```

- Consumes: `OcxCustomModel`, `canonicalizeReasoningEfforts`, declared effort validation, input-modality vocabulary, and `routedSlug`.

- [ ] **Step 1: Write RED tests for the pure contract**

Cover:

```ts
expect(salvageCustomModelsForLoad("bad").value).toBeUndefined();
expect(salvageCustomModelsForLoad([badRow, goodRow]).value).toEqual([canonicalGoodRow]);
expect(salvageCustomModelsForLoad([firstId, duplicateId, duplicateSlug]).value).toEqual([firstId]);
expect(salvageCustomModelsForLoad([{ ...goodRow, reasoningEfforts: ["high", "low", "high"] }]).value?.[0]?.reasoningEfforts).toEqual(["low", "high"]);
expect(customModelsCandidateError([{ ...goodRow, codexToolMode: null }])).toContain("codexToolMode");
```

Add temp-CODEX_HOME integration cases proving `loadConfig()` does not rewrite malformed disk bytes,
diagnostics contain one aggregate warning without raw ids, an authorized later mutation persists the
stable projection, and strict `validateConfigCandidate()` rejects malformed rows. Seed and assert
preservation of providers, API keys, account/selectors used by the fixture, port, hostname, and
`unauthenticatedLoopbackListener`.

Add an interleaving case: load a salvageable config, write a later hand edit to disk that changes an
unrelated provider/account/listener field, then persist an authorized mutation through the long-lived
loaded config. Assert the existing config rebase/conflict policy preserves or rejects the later edit
instead of overwriting it from stale memory. Reload after success and require the same custom-model
projection. Strict whole-config rejection must leave every unrelated section above unchanged.

- [ ] **Step 2: Run RED**

```bash
bun test --isolate tests/fork-custom-model-config-schema.test.ts
```

Expected: module/import or behavior failures because the helper and explicit boundary do not exist.

- [ ] **Step 3: Implement the narrow shared module**

Implement the approved field table. Preserve unknown keys in the internal config object by starting a surviving row with `{ ...record }`, then overwrite/delete known fields according to salvage. Keep first valid ID and first `routedSlug(provider, modelId)` in original order. Apply `canonicalizeReasoningEfforts()` after filtering valid declared efforts. Return `undefined` for zero survivors.

`knownCustomModelProjection()` must construct fields explicitly and must not spread the input.

- [ ] **Step 4: Wire forgiving reads and strict writes separately**

In `configSchema`, add only:

```ts
customModels: z.unknown().optional(),
```

Before both `configSchema.safeParse()` calls in `loadConfig()` and the file-diagnostics path, call a memory-only sanitizer that replaces the parsed raw field with `salvageCustomModelsForLoad(...).value` and records one aggregate warning. Do not write the file.

In `validateConfigCandidate()`, add `customModelsCandidateError(value)` to the existing boundary-error chain before `configSchema.safeParse()`. Whole-config `null`, malformed rows, duplicates, invalid enum values, and cross-field inconsistencies must return `ok: false`.

- [ ] **Step 5: Run GREEN and regression tests**

```bash
bun test --isolate tests/fork-custom-model-config-schema.test.ts \
  tests/config.test.ts tests/custom-model-catalog-migration.test.ts \
  tests/config-user-edits.test.ts
```

Expected: all pass; no disk mutation on read.

- [ ] **Step 6: Commit and review**

```bash
git add src/config/custom-models.ts src/config.ts tests/fork-custom-model-config-schema.test.ts
git diff --cached --check
git commit -m "fix(config): 安全收敛 customModels 配置"
```

Run Task 3 `SPEC_COMPLIANCE` and `CODE_QUALITY` review.

---

### Task 4: Complete stored `codexToolMode` API/CLI/DTO round trips

**Files:**
- Create: `tests/fork-custom-model-tool-mode-contract.test.ts`
- Modify: `src/config/custom-models.ts`
- Modify: `src/server/management/model-routes.ts`
- Modify: `src/server/management/model-rows.ts`
- Modify: `src/cli/models.ts`
- Modify: `src/cli/models-runtime.ts`

**Interfaces:**
- Consumes: `knownCustomModelProjection()` and strict enum contract from Task 3.
- Produces: known-field-only public rows; POST/PUT tool-mode persistence; CLI `--tool-mode` parsing.

- [ ] **Step 1: Write RED management contract tests**

Use the existing direct `handleModelRoutes` pattern from catalog input-modality tests. Cover:

```text
POST omitted -> stored field absent
POST code_mode_only/shell -> stored and returned
POST null/invalid -> 400, no persistence, no converge call
PUT absent -> preserve
PUT enum -> set
PUT null -> delete property
PUT invalid -> 400, no persistence, no converge call
GET /api/custom-models -> known fields only
/api/models custom row -> stored value only
secret-shaped unknown config keys -> absent from every response
```

Persist an internal row containing `apiKey`, `headers`, and `futureOpaque`. Prove those unknown keys
survive the approved whole-config save/reload path, then prove they are absent from GET/POST/PUT
custom-model responses, `/api/models`, `list-custom` JSON/text, `models live --json`, and dashboard
safe-config output. Add assertions that `codexToolMode` did not enter `ExportModel`,
`/api/client-config`, third-party serializers, or generated client files. Reload after PUT-null and
require the property to be omitted. Spy on persistence and catalog convergence for POST-null, strict
whole-config null, and invalid enums; both call counts must stay zero.

Add CLI cases for add/edit/inherit, canonical reasoning order, `list-custom --json`, text `inherit`, and `models live --json` custom rows.

- [ ] **Step 2: Run RED**

```bash
bun test --isolate tests/fork-custom-model-tool-mode-contract.test.ts
```

Expected: POST/PUT ignore tool mode, management rows omit it, and CLI rejects the new flag.

- [ ] **Step 3: Implement management projections and writes**

For GET/POST/PUT responses use `knownCustomModelProjection()`. Parse tool mode before any mutation:

```ts
type StoredToolMode = "code_mode_only" | "shell";

function readPostedToolMode(value: unknown, present: boolean):
  | { ok: true; value?: StoredToolMode }
  | { ok: false; error: string };

function readPatchedToolMode(value: unknown, present: boolean):
  | { ok: true; action: "preserve" | "clear" | "set"; value?: StoredToolMode }
  | { ok: false; error: string };
```

Only call `persistConfig()` and `convergeCodexCatalog()` after validation succeeds. Add optional `codexToolMode` to `ManagementModelRow`; custom rows use the stored value, not provider effective value.

- [ ] **Step 4: Implement CLI flags**

Extend usage strings and `consumeFlagValue()` calls:

```text
--tool-mode code_mode_only|shell|inherit
```

Offline add stores enum or omits on inherit. Live edit sends `null` for inherit. `list-custom` text adds a stable stored-mode column and renders omission as `inherit`; JSON uses `knownCustomModelProjection`. `models live --json` receives the management row field without changing live text layout.

- [ ] **Step 5: Run GREEN and adjacent regressions**

```bash
bun test --isolate tests/fork-custom-model-tool-mode-contract.test.ts \
  tests/cli-models.test.ts tests/cli-models-reasoning.test.ts \
  tests/catalog-input-modality-enum.test.ts tests/codex-tool-mode.test.ts
```

- [ ] **Step 6: Commit and review**

```bash
git add src/config/custom-models.ts src/server/management/model-routes.ts \
  src/server/management/model-rows.ts src/cli/models.ts src/cli/models-runtime.ts \
  tests/fork-custom-model-tool-mode-contract.test.ts
git diff --cached --check
git commit -m "fix(models): 贯通 custom model tool mode"
```

Run Task 4 `SPEC_COMPLIANCE` and `CODE_QUALITY` review. Treat public DTO/privacy findings as blocking.

---

### Task 5: Pack local vendored dependencies without modifying the tracked manifest

**Files:**
- Modify: `scripts/install-local-vendor.ts`
- Modify: `scripts/install-local.ts`
- Modify: `tests/install-local-vendor.test.ts`
- Create: `tests/fork-install-local-staging.test.ts`

**Interfaces:**
- Replaces: `runWithBundledDependencies(packageJsonPath, run)`.
- Produces:

```ts
export type PreparedLocalPackage = Readonly<{
  tarball: string;
  rootManifestBytes: string;
  cleanup(): void;
}>;

export function prepareBundledLocalPackage(
  packageRoot: string,
  options: LocalPackageStageOptions = defaultLocalPackageStageOptions,
): PreparedLocalPackage;

export type LocalPackageStageOptions = Readonly<{
  makeTempRoot(prefix: string): string;
  run(command: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Readonly<{
    exitCode: number;
    stdout: string;
  }>;
  removeTree(path: string): void;
}>;
```

Production defaults use `mkdtempSync`, the existing Windows-safe command resolver/Bun spawn shape,
and contained recursive removal. Tests inject pack/install and cleanup failures through these three
ownership points; path walking and copy validation remain real.

- [ ] **Step 1: Repair test lifecycle and write RED staging tests**

Replace the module-level cleanup loop with `afterEach`. Build a small fixture package containing declared `files`, executable bin, generated asset, runtime dependency tree, contained symlink, escaping symlink, and secret undeclared file. Assert:

```text
root package.json bytes never change
stage manifest differs only by sorted bundleDependencies
pack uses ignore-scripts
contained links materialize; escaping links fail closed
archive install resolves bundled direct/transitive dependencies offline
undeclared/secret files are absent
name/version/bin/main/exports/modes/assets survive
primary errors remain primary when cleanup also fails
an incomplete bundle fails offline instead of contacting a registry
pack/validation failure cleans the internally owned stage before throwing
```

- [ ] **Step 2: Run RED**

```bash
bun test --isolate tests/install-local-vendor.test.ts tests/fork-install-local-staging.test.ts
```

Expected: old helper mutates the fixture manifest and lacks staging/archive validation APIs.

- [ ] **Step 3: Implement owner-only staging**

Use Node/Bun fs APIs only. Create stage and validation directories with `mkdtempSync()` and restrictive modes. Copy every declared `files` path and the installed `node_modules` tree. Walk with `lstatSync`; resolve links/junctions with `realpathSync`; require containment within source `node_modules`; materialize regular files/directories; reject devices, sockets, cycles, and escapes. Preserve executable mode bits where supported.

Write the staged semantic manifest with sorted top-level runtime dependencies in `bundleDependencies`. Run:

```text
npm pack --json --ignore-scripts
```

with cwd at the staged package root. Validate npm JSON identity, integrity fields, one regular tarball,
and file manifest. Install the tarball with the exact command shape below:

```text
npm install --ignore-scripts --offline --no-audit --no-fund --package-lock=false \
  --cache <owned-empty-cache> --prefix <owned-validation-prefix> <absolute-tarball>
```

The isolated cache starts empty and the validator never retries without `--offline`. A deliberately
incomplete bundle must fail instead of fetching. Resolve every declared top-level runtime dependency
from the installed package, then walk installed runtime dependencies and present optional
dependencies to prove their transitive packages resolve. Verify package entrypoints/generated assets
from the installed archive, not staging.

- [ ] **Step 4: Integrate with `runLocalInstaller()`**

Keep the validated tarball inside the stage. Pass its absolute path to the existing global replacement
lifecycle. Before `prepareBundledLocalPackage()` returns successfully, it owns and cleans the stage on
preparation, copy, pack, archive-validation, or offline-install failure. After success,
`PreparedLocalPackage.cleanup()` owns removal. Never invoke the old manifest mutation helper. Root
manifest byte checks surround preparation, pack, validation, lifecycle, and cleanup.

Error ordering is exact:

```ts
new AggregateError([primaryError, cleanupError],
  "local package preparation failed and its staging directory could not be removed")
```

Lifecycle cleanup uses `[lifecycleError, cleanupError]`; cleanup-only failure is thrown directly.
The returned object never transfers cleanup ownership before preparation fully succeeds.

- [ ] **Step 5: Run GREEN and packaging regressions**

```bash
bun test --isolate tests/install-local-vendor.test.ts tests/fork-install-local-staging.test.ts \
  tests/install-local.test.ts tests/fork-install-local-lifecycle.test.ts \
  tests/fork-install-local-volta-root.test.ts
```

Do not run the destructive global installer.

- [ ] **Step 6: Commit and review**

```bash
git add scripts/install-local-vendor.ts scripts/install-local.ts \
  tests/install-local-vendor.test.ts tests/fork-install-local-staging.test.ts
git diff --cached --check
git commit -m "fix(install): 隔离本地打包临时元数据"
```

Run Task 5 `SPEC_COMPLIANCE`, `CODE_QUALITY`, and independent security review before Task 6.

---

### Task 6: Remove the contradictory GUI sidecar assertion

**Files:**
- Modify: `gui/tests/sidecar-layout.test.ts`
- Do not modify unless a new failure proves necessity: `gui/src/styles-dashboard-workspace.css`

**Interfaces:**
- Consumes: current vertical control-band layout.
- Produces: one unambiguous regression contract requiring `justify-content: flex-start` and `align-items: stretch`.

- [ ] **Step 1: Record the current RED evidence**

```bash
cd gui && bun test --isolate tests/sidecar-layout.test.ts
```

Expected at `94ed4ca95`: 11 pass / 1 fail; duplicate test requires `space-between` while production uses `flex-start`.

- [ ] **Step 2: Remove only the stale duplicate test**

Delete the later duplicate block beginning at the second identical test name. Retain the first characterization and production CSS. Do not replace the stale expectation with a second duplicate `flex-start` assertion.

- [ ] **Step 3: Run GREEN and GUI checks**

```bash
cd gui
bun test --isolate tests/sidecar-layout.test.ts
bun run lint
cd ..
```

Expected: sidecar test passes with one test of that name; lint passes.

- [ ] **Step 4: Commit and review**

```bash
git add gui/tests/sidecar-layout.test.ts
git diff --cached --check
git commit -m "test(gui): 移除 sidecar 布局矛盾断言"
```

Run Task 6 `SPEC_COMPLIANCE` and `CODE_QUALITY` review.

---

### Task 7: Create the final `2.38.0-ben.2` implementation snapshot and maintenance truth

**Files:**
- Modify: `package.json`
- Modify: `tests/fork-maintenance-truth.test.ts`
- Modify: `FORK_CHANGES.md`

**Interfaces:**
- Consumes: all approved Task 1–6 commits and current blob hashes.
- Produces: immutable `IMPLEMENTATION_HEAD`, final current-capability evidence, pending-release `RELEASE_COMMIT`.

- [ ] **Step 1: Advance the package version**

Change only:

```json
"version": "2.38.0-ben.2"
```

Run:

```bash
bun test --isolate tests/release-version-line.test.ts tests/fork-version-policy.test.ts
```

Expected: the prior deterministic “ben.1 is already tagged on another commit” failure disappears.

- [ ] **Step 2: Update current capability assertions before the implementation commit**

Update maintenance-truth tests to require final current blobs and active evidence for:

```text
src/fork/glm-kimi-compat.ts
src/fork/ark-quota-display.ts
tests/fork-volcengine-empty-assistant-content.test.ts
tests/fork-ark-weekly-quota.test.ts
GUI Logs/Debug code and nine recovery locales
GUI sidecar regression test
customModels schema/tool-mode tests
staged local packaging tests
```

Tests must not hard-code `IMPLEMENTATION_HEAD` before the commit exists; they may require the current package version, paths, and current blob strings computed immediately before staging.

- [ ] **Step 3: Update implementation-facing sections of `FORK_CHANGES.md`**

Describe the final active GLM/Kimi/Volcengine behavior and current blobs, weekly quota support, custom-model safety/round trip, staged installer, GUI Logs truth, corrected sidecar test, 17-path rebase account, six-member release contract, package version, and target `v2.38.0-ben.2`. Keep Tag/push/Release/external CI state explicitly pending.

- [ ] **Step 4: Run focused implementation gates**

Run all focused files from Tasks 1–6 plus:

```bash
bun run typecheck
bun run privacy:scan
git diff --check
```

If any implementation/test change is required, fix it before committing and rerun its focused gate.

- [ ] **Step 5: Commit the final implementation snapshot**

Stage every remaining production/test/version change but do not stage the final `FORK_CHANGES.md` release snapshot because it still needs the new SHA. Commit with the fixed functional message:

```bash
git add package.json tests/fork-maintenance-truth.test.ts
git diff --cached --check
git commit -m "chore: 推进 v2.38.0-ben.2 版本真源"
```

Capture the final SHA for this implementation generation:

```bash
IMPLEMENTATION_HEAD=$(git rev-parse HEAD)
```

Do not change it while generating or validating its corresponding `FORK_CHANGES.md`. If a gate
requires another implementation/test change, discard this generation and variable, create the
corrective implementation commit, capture the replacement final-generation SHA once, regenerate
the document, and restart pre-commit validation from Step 6.

- [ ] **Step 6: Finalize the maintenance document from the captured SHA**

Recompute:

```bash
git diff --shortstat v2.38.0..$IMPLEMENTATION_HEAD
git diff --name-status v2.38.0..$IMPLEMENTATION_HEAD
git diff --check v2.38.0..$IMPLEMENTATION_HEAD
```

Write the exact implementation SHA and shortstat into `FORK_CHANGES.md`. Ensure every current blob anchor comes from `$IMPLEMENTATION_HEAD:path`. Run focused maintenance/version tests with the document present.

- [ ] **Step 7: Run pre-commit final validation with `FORK_CHANGES.md` present**

Before `RELEASE_COMMIT` exists, run only checks valid for the uncommitted final document:

```bash
# Run the complete focused root list from Task 8 Step 1.
# Run the GUI test/lint/build list from Task 8 Step 2.
bun run typecheck
bun run privacy:scan
bun run prepush
git diff --check v2.38.0..$IMPLEMENTATION_HEAD
git range-diff --no-color v2.37.0..09fbd1453 v2.38.0..$IMPLEMENTATION_HEAD
test "$(git diff --name-only)" = "FORK_CHANGES.md"
git diff --check
```

Do not run release-commit `HEAD^` or `diff-tree HEAD` assertions yet. If implementation/tests change,
follow the generation invalidation rule in Step 5, regenerate the document, and rerun complete
pre-commit validation. If only `FORK_CHANGES.md` changes, rerun its focused tests and document-input
checks; do not rerun an unaffected full gate merely for confidence.

- [ ] **Step 8: Create the trailing documentation commit**

```bash
git add FORK_CHANGES.md
test "$(git diff --cached --name-only)" = "FORK_CHANGES.md"
git diff --cached --check
git commit -m "docs: 记录 v2.38.0-ben.2 修复候选"
test "$(git rev-parse HEAD^)" = "$IMPLEMENTATION_HEAD"
test "$(git diff-tree --no-commit-id --name-only -r HEAD)" = "FORK_CHANGES.md"
git diff --check HEAD^ HEAD
```

This commit is `RELEASE_COMMIT`. Do not tag or push it in this task.

---

### Task 8: Verify the release-commit structure and complete blocking reviews

**Files:**
- No planned production edits. Any finding returns to its owning Task.

**Interfaces:**
- Consumes: final `IMPLEMENTATION_HEAD` and `RELEASE_COMMIT`.
- Produces: attributable verification package and Approved review verdicts.

- [ ] **Step 1: Run the focused root tests before Task 7 Step 8**

```bash
bun test --isolate \
  tests/fork-maintenance-truth.test.ts \
  tests/fork-version-policy.test.ts \
  tests/release-version-line.test.ts \
  tests/fork-ci-official-baseline.test.ts \
  tests/fork-ark-weekly-quota.test.ts \
  tests/fork-ark-quota-error.test.ts \
  tests/fork-volcengine-empty-assistant-content.test.ts \
  tests/fork-custom-model-config-schema.test.ts \
  tests/fork-custom-model-tool-mode-contract.test.ts \
  tests/install-local-vendor.test.ts \
  tests/fork-install-local-staging.test.ts \
  tests/install-local.test.ts
```

- [ ] **Step 2: Run GUI validation before Task 7 Step 8**

```bash
cd gui
bun test --isolate tests/sidecar-layout.test.ts
bun run lint
bun run build
cd ..
```

- [ ] **Step 3: Run repository gates before Task 7 Step 8**

```bash
bun run typecheck
bun run privacy:scan
bun run prepush
```

`bun run prepush` must complete with exit code 0 and a zero-failure summary before the trailing
commit. Do not substitute another process's output or a partial run. Do not rerun full gates after a
byte-identical `FORK_CHANGES.md` commit unless a later change can affect them.

- [ ] **Step 4: Recheck post-commit Git and release invariants**

```bash
git status --short --branch
git diff --check v2.38.0..HEAD
test "$(git rev-parse HEAD^)" = "$IMPLEMENTATION_HEAD"
test "$(git diff-tree --no-commit-id --name-only -r HEAD)" = "FORK_CHANGES.md"
git diff --check HEAD^ HEAD
```

Confirm no Tag, push, Release, global install, or service mutation occurred.

- [ ] **Step 5: Run final independent reviews**

Dispatch fresh bounded reviewers:

```text
SPEC_COMPLIANCE: complete approved Spec vs v2.38.0..RELEASE_COMMIT
CODE_QUALITY: correctness, lifecycle, persistence, privacy, tests, minimal surface
CODE_QUALITY security focus: release refset, config projection, packaging links/archive/cleanup
```

Provide exact refs, scoped diff, Task verification outputs, and residual platform gaps. Do not send main-session history or a predicted verdict.

- [ ] **Step 6: Fix and re-review blockers**

For each Critical/Important finding, return to the owning Task, add a failing regression where applicable, make the minimum fix, rerun the entire final gate, rebuild `IMPLEMENTATION_HEAD`/`RELEASE_COMMIT` if code or tests changed, and resume the same reviewer with:

```text
REVIEW_PHASE: RE_REVIEW
PRIOR_FINDINGS: complete original findings
FIX_DIFF: exact scoped diff
VERIFICATION_EVIDENCE: fresh attributable output
```

- [ ] **Step 7: Report completion without external release actions**

Report final SHAs, changed files by functional boundary, test counts, full prepush result, review verdicts, platform-specific gaps, and residual risks. State explicitly that Tag/push/Release/global install/service operations remain unperformed.

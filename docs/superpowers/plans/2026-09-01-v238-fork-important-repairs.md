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
- Do not create a worktree. Before all final validation and review gates pass, do not create a tag,
  push, move refs, or publish a Release. The user has explicitly authorized the final
  `v2.38.0-ben.2` annotated Tag, atomic push, local ref convergence, and GitHub Release after those
  gates. Do not install/replace global OpenCodex or restart/repair a service.
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
- Consumes: fixed refs and the approved contract that updates `main`, `dev`, `sync/v2.38.0`,
  `upstream-release`, the Fork Tag, and the official Tag in one `git push --atomic`.
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
expect(salvageCustomModelsForLoad([{ ...goodRow, reasoningEfforts: ["high", "low", "high"] }]).value?.[0]?.reasoningEfforts).toEqual(["low", "high"]);
expect(customModelsCandidateError([{ ...goodRow, codexToolMode: null }])).toContain("codexToolMode");
```

Replace the combined duplicate assertion with explicit asymmetric cases:

```ts
expect(salvageCustomModelsForLoad([firstId, duplicateId]).value).toEqual([firstId]);
expect(salvageCustomModelsForLoad([firstId, distinctIdSameRoutedSlug]).value)
  .toEqual([firstId, distinctIdSameRoutedSlug]);
expect(customModelsCandidateError([firstId, distinctIdSameRoutedSlug])).toContain("duplicate");
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

Implement the approved field table. Preserve unknown keys in the internal config object by starting a surviving row with `{ ...record }`, then overwrite/delete known fields according to salvage. Keep the first valid stable ID, but preserve distinct rows whose native IDs encode to the same routed identity so existing ambiguity guards remain fail-closed; strict write validation still rejects a new routed-identity collision. Apply `canonicalizeReasoningEfforts()` after filtering valid declared efforts. Return `undefined` for zero survivors.

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
  tests/config-user-edits.test.ts tests/cli-models.test.ts
```

Expected: all pass; no disk mutation on read. The exact encoded-selector and native-slash ambiguity
removal cases retain both historical rows and refuse deletion, while unambiguous exact removal still
passes.

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
PUT metadata-only edit on a grandfathered collision member -> allowed
PUT modelId change that creates/enlarges a collision -> 409, no persistence/converge
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
Retain the existing `tests/cli-models.test.ts` cases proving exact stable-ID removal can shrink a
collision class while encoded/native routed selectors matching both members fail without writes.

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
  npmCache: string;
  rootManifestBytes: string;
  cleanup(): void;
}>;

export function prepareBundledLocalPackage(
  packageRoot: string,
  options: LocalPackageStageOptions = defaultLocalPackageStageOptions,
): PreparedLocalPackage;

export type LocalPackageStageOptions = Readonly<{
  makeTempRoot(prefix: string): string;
  run(
    command: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    options?: LocalPackageRunOptions,
  ): LocalPackageRunResult;
  removeTree(path: string): void;
}>;

export type LocalPackageRunOptions = Readonly<{ timeoutMs?: number }>;
export type LocalPackageRunResult = Readonly<{
  exitCode: number;
  stdout: string;
  timedOut: boolean;
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
ancestor links and in-repository links escaping a declared subtree fail closed
archive install resolves bundled direct/transitive dependencies offline
undeclared/secret files are absent
name/version/bin/main/exports/modes/assets survive
actual SHA-512/SHA-1 equal npm integrity/shasum and file rows match the allowed archive surface
primary errors remain primary when cleanup also fails
an incomplete bundle fails offline instead of contacting a registry
missing, large-junk, nonzero, spawn-failing, or timeout Bun binaries fail before replacement
pack/validation failure cleans the internally owned stage before throwing
```

- [ ] **Step 2: Run RED**

```bash
bun test --isolate tests/install-local-vendor.test.ts tests/fork-install-local-staging.test.ts
```

Expected: old helper mutates the fixture manifest and lacks staging/archive validation APIs.

- [ ] **Step 3: Implement owner-only staging**

Use Node/Bun fs APIs only. Create stage and validation directories with `mkdtempSync()` and restrictive modes. Copy every declared `files` path and the installed `node_modules` tree. Walk with `lstatSync`; resolve links/junctions with `realpathSync`; require containment within source `node_modules`; materialize regular files/directories; reject devices, sockets, cycles, and escapes. Preserve executable mode bits where supported.

Canonicalize every source before dispatching on type. Reject a declared root `files` entry that is a
link; nested links inside a declared directory must remain inside that declared subtree. Add ancestor
symlink/junction and in-repository excluded-secret regressions.

Write the staged semantic manifest with sorted top-level runtime dependencies in `bundleDependencies`. Run:

```text
npm pack --json --ignore-scripts
```

with cwd at the staged package root. Recompute the tarball SHA-512 SRI and SHA-1, validate npm JSON
identity/integrity, one regular tarball, and every file row against the declared/bundled surface;
reject duplicates, escapes, dot segments, and sensitive entries. Install with the exact command:

```text
npm install --ignore-scripts --offline --no-audit --no-fund --package-lock=false \
  --cache <owned-empty-cache> --prefix <owned-validation-prefix> <absolute-tarball>
```

The isolated cache starts empty and the validator never retries without `--offline`. A deliberately
incomplete bundle must fail instead of fetching. Resolve every declared top-level runtime dependency
from the installed package, then walk installed runtime dependencies and present optional
dependencies to prove their transitive packages resolve. Verify package entrypoints/generated assets
from the installed archive, not staging.

Validate every declared root `files` entry plus all local string/object/array/conditional targets in
`main`, `bin`, and `exports`; require contained existing regular targets.

If the root package depends on `bun`, first apply the existing real-binary size check, then execute
the exact extracted validation-prefix binary with `--version`, `timeoutMs: 5000`, exit 0, and a
plausible Bun semver line. Expose this through the injected `run` seam and add success/nonzero/spawn/
timeout/large-junk tests. Never call `bun/install.js` or allow the launcher to repair the fixture.
Production calls the seam with exactly `{ timeoutMs: 5000 }`; `timedOut: true`, a thrown spawn error,
or nonzero exit is a fixed fail-closed preparation error. Tests assert the exact binary path,
`--version` argument, and timeout option.

- [ ] **Step 4: Integrate with `runLocalInstaller()`**

Keep the validated tarball and cache inside the stage. Pass both to the existing global replacement
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

The production replacement command is exactly:

```text
npm install -g --ignore-scripts --offline --no-audit --no-fund --package-lock=false \
  --cache <prepared.npmCache> <prepared.tarball>
```

Add a pure command-argument assertion and never execute it against the real global prefix in tests.

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

### Task 6.5: Permit explicitly authorized same-base Fork maintenance revisions

**Files:**
- Modify: `src/fork/version-policy.mjs`
- Modify: `tests/fork-version-policy.test.ts`
- Modify: `tests/fork-maintenance-truth.test.ts`
- Modify: `docs/fork-sync-automation.md`
- Modify: this approved Spec and Plan clarification

**Interfaces:**
- Consumes: `forkVersionTagError(version, tags, pointsAtHead)`.
- Produces: per-official-base `ben.N` monotonicity while retaining official-base existence and Tag
  immutability; ordinary stable/preview global monotonicity remains unchanged.

- [ ] **Step 1: Record the environment-driven RED**

Run the current version gates with upstream `v2.39.0` present:

```bash
bun test --isolate tests/release-version-line.test.ts tests/fork-version-policy.test.ts
```

Expected: current `2.38.0-ben.1` fails because `forkVersionTagError()` rejects a Fork base older
than the newest official stable. Also evaluate `2.38.0-ben.2` directly against the complete local
tag set and record the same failure.

- [ ] **Step 2: Add the revised contract test first**

In `tests/fork-version-policy.test.ts`, change the existing cross-base expectation so a valid
`2.34.0-ben.2` is accepted even when `v2.35.0` exists. Retain and extend assertions proving:

```text
missing exact official base -> rejected
revision below existing same-base ben.N -> rejected
existing same revision on another commit -> rejected
existing same revision on this commit -> accepted
malformed ben tags -> ignored
ordinary non-Fork versions -> handled by the unchanged global monotonic path
```

Run the focused test and require the new old-base maintenance case to fail before production code
changes.

- [ ] **Step 3: Implement the minimal policy change**

Remove only the cross-base stable comparison from `forkVersionTagError()`. Keep exact base-tag
existence, same-base highest-revision comparison, exact current-tag identity, and non-Fork
`undefined` behavior unchanged. Do not change updater semantics or generic release-tag ordering.

- [ ] **Step 4: Run the truthful GREEN, commit, and review**

```bash
bun test --isolate tests/fork-version-policy.test.ts
# The combined version-line command remains expected RED only because package.json is still the
# immutable, already-published 2.38.0-ben.1. Record that exact remaining error; Task 7 owns the bump.
bun test --isolate tests/release-version-line.test.ts tests/fork-version-policy.test.ts
git diff --check
git add src/fork/version-policy.mjs tests/fork-version-policy.test.ts \
  tests/fork-maintenance-truth.test.ts \
  docs/fork-sync-automation.md \
  docs/superpowers/specs/2026-09-01-v238-fork-important-repairs-design.md \
  docs/superpowers/plans/2026-09-01-v238-fork-important-repairs.md
test "$(git diff --cached --name-only)" = "$(printf '%s\n' \
  docs/fork-sync-automation.md \
  docs/superpowers/plans/2026-09-01-v238-fork-important-repairs.md \
  docs/superpowers/specs/2026-09-01-v238-fork-important-repairs-design.md \
  src/fork/version-policy.mjs \
  tests/fork-maintenance-truth.test.ts \
  tests/fork-version-policy.test.ts)"
git diff --cached --check
git commit -m "fix(fork): 允许旧基线 ben 维护发布"
```

The focused policy test must be GREEN. The combined command must now fail only with
`fork version 2.38.0-ben.1 is already tagged on another commit`; any cross-base error or different
failure blocks. Task 7 Step 1 changes the package version and is the first point where both files
must be GREEN.

Run independent `SPEC_COMPLIANCE`, `CODE_QUALITY`, and security-focused `CODE_QUALITY` review.

---

### Task 7: Create the final `2.38.0-ben.2` implementation snapshot and maintenance truth

**Files:**
- Modify: `package.json`
- Modify: `tests/fork-maintenance-truth.test.ts`
- Modify: `FORK_CHANGES.md`

**Interfaces:**
- Consumes: all approved Task 1–6.5 commits and current blob hashes.
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

Expected: the prior deterministic “ben.1 is already tagged on another commit” failure disappears;
the newer official `v2.39.0` tag no longer blocks this explicitly authorized same-base Fork
maintenance revision.

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

Describe the final active GLM/Kimi/Volcengine behavior and current blobs, weekly quota support, custom-model safety/round trip, staged installer, GUI Logs truth, corrected sidecar test, 17-path rebase account, the release contract that atomically updates the four branches and two Tags named above, package version, and target `v2.38.0-ben.2`. Keep Tag/push/Release/external CI state explicitly pending.

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

This commit is `RELEASE_COMMIT`. Do not tag or push until Task 8 reviews pass.

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

- [ ] **Step 7: Record the approved release package**

Record final SHAs, changed files by functional boundary, test counts, full prepush result, review
verdicts, platform-specific gaps, residual risks, and exact expected local/remote ref OIDs for the
authorized publication transaction. Confirm Tag/push/Release remain unperformed until Task 9.

---

### Task 9: Publish `v2.38.0-ben.2`

**Files:**
- No source edits. Release Notes are created through GitHub after Git publication.

**Interfaces:**
- Consumes: approved `IMPLEMENTATION_HEAD`, `RELEASE_COMMIT`, `OFFICIAL_COMMIT`, exact remote OIDs,
  and all Task 8 review verdicts.
- Produces: annotated Fork Tag; one `git push --atomic` that updates `main`, `dev`, `sync/v2.38.0`,
  `upstream-release`, the Fork Tag, and the official Tag together; local compare-and-swap
  convergence, and public non-draft/non-prerelease GitHub Release.

- [ ] **Step 1: Re-read and freeze publication state**

Require a clean tree and re-read local/raw/peeled and remote OIDs for `main`, `dev`,
`sync/v2.38.0`, `upstream-release`, official `v2.38.0`, and prospective
`v2.38.0-ben.2`. Also freeze raw and peeled identities for immutable `v2.38.0-ben.1` locally and
remotely; it must remain unchanged before and after publication.

Classify the complete remote state of `main`, `dev`, `sync/v2.38.0`, `upstream-release`, the Fork
Tag, and the official Tag before mutation:

1. all refs equal the frozen old OIDs: publication has not happened; refresh every OID and proceed
   once with the complete atomic set;
2. all listed refs equal their final targets: Git publication already completed; do not repush, and
   continue only with local CAS and Release convergence;
3. mixed old/final or any unrelated value: fail closed for investigation and never split the set;
4. a local-only ben.2 Tag is acceptable only when it is the exact captured annotated object peeling
   to `RELEASE_COMMIT`;
5. after an uncertain push result, reread all four branches and two Tags and re-enter this classification
   before considering any retry.

The state of those four branches and two Tags is necessary but not sufficient for a same-base maintenance revision. Enforce
this identical machine contract here and in `docs/fork-sync-automation.md`:

<!-- same-base-ben-preflight:start -->
scope=strict-local-and-remote-vX.Y.Z-ben.N
snapshot=name-raw-peeled
pre_local_tag=freeze-local-baseline-and-remote-baseline
pre_push=local-baseline-plus-exact-target-and-remote-baseline
post_push=remote-baseline-or-remote-baseline-plus-exact-target
higher_revision=fail-closed-at-every-checkpoint
other_drift=fail-closed
post_success=required-before-github-release
serialization=single-publisher-required
toctou=final-recheck-to-push-window-is-residual-risk
<!-- same-base-ben-preflight:end -->

At each checkpoint, enumerate local tags and the complete remote namespace:

```bash
git tag --list 'v2.38.0-ben.*'
git ls-remote --tags origin 'refs/tags/v2.38.0-ben.*'
```

Strictly parse only canonical safe-integer `v2.38.0-ben.N` names, pair every annotated raw ref with
its `^{}` peeled row, and capture the sorted `(name, raw OID, peeled OID)` maps. Feed every complete
valid name set into the same version-policy contract and recompute the highest revision at each
checkpoint.

- Before local Tag creation, freeze `LOCAL_BASELINE` and `REMOTE_BASELINE`; reject a higher revision
  or an existing target whose raw/peeled identity is incompatible with this candidate.
- Immediately before atomic push, local state must equal `LOCAL_BASELINE` or exactly
  `LOCAL_BASELINE + { v2.38.0-ben.2: (LOCAL_TARGET_RAW, RELEASE_COMMIT) }`; remote state must equal
  `REMOTE_BASELINE` byte-for-byte.
- After a definite success or an uncertain result, local state must remain unchanged. Remote state
  may only equal `REMOTE_BASELINE` or exactly `REMOTE_BASELINE +` the target whose raw OID equals
  `LOCAL_TARGET_RAW` and peeled OID equals `RELEASE_COMMIT`. Use the results for those four branches
  and two Tags to
  distinguish a completed atomic push from a no-op or failure.
- Any other name addition/deletion, object replacement, raw/peeled drift, or higher valid revision
  fails closed. A late `ben.3` blocks `ben.2`, even when the target itself was absent at Task 8.

Only one publisher may execute this release. The complete Tag namespace has no atomic Git lease, so
the interval between the final remote recheck and push is an explicit TOCTOU residual risk; record
it in the final release report and do not claim the branch leases and Tag refspecs in this push protect differently named
future revisions. Run the complete remote namespace check after a reported successful push as well
as after an uncertain result and before GitHub Release creation. If a higher revision appeared in
the race window after the lower immutable Tag was published, do not delete or move the Tag; stop
before creating the Release and report the violated single-publisher assumption.

Require remote sync to be absent or an ancestor of `RELEASE_COMMIT`; re-read it immediately before
push. Prepare the local audit ref before Tag creation with exact compare-and-swap:

```bash
EXPECTED_LOCAL_SYNC=$(git rev-parse -q --verify refs/heads/sync/v2.38.0 || true)
if test -n "$EXPECTED_LOCAL_SYNC"; then
  git merge-base --is-ancestor "$EXPECTED_LOCAL_SYNC" "$RELEASE_COMMIT"
fi
git update-ref refs/heads/sync/v2.38.0 "$RELEASE_COMMIT" "$EXPECTED_LOCAL_SYNC"
test "$(git rev-parse refs/heads/sync/v2.38.0)" = "$RELEASE_COMMIT"
```

- [ ] **Step 2: Create the immutable annotated Tag locally**

Create Chinese annotated `v2.38.0-ben.2`; require raw type `tag` and peeled commit equal to
`RELEASE_COMMIT`. If the Tag exists, accept only the exact same raw/peeled identity; never replace
or force it.

- [ ] **Step 3: Perform the single atomic publication push**

Use one `git push --atomic` to update `main`, `dev`, `sync/v2.38.0`, `upstream-release`, the official
Tag, and the Fork Tag together: leased-force `main`, `dev`, and `upstream-release`;
leased-fast-forward `sync/v2.38.0`; unforced/unleased official and Fork Tags.
Use exact per-ref expected OIDs and an ordinary non-`+` sync refspec. Do not split or retry a partial
set. Immediately before the transaction, reread remote sync, require it still equals
`EXPECTED_REMOTE_SYNC`, and rerun its ancestry guard when nonempty. The exact transaction is:

```bash
git push --atomic origin \
  --force-with-lease="refs/heads/main:${EXPECTED_REMOTE_MAIN}" \
  --force-with-lease="refs/heads/dev:${EXPECTED_REMOTE_DEV}" \
  --force-with-lease="refs/heads/sync/v2.38.0:${EXPECTED_REMOTE_SYNC}" \
  --force-with-lease="refs/heads/upstream-release:${EXPECTED_REMOTE_MARKER}" \
  "${RELEASE_COMMIT}:refs/heads/main" \
  "${RELEASE_COMMIT}:refs/heads/dev" \
  "${RELEASE_COMMIT}:refs/heads/sync/v2.38.0" \
  "${OFFICIAL_COMMIT}:refs/heads/upstream-release" \
  "refs/tags/v2.38.0:refs/tags/v2.38.0" \
  "refs/tags/v2.38.0-ben.2:refs/tags/v2.38.0-ben.2"
```

`EXPECTED_REMOTE_SYNC` is the empty string when the remote ref is absent, so the exact lease string
ends in `:` and asserts nonexistence. None of these branch/Tag refspecs has a leading `+`; only the three
release-pointer branches and marker receive their explicitly listed lease capability, while sync's
lease is backed by the separate ancestry guard. No tag receives a force or lease option.

After confirmed success, update local `main` and `upstream-release` only through their captured old
OIDs. If either is already final, accept it; otherwise require exact compare-and-swap. Fetch and
verify remote-tracking refs. If all four branches and two Tags are already final after an uncertain result, do
not repush.

- [ ] **Step 4: Create and verify the GitHub Release**

Create or idempotently converge public `v2.38.0-ben.2` with name equal to the Tag, `draft=false`,
`prerelease=false`, and Chinese notes containing the official v2.38.0 base, Fork changes,
verification, known platform gaps, and `RELEASE_COMMIT`. Use source archives only unless separately
authorized. Use these metadata operations:

```bash
gh release view v2.38.0-ben.2 --repo Trendymen/opencodex \
  --json tagName,name,isDraft,isPrerelease,targetCommitish,body,url

# When absent:
gh release create v2.38.0-ben.2 --repo Trendymen/opencodex --verify-tag \
  --title v2.38.0-ben.2 --notes-file "$RELEASE_NOTES_FILE"

# When present but only mutable metadata differs:
gh release edit v2.38.0-ben.2 --repo Trendymen/opencodex \
  --title v2.38.0-ben.2 --notes-file "$RELEASE_NOTES_FILE" \
  --draft=false --prerelease=false
```

After create/edit, rerun the exact `gh release view` query and require the exact tag/name, public
non-prerelease flags, expected target commitish/Tag association, required Chinese note sections, and
nonempty URL. If Git refs are final but the Release is absent or metadata differs, change only this
same Tag's Release; never move refs or increment ben.N.

- [ ] **Step 5: Verify final convergence**

Require local/remote `main`, `dev`, `sync/v2.38.0`, and the Fork Tag peeled commit to equal
`RELEASE_COMMIT`; require local/remote `upstream-release` and official Tag to equal
`OFFICIAL_COMMIT`; require the Fork Tag raw object to remain annotated and the GitHub Release to be
public at that exact Tag. Do not globally install or restart any service.

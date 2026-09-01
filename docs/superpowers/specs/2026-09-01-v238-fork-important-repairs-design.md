# v2.38 Fork Important Repairs Design

## Goal

Repair every confirmed Important finding on the `v2.38.0` Fork candidate while preserving both
official `v2.38.0` behavior and all verified Fork behavior. The implementation starts from
`94ed4ca95612c2f640127fb61ac1330449258dd6`; the discarded local version/document candidates
`01917463f` and `ee4a6f56f` are not reused.

The final candidate must:

- use immutable Fork revision `2.38.0-ben.2` without moving `v2.38.0-ben.1`;
- record the complete three-way rebase overlap and conflict result;
- enforce one unambiguous `dev`/`main`/`sync` release topology;
- recognize the observed Volcengine weekly usage quota without broadening unrelated 429 handling;
- make `customModels` safe under malformed hand edits and complete `codexToolMode` round trips;
- eliminate tracked `package.json` mutation from local vendored packaging;
- remove the contradictory GUI sidecar regression assertion;
- keep `FORK_CHANGES.md` synchronized with the active GLM/Kimi/Volcengine and GUI Logs surfaces;
- pass focused, GUI, privacy, typecheck, packaging, and full prepush gates before review or release.

## Fixed baselines

| Role | Ref | Commit |
| --- | --- | --- |
| Old official stable | `v2.37.0` | `54e2274cff231631c0ea2ff12574ff03829d5fe6` |
| New official stable | `v2.38.0` | `ebb4d552e8f463bc1519ab5aab602342b0ba70dc` |
| Pre-rebase Fork candidate | `dev` reflog source | `09fbd1453fa2c374d5d0e9cad9ae15cf86cf7e8f` |
| Repair starting point | `dev` / `origin/dev` | `94ed4ca95612c2f640127fb61ac1330449258dd6` |
| Published immutable Fork tag | `v2.38.0-ben.1^{commit}` | `a22ca82b22a4413b72762281e932d8d208442571` |

The official upgrade, old Fork delta, and post-rebase Fork delta are compared separately:

```text
official upgrade: v2.37.0..v2.38.0
old Fork delta:   v2.37.0..09fbd1453
new Fork delta:   v2.38.0..<candidate>
```

Path presence is not behavior proof. Rebase preservation uses `git range-diff`, exact path-set
intersections, `git merge-tree --write-tree --messages`, blob comparisons, current source call
chains, focused tests, and the final full gate.

## Confirmed rebase result

The rebase has 17 official/Fork overlap paths, 16 automatic merges, and one content conflict:

```text
bin/ocx.mjs
gui/src/i18n/de.ts
gui/src/i18n/en.ts
gui/src/i18n/fr.ts
gui/src/i18n/ja.ts
gui/src/i18n/ko.ts
gui/src/i18n/ru.ts
gui/src/i18n/tr.ts
gui/src/i18n/zh-TW.ts
gui/src/i18n/zh.ts
package.json
src/codex/catalog/provider-fetch.ts
src/codex/catalog/sync.ts
src/config.ts
src/server/management/provider-routes.ts
src/update/index.ts
structure/04_transports-and-sidecars.md
```

`package.json` is the sole content conflict. Its resolved content must retain the official v2.38
scripts, dependencies, overrides, Bun version, packaging surface, and prepush behavior, while also
retaining the Fork `install:local` entry. The old `2.37.0-ben.3` version must not survive.

The 16 automatically merged paths currently equal the synthetic merge tree. Their maintenance
ledger must nevertheless list them because every path requires semantic review during future
rebases. The active ledger must record all 17 paths, `auto_merge_path_count=16`, the one conflict,
the package resolution, and the focused evidence for official/Fork behavior preservation.

## Preserved official and Fork capabilities

The repair must not rewrite or remove the official v2.38 capabilities already proven present:

- effective provider/model aliases in Codex picker display names;
- Codex entitlement freshness, tri-state authority, catalog filtering, and management status;
- reset-credit operation ledger and config mutation database preparation;
- Windows scheduler/service repair and shutdown-drain behavior;
- Responses state spill, pending publication, ACL, shutdown drain, and metrics;
- Aside integration, rollback UI, brand assets, locales, and documentation;
- Codex CLI provenance inspection;
- strict-semver ReDoS repair.

The repair must retain the verified Fork surfaces:

- GLM/Kimi/Zhipu Responses compatibility and schema lowering;
- Volcengine replayed empty-assistant cleanup;
- reasoning-summary and opaque-reasoning preservation;
- nested-exec adapter and passthrough repair;
- shared retry/recovery budgets and no mid-stream replay;
- terminal repair, ordinary upstream error fidelity, and eager/tee `[DONE]` completion;
- inbound/outbound provider diagnostics and final downstream observation;
- routed progress contract and standalone web-search injection;
- Zhipu `{models:[{slug}]}` discovery;
- local installer and Fork update/version policy;
- GUI Logs/Debug, provider, route, surface, and recovery-reason display.

No deprecated direction may be revived. In particular, the repair must not restore the retired
Fork test runner, the old message-phase module, Kimi automatic adjacency normalization, global
ChatGPT quota UI mapping, or the MiniMax fixed-port workaround.

## Release topology and immutable versioning

### Branch roles

The only supported topology is:

```text
dev               development, rebase, validation, and release-candidate line
main              latest published Fork Release pointer
sync/vX.Y.Z       audit/release ref for one official stable baseline
upstream-release  exact official stable tag commit marker
```

Stable rebase work runs on `dev`. Once the candidate is validated, `sync/vX.Y.Z` is created or
fast-forwarded from that candidate. `sync/vX.Y.Z` is not a working rebase line.

`docs/fork-sync-automation.md` is the authoritative operational document and is a required output
of this repair. Its branch-role, preflight, rebase, validation, atomic-promotion, local-ref update,
postflight, idempotent-recovery, and audit-command sections must be updated to use exactly the same
vocabulary and timeline as this Spec. `FORK_CHANGES.md` and its contract tests mirror that authority;
they do not define a competing topology.

The timeline uses these exact terms:

```text
IMPLEMENTATION_HEAD
  final commit containing every production, test, script, GUI, and package-version change

RELEASE_COMMIT
  trailing commit whose parent is IMPLEMENTATION_HEAD and whose only changed path is
  FORK_CHANGES.md

OFFICIAL_COMMIT
  peeled commit of the fixed official stable tag
```

Preparing or validating a local candidate may create a local `sync/vX.Y.Z` only after
`IMPLEMENTATION_HEAD` and the subsequent `RELEASE_COMMIT` are fixed. This repair task itself does
not create or move local or remote `sync`, `main`, `dev`, marker, or tag refs. Remote ref movement is
a deferred release action after every review and validation gate passes.

### Atomic promotion

The release-instant atomic refset contains six members:

```text
branch|main|leased-force|RELEASE_COMMIT:refs/heads/main
branch|dev|leased-force|RELEASE_COMMIT:refs/heads/dev
branch|sync|leased-fast-forward|RELEASE_COMMIT:refs/heads/sync/vX.Y.Z
branch|marker|leased-force|OFFICIAL_COMMIT:refs/heads/upstream-release
tag|official|no-force-no-lease|refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
tag|fork|no-force-no-lease|refs/tags/vX.Y.Z-ben.N:refs/tags/vX.Y.Z-ben.N
```

Each branch has its own explicit expected-SHA lease. `sync/vX.Y.Z` must be a normal fast-forward
refspec, not a forced ref. Neither tag may be forced or leased. A mismatch or unsupported atomic
push fails closed; the operation is never split into partially successful pushes.

The rule against automatically moving `dev` applies after publication: when new development has
advanced `dev` beyond the published release, an automation run must not reset it to the old release
commit. It does not prohibit publishing the currently validated `dev` candidate as part of the
same atomic promotion.

At publication, local `dev` already points to `RELEASE_COMMIT`; local `main` and
`upstream-release` are updated after the successful remote transaction through an expected-old-OID
compare-and-swap. Local `sync/vX.Y.Z` must already equal `RELEASE_COMMIT` and is not rewritten to a
different object after validation. The Fork annotated tag peels to `RELEASE_COMMIT`; the official
tag and `upstream-release` peel to `OFFICIAL_COMMIT`.

Acceptance tests must parse both generic atomic-refset blocks in `FORK_CHANGES.md` and the canonical
contract in `docs/fork-sync-automation.md`, require the same six rows and policies, require rebase on
`dev`, reject rebase on `sync/vX.Y.Z`, and distinguish release-instant `dev` publication from an
illegal post-publication reset of an advanced `dev`.

### Fork revision

`v2.38.0-ben.1` is immutable and already points at `a22ca82b2`. A descendant containing the
Volcengine repair cannot reuse it. The repaired candidate becomes `2.38.0-ben.2`; a new annotated
`v2.38.0-ben.2` may be created only after final validation and all blocking reviews pass.

All implementation and test repairs are committed before capturing `IMPLEMENTATION_HEAD`. The
package version commit is part of that implementation snapshot. `FORK_CHANGES.md` is then updated
from that exact SHA, final validation is run with the updated document present, and a trailing
documentation commit containing only `FORK_CHANGES.md` is created. Its parent must equal the
captured implementation HEAD.

## Volcengine weekly quota compatibility

The current Ark quota mapper recognizes an optional numeric `<n>-hour` window but not the observed
`weekly` window. The repair stays inside `src/fork/ark-quota-display.ts` and does not modify shared
retry or passthrough sequencing.

Accepted quota-window wording is deliberately closed:

```text
You have exceeded the usage quota.
You have exceeded the <digits>-hour usage quota.
You have exceeded the weekly usage quota.
```

The existing strict reset timestamp and `+0800 CST` suffix remain required. Ordinary overloads,
generic 429 responses, malformed JSON, other providers, and `usage_limit_reached` remain unchanged.
The normalized response is the existing non-retryable Ark-specific HTTP 400 client error.

New tests live in `tests/fork-ark-weekly-quota.test.ts` rather than extending an unrelated existing
test file. They cover positive weekly/hour/no-window cases and negative near misses.

## `customModels` integrity and management contract

### Read-time schema and salvage

`customModels` has separate read-time salvage and write-time validation boundaries. The shared
whole-config schema keeps the raw field as `unknown`; `loadConfig()` applies a dedicated forgiving
projection after the rest of the config parses. `validateConfigCandidate()` and every live write
entry point apply a separate strict validator before persistence. A malformed non-array disk value
therefore degrades to `undefined` during load, while the same malformed value in a live whole-config
write is rejected rather than silently accepted.

Read-time array values are processed in original order. The projection begins with an empty result
and applies this normative table:

| Field | Read-time hand-edit salvage | Strict live write |
| --- | --- | --- |
| row shape | non-object/array row is dropped | reject candidate |
| `id`, `provider`, `modelId` | trim; drop row if missing/empty/non-string | require non-empty trimmed strings |
| unknown row keys | preserve verbatim in the persisted/in-memory config object for forward compatibility | preserve through strict whole-config writes; management POST/PUT construct only known fields |
| `displayName` | trim; omit if empty, non-string, or contains `/` | reject invalid supplied value |
| `contextWindow` | retain only a finite positive integer; otherwise omit | reject invalid supplied value |
| `inputModalities` | if not an array, omit; otherwise keep the first occurrence of each supported trimmed value in original order; omit when none survive | reject any invalid member; preserve valid order with first-occurrence de-duplication |
| `reasoningEfforts` | if not an array, omit; explicit `[]` stays `[]`; otherwise keep valid labels, de-duplicate them, and apply the existing `canonicalizeReasoningEfforts` order (`none`, `minimal`, then `low` through `ultra`); omit a non-empty source whose every member is invalid | reject any invalid member; preserve explicit `[]`; de-duplicate and apply the same existing canonical order |
| `defaultReasoningEffort` | trim and retain only when it belongs to the salvaged non-empty stored ladder; otherwise omit | reject when not a member of the final non-empty ladder |
| `codexToolMode` | retain only `code_mode_only` or `shell`; otherwise omit | persisted/whole-config rows accept only omission, `code_mode_only`, or `shell`; `null` and every other value are rejected |
| `addedAt` | trim and retain a non-empty string; otherwise omit | require a non-empty string when supplied |

After field salvage, duplicate identity handling is deterministic:

- keep the first valid row for each `id`; drop later rows with the same `id`;
- preserve distinct rows whose native IDs encode to the same routed identity during forgiving disk
  load. Existing configurations rely on the runtime/CLI ambiguity guard to refuse destructive or
  ambiguous selection; silently dropping one row would be data loss;
- preserve the relative order of surviving rows;
- if no row survives, expose `customModels` as `undefined`, not `[]`.

One bounded privacy-safe warning is emitted per load when salvage changes the field. It contains only
aggregate counts (dropped rows and omitted/canonicalized fields), never row IDs, model IDs, provider
names, raw values, or full paths. There is no warning per row and no unbounded log growth.

A valid row requires:

- non-empty string `id`, `provider`, and `modelId`;
- optional non-empty `displayName` without `/`;
- optional positive integer `contextWindow`;
- optional supported string `inputModalities` array;
- optional valid, de-duplicated `reasoningEfforts`, preserving an explicit empty array;
- optional `defaultReasoningEffort` that belongs to a non-empty stored ladder;
- optional `codexToolMode` equal to `code_mode_only` or `shell`;
- optional string `addedAt`.

`loadConfig()` is write-free: it never repairs disk bytes merely by reading. If a later authorized
mutation persists the loaded configuration, the existing config mutation/rebase transaction must
re-read the current disk revision, reject or reconcile a concurrent hand edit through its existing
conflict rules, and persist the sanitized projection only as part of that authorized mutation.
Restarting after such a write yields the same projection. A concurrent edit must never be
overwritten from a stale in-memory snapshot.

Routed-identity collisions use this exact boundary contract:

- forgiving disk load preserves every structurally valid distinct-ID member of a historical
  collision class;
- an unrelated internal field-scoped/guarded save preserves every unchanged collision member and a
  subsequent reload returns the same rows;
- strict whole-config replacement rejects every candidate containing a routed-identity collision,
  including a grandfathered class; the operator must use field-scoped edits or resolve the class;
- POST and offline CLI add reject a row colliding with any current row or applicable static roster;
- PUT/live CLI edit allow metadata-only changes on an existing collision member because provider and
  model ID are unchanged; a model-ID change that creates or enlarges a collision is rejected;
- exact stable-ID removal may remove one member and shrink/resolve the class;
- a routed/native selector matching multiple members remains ambiguous and performs no persistence.

This design deliberately does not add persisted-baseline comparison to the pure
`validateConfigCandidate(candidate)` API. That boundary remains deterministic and strict; the
existing guarded internal save is the only path that preserves unchanged historical collision
classes during unrelated mutations.

Acceptance tests cover non-array input, mixed valid/invalid rows, every field rule above, duplicate
IDs, preserved read-time routed-identity collisions, strict write rejection of those collisions,
all-invalid arrays, bounded diagnostics, raw-load write freedom,
restart stability, an unrelated authorized mutation after salvage, concurrent-disk-change handling,
and strict whole-config rejection without losing providers, API keys, accounts, or listener state.
Collision acceptance additionally covers load -> guarded unrelated save -> reload preservation,
metadata-only PUT/edit, model-ID mutation rejection, add rejection, exact-ID removal, routed-selector
ambiguity with zero writes, and strict whole-config rejection of a grandfathered class.
Out-of-order and duplicate reasoning ladders are exercised through disk salvage, strict whole-config
writes, POST, PUT, and CLI add/edit; every successful path stores the same canonical ladder so the
first-entry fallback semantics remain unchanged.

### Live management semantics

`codexToolMode` is a supported custom-model field on every editing surface.

POST accepts `code_mode_only` or `shell`; omission stores no override. `null` and every other
invalid supplied value return HTTP 400 instead of being silently ignored.

PUT semantics are:

- field absent: preserve the existing value;
- `code_mode_only` or `shell`: set the explicit override;
- `null`: clear the override and resume provider/default inheritance;
- any other supplied value: HTTP 400 without persistence or catalog convergence.

`null` is a PUT patch operation only: it deletes the persisted property. Reloading after a successful
clear returns an omitted field, never a stored `null`. Strict whole-config writes and POST reject
`null`; no successful persistence path may store it.

The exact included read/write surfaces are:

- `OcxCustomModel.codexToolMode`;
- `GET /api/custom-models` rows;
- `POST /api/custom-models` request and created row response;
- `PUT /api/custom-models/{id}` request and updated row response;
- custom rows returned by `/api/models` through `ManagementModelRow.codexToolMode`;
- CLI `ocx models list-custom --json` and its text table;
- CLI `ocx models live --json` custom rows, because they consume `/api/models`;
- CLI `ocx models add` and `ocx models edit`.

For custom rows, every included read surface exposes the stored value `code_mode_only` or `shell`,
or omits it to mean inherit. It never substitutes the computed provider-effective value. The
`list-custom` text table renders omitted as `inherit`; the `models live` text layout is unchanged to
avoid broad display churn. There is no `models show` command in scope.

Explicitly excluded surfaces are `ExportModel`, `/api/client-config`, third-party client config
serializers, generated client files, and `safeConfigDTO`: `codexToolMode` controls the Codex catalog
and is not a portable property of those clients, while `/api/custom-models` and `/api/models` are the
intended management round-trip surfaces.

Unknown-key preservation is strictly a disk/config forward-compatibility property. Every public
management API or CLI response constructs a known-field-only custom-model projection (`id`,
`provider`, `modelId`, the supported optional metadata, `codexToolMode`, and `addedAt`) and never
spreads unknown row keys. Secret-shaped unknown keys such as `apiKey`, `headers`, or future opaque
metadata may survive an authorized whole-config save when forward compatibility requires it, but
must never appear in `/api/custom-models`, `/api/models`, CLI JSON/text, or dashboard-safe DTOs.

CLI add/edit use `--tool-mode code_mode_only|shell|inherit`; `inherit` clears the stored override on
edit and is equivalent to omission on add. Runtime precedence remains:

```text
custom-model override -> provider codexToolMode -> default behavior
```

The dashboard need not add a new control in this task unless an existing generic custom-model edit
surface already renders every returned field. The required contract is API/CLI/DTO round-trip and
safe persistence; inventing unrelated GUI design is out of scope.

New Fork-specific tests are isolated in:

```text
tests/fork-custom-model-config-schema.test.ts
tests/fork-custom-model-tool-mode-contract.test.ts
```

Acceptance cases include POST omission/set/invalid/null, PUT absent/set/null/invalid, no persistence
or catalog convergence after rejection, `list-custom` JSON/text, `/api/models`, `models live --json`,
CLI add/edit/inherit, reload persistence, and confirmation that excluded safe-config/client
exports do not gain the field. PUT-clear must reload as an omitted property; strict whole-config and
POST `null` rejection must cause neither persistence nor catalog convergence. Tests with
secret-shaped unknown keys prove they survive only the intended persistence path and are absent from
every public API/CLI projection.

## Local vendored-package staging

The tracked root `package.json` must never be modified to produce a local package. Atomic replacement
alone prevents partial JSON but still leaves a semantic crash window in which the tracked manifest
contains temporary `bundleDependencies`.

The selected design builds an owner-only staging package tree. Preparation runs once against the
source tree before staging through the existing `build:gui` -> `prepare:package` flow. The staged
pack uses `npm pack --json --ignore-scripts`; it does not run `prepack` because the staged package
surface deliberately excludes `scripts/` and the generated package artifacts have already been
prepared and verified in the source tree.

The complete staging layout is:

```text
<owned-stage>/package/package.json
<owned-stage>/package/<every path declared by package.json files>
<owned-stage>/package/node_modules/<current installed dependency tree>
<owned-stage>/validation/
```

The staged manifest is a semantic copy of the root manifest with exactly one intended change:
`bundleDependencies` is set to the sorted top-level runtime dependency names. Name, version, files,
scripts, bin, main, exports, dependencies, optional dependencies, peer dependencies, engines,
trusted dependencies, and all unrelated metadata remain equal.

The current installed `node_modules` tree is copied into staging so npm sees the same hoisted and
nested dependency graph that the existing root pack uses. The copier walks with `lstat`, resolves
every symlink or Windows junction with `realpath`, requires the resolved source to remain inside the
root `node_modules`, materializes the target as a regular copied file/directory, preserves executable
mode bits where the platform exposes them, and rejects sockets, devices, escaping links, cycles,
missing targets, or paths outside the owned staging root. Platform-specific optional packages that
exist in the current installation are copied; absent optional packages remain absent. npm's
`bundleDependencies` packlist then selects only declared runtime dependencies and their resolvable
transitive closure, not unrelated dev packages.

Every source entry is canonicalized before its type is consumed, so an ancestor symlink or Windows
junction cannot bypass containment. A root `files` entry that is itself a link is rejected. Links
encountered inside a declared directory may be materialized only when their target remains inside
that declared directory's canonical subtree, not merely elsewhere in the repository. `node_modules`
links remain bounded to the canonical root `node_modules` tree because Bun/npm hoisting links are part
of the installed dependency topology.

The sequence is:

1. create a temporary directory with restrictive permissions;
2. run existing source preparation and verify its generated artifacts before staging;
3. copy the manifest, every declared package path, and the contained materialized `node_modules`
   tree into staging;
4. inject sorted runtime dependency names into only the staged manifest;
5. execute `npm pack --json --ignore-scripts` with cwd at the staged package root;
6. validate exactly one regular, non-symlink tarball, npm's JSON pack manifest, integrity metadata,
   and expected package identity;
7. install the tarball with `--ignore-scripts` into the owned validation prefix without registry
   access, then verify package identity, bin/main/exports targets, generated artifacts, every declared
   bundled direct dependency, and their runtime-resolvable transitive dependencies;
8. keep the validated tarball and owned npm cache inside the staging directory and pass both to the
   existing local-install lifecycle, avoiding a cross-volume transfer entirely;
9. remove validation and staging ownership after lifecycle success or failure without masking the
   primary error.

The root manifest is checked byte-for-byte before preparation, after preparation, after pack, after
validation, and after lifecycle cleanup. The staging implementation is
cross-platform Node/Bun TypeScript and must not rely on shell copy commands, symlink traversal, or
platform-specific path syntax. If the existing `files` declaration, installed dependency closure,
or npm packing semantics cannot be reproduced exactly from a staged tree, implementation stops
rather than falling back to direct root mutation. A fallback design would require a separate
approved change.

The existing `tests/install-local-vendor.test.ts` is itself defective and is directly modified under
the user's explicit instruction to repair all Important findings. Temporary directories use Bun test
lifecycle cleanup (`afterEach` or `afterAll`) instead of a module-level loop that runs before tests.
Tests cover root-manifest immutability, staged dependency injection, callback/pack failure, cleanup,
regular-file validation, and package-surface equivalence. Tests inspect the packed result through
npm's pack manifest plus an isolated `npm install --ignore-scripts` extraction. They prove that
non-dependency package entries and executable modes match the intended root package surface, every
bundled dependency is present and runtime-resolvable, no undeclared repository file or escaping link
enters the package, identity/bin/main/exports/generated assets remain correct, and root manifest
bytes survive preparation, pack failure, validation failure, lifecycle failure, and cleanup failure.
When cleanup and another phase both fail, the earlier phase remains the primary error and cleanup is
reported as an aggregate/secondary failure.

Pack evidence is exact: recompute SHA-512 SRI and SHA-1 from accepted tarball bytes and compare them
with non-empty, strictly formatted `npm pack --json` values. Parse every returned file row, reject
duplicates, absolute/dot-segment/sensitive entries, and require each row to belong to the declared
package surface or npm-selected bundled dependency closure. The disposable installed result must
contain every declared root `files` entry and every local target reachable from string/object/array/
conditional `main`, `bin`, and `exports` metadata; targets must remain inside the installed package.

The final global install uses the same owned cache and fail-closed network policy as validation:

```text
npm install -g --ignore-scripts --offline --no-audit --no-fund --package-lock=false \
  --cache <owned-stage-cache> <absolute-tarball>
```

It never retries without `--offline`, so the destructive replacement consumes the exact
self-contained artifact already validated rather than registry/cache additions outside the stage.

Before preparation succeeds, the Bun dependency extracted into the disposable validation prefix
must pass both the existing non-placeholder size check and a bounded current-platform execution
probe: invoke that exact extracted binary with `--version`, enforce a 5-second timeout, require exit
status 0, and require a plausible semantic Bun version line. Spawn errors, timeouts, nonzero exits,
large junk files, or incompatible-platform binaries fail before global uninstall. The probe is an
injectable seam for tests and never invokes the launcher's network-capable `install.js` fallback.

## GUI sidecar test and active Logs evidence

The current production layout uses a vertical main axis with:

```css
justify-content: flex-start;
align-items: stretch;
```

`gui/tests/sidecar-layout.test.ts` contains two tests with the same name; the later stale duplicate
incorrectly requires `justify-content: space-between`. The repair removes the contradictory duplicate
and retains the assertions matching the production layout and current comments. Production CSS is
not changed unless a fresh failing characterization proves a separate behavior defect.

This is an explicit exception to the local new-test-file preference because the finding is inside an
existing contradictory test file and cannot be repaired without editing it.

`FORK_CHANGES.md` gains an active GUI Logs/Debug entry that records the current code, nine recovery
locale mappings, provider/surface/route/recovery display, and relevant GUI tests. It must distinguish
the Fork surface from official v2.38's unrelated Aside/rollback UI and retain exact current blob/test
evidence.

## Maintenance truth updates

`FORK_CHANGES.md` must describe the current implementation, not the pre-Volcengine ben.1 tree. The
active GLM/Kimi/Volcengine section records:

- the final `src/fork/glm-kimi-compat.ts` blob;
- empty-assistant replay cleanup and its ordering before trailing-user compatibility;
- `tests/fork-volcengine-empty-assistant-content.test.ts`;
- the new weekly-quota test and Ark quota module where appropriate.

`tests/fork-maintenance-truth.test.ts` asserts current evidence rather than preserving stale blob
strings. Historical blobs remain only in explicitly historical sections.

The current audit table records the final implementation HEAD, package version, target tag, shortstat,
official base, complete overlap/conflict account, validation boundary, and pending external release
state. It must not claim a tag, push, CI run, or GitHub Release that has not occurred.

## Out of scope

The following non-blocking or conditional observations are recorded but not implemented:

- strengthening `/api/providers/test` to validate Zhipu `models[].slug` exactly like discovery;
- teaching update badges about registry-published same-base `ben.N+1` revisions while the Fork does
  not publish npm packages;
- replacing GitHub's external-contributor approval policy with a repository-internal self-hosted
  runner security boundary that a pull request cannot edit;
- live provider validation requiring credentials or globally replacing/restarting OpenCodex;
- unrelated refactors of Responses, catalog, GUI, installer, or release modules.

## Implementation and commit boundaries

Implementation is inline in the current workspace; no worktree is created. Changes are grouped by
independently understandable function, with Chinese commit messages by default:

1. rebase/release truth contract and its RED/GREEN tests;
2. Ark weekly quota compatibility;
3. `customModels` schema and `codexToolMode` management contract;
4. staged local packaging and test cleanup;
5. GUI sidecar test repair;
6. `2.38.0-ben.2` version and final implementation evidence;
7. trailing `FORK_CHANGES.md` documentation commit.

Process documents, review findings, or test phases do not become artificial commit boundaries.

## Verification

Each behavior change follows RED -> GREEN. New Fork behavior uses dedicated new test files unless the
finding is an existing defective test. Required focused evidence includes:

```text
tests/fork-maintenance-truth.test.ts
tests/fork-version-policy.test.ts
tests/release-version-line.test.ts
tests/fork-ci-official-baseline.test.ts
tests/fork-ark-weekly-quota.test.ts
tests/fork-volcengine-empty-assistant-content.test.ts
tests/fork-custom-model-config-schema.test.ts
tests/fork-custom-model-tool-mode-contract.test.ts
tests/install-local-vendor.test.ts
tests/install-local.test.ts
gui/tests/sidecar-layout.test.ts
```

Final gates run against the final implementation/document state:

```bash
bun run typecheck
bun run lint:gui
bun run build:gui
bun run privacy:scan
bun run prepush
```

`bun run prepush` must complete in the current task with an attributable exit code and zero-failure
summary. Passing focused tests do not substitute for it. Platform-specific validation that was not
executed is reported explicitly.

## Review gates

The design Spec requires independent `SPEC_DOCUMENT` approval before a Plan is written. The Plan
requires independent `PLAN_DOCUMENT` approval before implementation. Implementation tasks use
independent `SPEC_COMPLIANCE` and `CODE_QUALITY` reviewers. Packaging, release topology, CI, and
dependency-installation changes receive an additional security-focused review. Critical and Important
findings block; fixes return to the same reviewer with `REVIEW_PHASE: RE_REVIEW`, complete prior
findings, scoped fix diff, and real verification evidence.

No tag, push, branch promotion, GitHub Release, global installation, service replacement, restart,
or repair is authorized by this design.

# Trendymen fork changes

This document is the maintainer source of truth for the committed differences
between [`Trendymen/opencodex`](https://github.com/Trendymen/opencodex) and the
latest verified stable release of
[`lidge-jun/opencodex`](https://github.com/lidge-jun/opencodex).

It describes capabilities that are present in the current fork, not proposals
from old Specs, Plans, devlogs, mutable installed packages, or abandoned
experiments. Update it during every stable-release rebase and whenever a fork
capability changes. After the rebased implementation is committed, refresh this
document from that exact implementation SHA, run the final required validation
with the refreshed document present, and then make the document the terminal
commit before the validated branch is pushed.

## Status model

| Status | Meaning | Required rebase action |
| --- | --- | --- |
| **Fork-only — keep** | The stable upstream tag does not provide the capability. | Preserve the behavior and its tests. Keep high-churn upstream wiring minimal. |
| **Partially covered — keep delta** | Upstream provides the base mechanism but not the complete fork behavior. | Re-evaluate the boundary and retain only the unprovided behavior. |
| **Upstream-covered — removed** | Upstream now provides an equivalent or better behavior and the local patch has been removed. | Keep the historical row and record the upstream evidence. |
| **Replaced/removed** | A local implementation was superseded, disproved, or intentionally removed. | Do not reintroduce it during conflict resolution. |
| **Known gap** | The intended fork behavior is incomplete or its acceptance evidence is missing. | Do not report the capability as fully closed; fix or re-verify it explicitly. |

An upstream implementation counts as coverage only when current source and
tests establish equivalent behavior. Similar names, old design documents, or a
single successful HTTP response are not sufficient.

## Current audited baseline

| Item | Value |
| --- | --- |
| Audit date | 2026-08-28 |
| Latest stable upstream Release | [`v2.34.0`](https://github.com/lidge-jun/opencodex/releases/tag/v2.34.0) |
| Upstream Tag commit | `80fff9a7f47332a4445df2b26ea175053fa55b0b` |
| Upstream default branch at audit | `upstream/main` at the same commit; the Tag is reachable from `main` |
| Audited fork implementation HEAD | `9703c79e47f9f3a29b83a16f9575e7925951e3be` |
| Audited implementation commits above the Tag | `d741f7bd6` (runtime compatibility), `9703c79e4` (local installation and maintenance gates) |
| Committed patch surface | 58 files, 5,370 insertions, 99 deletions |
| Release marker | `origin/upstream-release` points to the upstream Tag commit |

The audited fork HEAD is the implementation parent of the commit that first
adds this document. Future updates should record the implementation HEAD being
audited rather than trying to make the document refer to its own commit SHA.

## Active runtime differences

### Volcengine Agent Plan GLM/Kimi compatibility

- **Status:** Fork-only — keep.
- **Fork behavior:** Exact-gated compatibility for `openai-responses` at
  `https://ark.cn-beijing.volces.com/api/plan/v3`. GLM-5.3 and Kimi-K3 receive
  a trailing user turn when Ark rejects assistant prefill. Kimi-K3 function
  schemas lower `$defs`, `$ref`, `oneOf`, `allOf`, and root `anyOf` under bounded
  depth/node budgets while preserving nested `anyOf`, tool names, descriptions,
  visible properties, and the original App-side schema.
- **Code:** `src/fork/glm-kimi-compat.ts`, with minimal lifecycle wiring in
  `src/adapters/openai-responses.ts` and Ark snapshot-repair selection in
  `src/server/responses/core.ts`.
- **Evidence:** `tests/fork-glm-kimi-compat.test.ts` and
  `tests/fork-kimi-schema-compiler.test.ts`, including a synthetic 39-entry
  catalog that matches the observed tool-count boundary, bounded fallback,
  persistence limits, and POSIX modes. An isolated direct Responses request
  with the observed 39-schema catalog succeeded during this audit, but that
  output is not an immutable repository fixture and is not a Codex App replay;
  treat it as a historical observation rather than committed regression proof.
- **Upstream comparison:** `v2.34.0` has provider schema normalization, but no
  exact Ark/Kimi compiler, prefill repair, or schema-catalog diagnostics.

### Native Responses message-phase inference

- **Status:** Partially covered — keep delta.
- **Fork behavior:** Provider opt-in through
  `inferResponsesMessagePhaseModels`; hard exclusion for GPT/OpenAI model IDs
  and OpenAI-operated destinations; matching SSE and non-streaming JSON
  semantics; a bounded barrier distinguishes commentary before later work from
  the final answer and preserves explicit upstream phases.
- **Code:** `src/fork/responses-message-phase.ts` plus configuration,
  management API, eager-relay, SSE rewrite, and Responses-core wiring.
- **Evidence:** `tests/responses-message-phase-config.test.ts`,
  `tests/responses-message-phase-passthrough.test.ts`, and
  `tests/responses-message-phase-rewrite.test.ts`.
- **Upstream comparison:** Upstream already infers phases for bridged adapter
  events in `src/bridge.ts`, but does not provide configurable inference for
  native Responses passthrough. Do not remove the fork state machine merely
  because the bridge has a similarly named phase path.

### Nested code-mode tool repair

- **Status:** Partially covered — keep delta.
- **Fork behavior:** Converts model-emitted top-level `functions.exec` or
  `web__run` calls into the one declared `exec` custom tool only when the
  current turn's structured tool catalog and lowering facts authorize it.
  Fragmented adapter events and passthrough SSE are buffered atomically;
  malformed, ambiguous, duplicated, over-budget, or conflicting calls fall
  through to the existing undeclared-tool guard. Continuation cache state is
  committed only after the client receives a valid terminal result.
- **Code:** `src/responses/nested-exec-call-repair.ts`,
  `src/responses/nested-exec-adapter-events.ts`,
  `src/server/responses-nested-exec-call-repair.ts`, and
  `src/chat/nested-exec-eligibility.ts`, with bounded wiring in
  `src/server/responses/core.ts`.
- **Evidence:** `tests/nested-exec-eligibility.test.ts`,
  `tests/nested-exec-repair-context.test.ts`, and
  `tests/nested-exec-repair.test.ts`.
- **Upstream comparison:** Upstream commit `cb9bb9b7634640f18568207322d386a059f6c9ac`
  already bridges bare `exec_command` / `apply_patch` helpers through unified
  `exec` in `src/responses/code-mode-helper-compat.ts` and
  `src/server/responses-custom-tool-repair.ts`, with coverage in
  `tests/responses-custom-tool-repair.test.ts`. The remaining fork delta is the
  `functions.exec` / `web__run` aliases, stricter current-turn authorization,
  atomic adapter/SSE buffering, and coordinated continuation-cache commitment.

### Ark quota presentation in Codex Desktop

- **Status:** Fork-only — keep, with a known gap.
- **Fork behavior:** A recognized permanent Ark usage-quota 429 becomes a
  non-retryable HTTP 400 `invalid_request_error` with code
  `volcengine_usage_quota_exhausted`, preserving Ark's complete message and
  removing `Retry-After`. This prevents Codex Desktop's generic retry-limit or
  ChatGPT subscription-quota UI from replacing the provider's reset time.
- **Code:** `src/fork/ark-quota-display.ts` and the non-2xx passthrough boundary
  in `src/server/responses/passthrough-error.ts` / `src/server/responses/core.ts`.
- **Evidence:** `tests/fork-latest-compat.test.ts` and
  `tests/retry-after-429.test.ts` cover the observed five-hour quota form.
- **Known gap:** Ark now also emits `weekly usage quota`. The current matcher
  accepts an optional numeric `N-hour` window but not `weekly`, so a real weekly
  quota response remains HTTP 429 and Codex displays `exceeded retry limit`.
  This capability must not be marked fully closed until that form is covered
  and re-verified.
- **Upstream comparison:** Upstream provides the generic passthrough-error and
  Retry-After pipeline, but no Ark-specific client presentation.

### Routed custom-tool output normalization

- **Status:** Partially covered — keep delta.
- **Fork behavior:** When a routed `custom_tool_call_output` is lowered to
  `function_call_output`, its output is guaranteed to be a string: strings are
  preserved, text/refusal parts are joined in order, and opaque values fall
  back to JSON serialization.
- **Code:** `src/fork/custom-tool-output.ts` and
  `src/responses/custom-tool-compat.ts`.
- **Evidence:** `tests/custom-tool-compat.test.ts` and
  `tests/fork-latest-compat.test.ts`.
- **Upstream comparison:** Upstream changes the item type but can leave Codex
  content-part arrays on the string-only function-output wire contract.

### Provider diagnostics and bounded persistence

- **Status:** Partially covered — keep delta.
- **Fork behavior:** Debug-gated outbound-shape diagnostics record provider,
  model, endpoint shape, tool/schema counts, input-tail roles, byte counts, and
  compatibility actions without logging request bodies, keys, or tool
  arguments. Debug lines persist to a bounded `provider-debug.jsonl`; Kimi
  schema catalogs are stored separately with file, directory, count, ownership,
  and permission limits.
- **Code:** `src/fork/outbound-debug.ts`, `src/fork/debug-persistence.ts`, and
  the diagnostic portions of `src/fork/glm-kimi-compat.ts`.
- **Evidence:** `tests/fork-debug-persistence.test.ts` and
  `tests/fork-kimi-schema-compiler.test.ts`.
- **Upstream comparison:** Upstream provides `debugProviderDiagnostic` and an
  in-memory ring buffer, but not the fork's durable log or outbound request-shape
  summary.

### Third-party reasoning summary and GPT continuation sanitation

- **Status:** Partially covered — keep delta.
- **Fork behavior:** DeepSeek terminal reasoning retains opaque/encrypted state
  and raw content while adding the summary channel needed by Codex. When the
  same history later targets native OpenAI GPT, third-party opaque tokens backed
  by raw `reasoning_text` are removed while genuine OpenAI blobs remain.
- **Code:** `src/server/responses-reasoning-summary-rewrite.ts` and the
  reasoning-input sanitizer in `src/adapters/openai-responses.ts`.
- **Evidence:** `tests/deepseek-reasoning-replay.test.ts`,
  `tests/responses-reasoning-summary-passthrough.test.ts`, and
  `tests/responses-reasoning-summary-rewrite.test.ts`.
- **Upstream comparison:** Upstream already rewrites ordinary reasoning text to
  summary events and sanitizes several replay forms. The fork delta is opaque
  terminal preservation and cross-provider raw-backed blob removal, not the
  whole reasoning pipeline.

### SSE block-rewrite flushing

- **Status:** Fork-only — keep as internal infrastructure.
- **Fork behavior:** `SseBlockRewrite.flush` propagates retained blocks through
  later rewrite stages on clean EOF in the pull relay and before an eager
  relay's synthetic failure tail, but only for rewrites that implement the
  optional method. The current message-phase barrier implements `flush`.
  Ordinary pull-relay reader errors dispose without flushing, and the current
  nested-exec barrier has `dispose` but no `flush`; its retained state is
  rejected and released on teardown rather than emitted.
- **Code:** `src/server/sse-payload-rewrite.ts` and
  `src/server/relay-eager.ts`.
- **Evidence:** `tests/sse-payload-rewrite.test.ts` and
  `tests/relay-eager.test.ts` cover clean EOF, composed flush propagation, and
  eager failure-tail behavior. Reader-error and nested-exec teardown are
  boundaries, not flush guarantees.
- **Upstream comparison:** The stable tag has block rewrites but no flush
  contract or composed flush propagation.

### Standalone web-search capability injection

- **Status:** Fork-only — keep.
- **Fork behavior:** Generated Codex provider tables include
  `supports_standalone_web_search = true`, allowing Codex's client-owned
  `exec`/`web__run` path when `[features].standalone_web_search` is enabled.
- **Code:** `src/codex/inject.ts`.
- **Evidence:** An isolated configuration exposed the standalone surface during
  development, but the observation is not retained as immutable evidence tied
  to this audit HEAD. The current committed suite lacks a focused assertion for
  the new provider-table line; treat live acceptance as unverified for this
  audit and add a focused assertion when this code is next changed.
- **Upstream comparison:** `v2.34.0` does not contain the capability key.

## Active maintenance, packaging, and test differences

### Local source-package installation

- **Status:** Fork-only — keep separate from runtime compatibility.
- **Fork behavior:** `bun run install:local` builds the GUI, creates and
  validates a repository-local regular `.tgz` through `npm pack --json`, stops
  the existing installation safely, replaces the global package, and restores
  the prior service mode. Unknown service state and a still-running
  non-Scheduler service fail closed.
- **Code:** `scripts/install-local.ts`, the `install:local` package script,
  fork package version, and root-local package ignore rule.
- **Evidence:** `tests/install-scripts.test.ts` pins ordering, package-path
  validation, and service-state decisions. Treat these as unit/static contract
  evidence; a real global replacement and background-service restart remains a
  separate acceptance layer whenever installer behavior changes.
- **Upstream comparison:** The stable tag and current upstream development
  branch have no equivalent local source installer.

### Default test runner and load-sensitive isolation

- **Status:** Partially covered — keep only the remaining delta.
- **Fork behavior still present:** `tests/server-auth.test.ts` runs in the
  existing one-worker serial lane; three WebSocket watchdogs use a test-only
  three-second bound. Launcher/update tests avoid environment-specific runtime
  shims and unsupported PATH interception.
- **Code:** `scripts/test.ts`, `tests/test-runner.test.ts`,
  `tests/server-auth.test.ts`, `tests/shutdown-launcher.test.ts`, and
  `tests/update-stop-first.test.ts`.
- **Upstream comparison:** `v2.34.0` already owns the default isolated
  `--parallel=4` main lane, machine lock, and declarative serial lanes. Those
  base capabilities are not fork-owned. The remaining active runner delta is
  the `server-auth` serial membership and test-only host-stability changes.

### Prepush and GitHub CI

- **Status:** Upstream-covered — no active fork delta.
- **Evidence:** The `prepush` package script matches `v2.34.0`, and `.github/`
  has no committed diff from the Tag. Do not attribute the upstream prepush or
  cross-platform workflows to this fork.

## Replaced, removed, or disproved fork directions

These entries are intentionally retained so a later conflict resolution does
not resurrect them.

| Direction | Status | Current decision |
| --- | --- | --- |
| Dynamic `scripts/fork-test-runner.ts` with local-only worker groups and quarantine lists | Upstream-covered / removed | Upstream's stable runner now owns bounded isolation and serial lanes. The custom runner is absent; retain only the explicit `server-auth` lane delta. |
| Kimi tool-name exclusion and automation-specific schema lowering | Replaced/removed | Replaced by the exact-gated generic function-schema compiler. Do not restore tool allowlists or filter the 39-tool App catalog. |
| `src/server/responses-message-phase-rewrite.ts` | Replaced/removed | The implementation moved into `src/fork/responses-message-phase.ts`; the old path is not an active capability or an upstream removal. |
| Kimi-triggered `normalizeResponsesToolResultAdjacency` | Disproved/removed | Parallel `call A, call B, output A, output B` is valid. Kimi must not activate adjacency normalization; the current code gates it only on `requiresAdjacentResponsesToolResults`. |
| Codex `usage_limit_reached` plus promo-header quota rendering | Disproved/removed | It invokes the global ChatGPT quota component and can replace Ark's reset time. Keep the provider-specific client-error representation instead. |
| Fork-specific MiniMax fixed-port test workaround | Removed as unnecessary | The final maintenance commit does not carry the MiniMax test patch. Do not re-add it unless a fork-caused failure is independently reproduced against the same upstream baseline. |

## Current known gaps and verification boundaries

1. **Weekly Ark quota display:** the matcher does not yet recognize `weekly
   usage quota`; this is a confirmed live gap.
2. **Standalone web-search injection:** real configuration behavior was
   observed, but the exact injected line lacks focused committed test coverage.
3. **Local installer acceptance:** static/unit coverage does not replace a real
   package replacement plus restoration of the pre-existing service mode.
4. **External provider acceptance:** focused tests and HTTP success are separate
   from a real Codex App replay. Record provider/model, client terminal state,
   and redacted outbound evidence for K3, nested-exec, phase inference, and
   DeepSeek reasoning after relevant changes.
5. **Concurrent worktree state:** compute this inventory from committed SHAs.
   Never include unrelated uncommitted files merely because they were present
   while the rebase document was updated.

## Required update on every stable-release rebase

1. Query GitHub Releases and accept only a non-draft, non-prerelease stable
   Release. Verify its Tag commit is reachable from upstream `main`.
2. Require a clean worktree/index with no in-progress Git operation. Record the
   exact local/remote `main`, `upstream-release`, and local/remote `sync/<tag>`
   SHAs. If a remote candidate exists, fetch and preserve it: create a missing
   local candidate from that exact remote SHA, continue only when local and
   remote candidates are identical and their origin is understood, and stop on
   remote-only commits, divergence, or ambiguous provenance. Only when no
   remote candidate exists may a new candidate be created from recorded
   `main`. Perform the rebase on `sync/<tag>` itself; do not move `main` during
   rebase or validate a detached commit.
3. Re-evaluate every active row against the new Tag's source and tests:
   - equivalent or better upstream behavior: remove the fork patch, mark
     **Upstream-covered — removed**, and cite the upstream file/test/commit;
   - partial coverage: shrink the fork boundary and document the remaining
     behavioral delta;
   - no coverage: retain the fork behavior and its focused tests.
4. Complete and commit all implementation/conflict fixes on the candidate.
   Preliminary focused checks may run while the implementation is changing,
   but they do not replace the final validation below.
5. Capture the candidate `IMPLEMENTATION_HEAD`. Regenerate the baseline,
   patch commits, shortstat, statuses, removed/replaced decisions, known gaps,
   and acceptance boundaries from that exact SHA. Do not turn a stale prior
   PASS into evidence for the rebased implementation.
6. With the refreshed document present, run final validation proportionate to
   the changed surface. Shared runtime, adapters, server, scripts, or runner
   changes require the repository's full prepush gate; documentation-only
   updates require at least link/path review, privacy scanning, and a real diff
   check. If validation causes an implementation change, commit it and repeat
   steps 5–6 with the new implementation SHA.
7. Commit only this document as the terminal documentation commit. Verify that
   its parent is exactly `IMPLEMENTATION_HEAD` and that no implementation file
   is part of the documentation commit. Before committing, verify the staged
   name list contains only this file and run the staged diff check; after
   committing, run `git diff --check HEAD^ HEAD`. Any later implementation
   change must repeat steps 4–7.
8. Promote the terminal candidate SHA to remote `main` and `sync/<tag>`, and the
   unmodified official Tag SHA to remote `upstream-release`, in one atomic push
   with explicit source/destination refspecs and explicit expected-SHA
   `--force-with-lease` values captured in step 2. If any lease drifts or atomic
   push is unavailable, fail closed; never fall back to ordinary force push or
   partially update the three refs.
9. After the atomic push succeeds, align local `main` and `upstream-release` to
   the pushed SHAs without changing the checked-out validated candidate.

The same inventory must also be updated when a normal fork feature commit adds,
removes, replaces, or materially changes one of the capabilities above; the
stable-release rebase is the mandatory full re-audit point.

## Audit commands

The following commands are the minimum reproducible inventory; adapt remote
names only when the repository configuration actually differs.

```bash
gh api repos/lidge-jun/opencodex/releases/latest
git fetch --all --prune --tags
git rev-parse refs/tags/<tag>^{}
git merge-base --is-ancestor refs/tags/<tag>^{} upstream/main
# Run the remaining commands after the terminal documentation commit.
IMPLEMENTATION_HEAD=$(git rev-parse HEAD^)
test "$(git diff-tree --no-commit-id --name-only -r HEAD)" = "FORK_CHANGES.md"
git log --reverse --oneline <tag>..$IMPLEMENTATION_HEAD
git diff --name-status <tag>...$IMPLEMENTATION_HEAD
git diff --shortstat <tag>...$IMPLEMENTATION_HEAD
git diff --check <tag>...$IMPLEMENTATION_HEAD
git diff --check HEAD^ HEAD
```

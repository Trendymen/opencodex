# Code-mode Nested Web Call Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every current Agent Plan and DeepSeek official routed model complete Codex client-owned standalone web search without leaking nested `web__run/functions.exec` as top-level calls across Responses, Chat Completions, and Claude Messages protocol paths.

**Architecture:** Preserve Codex's native `custom:exec` surface and existing `/v1/alpha/search` relay. Add generic exec-lowering guidance plus one pure alias normalizer. Responses passthrough uses the existing complete-payload/SSE barrier; Chat/Claude routed adapters use a bounded `AdapterEvent` barrier before the common bridge. All three protocol entries share request-local authorization, direct-declaration precedence, budgets, replay normalization, and the final undeclared-tool guard.

**Tech Stack:** Bun strict TypeScript, OpenAI Responses JSON/SSE, OpenAI Chat Completions, Claude Messages, internal `AdapterEvent`, Codex CLI 0.149, existing `TranslatorBudget`, temporary Bun protocol tests, real isolated-CODEX_HOME wire observers.

**Spec:** [Codex client-owned web.run compatibility design](../specs/2026-08-26-codex-client-web-run-passthrough-design.md)

## Global Constraints

### Variable Contract

- `$PACKAGE_ROOT` is the absolute, regular, non-symlink installed package root reported by `ocx ready --json`; abort if the PID/uid/command/package-root attestation does not resolve to that root.
- `$CODEX_HOME` is the read-only source directory for the user's main Codex `config.toml`, auth, hooks, agents, rules, skills, plugins, catalog and cache. Never write into it; clone it into a temporary home for validation.
- `$OPENCODEX_HOME` is the OpenCodex state root that contains its user-managed `config.json` and `patch-backups/`. Backup/recovery may create and use only its `patch-backups/` child; never mutate its `config.json`.
- Quote every expanded path. Before copying, restoring, or deleting, resolve the target and prove it is inside the intended `$PACKAGE_ROOT`, temporary home, or `$OPENCODEX_HOME/patch-backups/` root; otherwise abort.

- Work directly in `$PACKAGE_ROOT` (the installed OpenCodex package root); do not create a worktree.
- Never add a top-level `web__run` declaration, overlay, model/provider allowlist, hosted-tool strip, search state machine, or alpha alias.
- Do not modify `src/server/search.ts`, `src/server/index.ts`, `src/responses/namespace-tool-compat.ts`, catalog policy, or `responsesSnapshotRepair`.
- Direct current-turn declarations take precedence: explicit top-level `web__run`, `functions.exec`, and namespace `web.run` are never repaired.
- Unknown, malformed, ambiguous, incomplete, or over-budget aliases remain unchanged and reach the existing final generic guard.
- Main `~/.codex/config.toml`, auth, hooks, MCP, agents, rules, skills, and plugins remain unchanged. Validation uses clone-on-write temporary homes.
- Ark `partial/prefill` is out of implementation scope. If it remains after zero nested-tool leakage, stop and open a separate Spec.
- The installed package has no `tsconfig.json` or persistent tests. Use temporary `bun test`, module load, scoped no-index diff, and real CLI evidence.
- Responses, Chat Completions, and Claude Messages are all in scope. A model supporting `/responses` is not a reason to leave its actual `openai-chat` or `anthropic` route unrepaired.

---

### Task 0: Recoverable Preflight

**Files:**
- Back up: `src/responses/custom-tool-compat.ts`
- Back up: `src/server/responses/core.ts`
- Back up: `src/server/responses-undeclared-tool-guard.ts`
- Back up: `src/server/chat-native.ts`
- Back up: `src/server/claude-messages.ts`
- Record absent-before: `src/responses/nested-exec-call-repair.ts`
- Record absent-before: `src/responses/nested-exec-adapter-events.ts`
- Record absent-before: `src/server/responses-nested-exec-call-repair.ts`
- Hash-only baseline: `src/responses/namespace-tool-compat.ts`
- Hash-only baseline: `src/server/search.ts`
- Hash-only baseline: `src/server/index.ts`
- Hash-only baseline: `src/server/responses-snapshot-repair.ts`
- Hash-only baseline: `$CODEX_HOME/config.toml`

**Interfaces:**
- Produces: a `0700` package-source manifest backup under `$OPENCODEX_HOME/patch-backups/`, `0600` copies, present/absent/mode/SHA-256 records, and a root-validated restore script.
- Consumes: current `@bitkyc08/opencodex@2.33.0`, ready proxy PID/package root, and the restored generic guard hash `6e023eec3dc7b2f81ff00b40c4dd8f2203c48daaff58fd0696a75ce2f4e3c1a6`.

- [ ] **Step 1: Verify exact runtime and source baseline**

Run `ocx ready --json --wait --timeout 20`, verify PID/uid/command/package root, and assert the generic guard matches the recorded restored hash. Stop if any target is a symlink, non-regular file, or escapes the package root.

- [ ] **Step 2: Create and verify the backup**

Use `umask 077` plus `mktemp -d "$OPENCODEX_HOME"/patch-backups/20260826-nested-exec-repair-XXXXXX`. Record all three new files as absent-before; copy all five existing package change targets. Record hash-only baselines and main-config hash. Do not include user-managed OpenCodex provider config or Codex catalog in the code rollback manifest.

- [ ] **Step 3: Rehearse restoration**

Create a disposable mirror, mutate present targets, create absent-before targets, run the restore script against the mirror, and assert every mode/hash/absent state. Never point the rehearsal at the installed package.

### Task 1: Strengthen Generic Exec Lowering Guidance

**Files:**
- Modify: `src/responses/custom-tool-compat.ts`
- Test: `/tmp/opencodex-exec-guidance.test.ts`

**Interfaces:**
- Consumes: `rewriteRoutedCustomToolsForUpstream(body, supportsResponsesCustomTools)`.
- Produces: the same lowered `function:exec` schema with an exact nested-tool routing instruction in `parameters.properties.input.description`; all existing return types and sets remain unchanged.

- [ ] **Step 1: Write the failing guidance test**

Create a raw `custom:exec` declaration whose description contains a sentinel plus a Codex `web__run` tool segment. Assert after lowering with `supportsResponsesCustomTools=false`:

```ts
expect(lowered.tools[0].name).toBe("exec");
expect(lowered.tools[0].type).toBe("function");
expect(lowered.tools[0].description).toBe(rawDescription);
expect(lowered.tools[0].parameters.properties.input.description).toContain(
  "Never emit nested tool names such as web__run or functions.exec as top-level function calls",
);
```

Run the exec fixture with `supportsResponsesCustomTools` set to `true`, `false`, and `undefined`; all three must continue lowering to `function:exec` and differ from baseline only by the new guidance text. For native-passthrough regression, use `custom:apply_patch`: `true`/`undefined` remain raw custom, while `false` follows its existing lowering path. A non-exec lowered custom tool retains the existing generic input description.

- [ ] **Step 2: Verify RED**

Run `bun test /tmp/opencodex-exec-guidance.test.ts`. Expected: only the new exact exec-guidance assertions fail; all existing exec-lowering and apply-patch passthrough expectations already pass.

- [ ] **Step 3: Implement the minimal guidance**

Change only the `value.name === "exec"` input-description branch. The text must state:

```text
JavaScript source for unified exec. This exact exec function is the only top-level entry for code-mode nested tools. Invoke nested tools inside JavaScript with await tools.<name>(...), and use text(...) to return their result. Never emit nested tool names such as web__run or functions.exec as top-level function calls.
```

Do not alter the original tool description, function name, parameters shape, conversion sets, call IDs, or response restoration.

- [ ] **Step 4: Verify GREEN**

Run the guidance test and `bun run src/cli/index.ts --help`. Expected: all pass/load.

### Task 2: Add the Complete-Payload Repair

**Files:**
- Create: `src/responses/nested-exec-call-repair.ts`
- Test: `/tmp/opencodex-nested-exec-payload.test.ts`

**Interfaces:**
- Produces:

```ts
export type NestedExecRepairPlan = Readonly<{
  execWireName: "exec";
  repairFunctionsExec: boolean;
  repairWebRun: boolean;
}>;

export type NestedExecRepairResult = Readonly<{
  value: unknown;
  outcome: "unchanged" | "repaired" | "rejected";
}>;

export const NESTED_EXEC_MAX_ARGUMENT_BYTES = 64 * 1024;
export type CurrentTurnExecDeclaration = Readonly<{
  kind: "custom" | "function";
}>;
export function findUniqueCurrentTurnExecDeclaration(
  body: unknown,
): CurrentTurnExecDeclaration | undefined;
export function buildNestedExecRepairPlan(args: {
  execWasLowered?: boolean;
  execIsDeclaredOnWire?: boolean;
  directlyDeclaredWireNames: ReadonlySet<string>;
}): NestedExecRepairPlan | undefined;
export function repairNestedExecCallsInPayload(
  value: unknown,
  plan: NestedExecRepairPlan,
): NestedExecRepairResult;
export function repairNestedExecCallsInJson(
  text: string,
  plan: NestedExecRepairPlan,
): string;
```

- Consumes: complete `function_call` items or Responses objects/events; never accepts partial argument deltas.

- [ ] **Step 1: Write RED fixtures for complete items**

Cover these literal cases:

```ts
functionCall("functions.exec", JSON.stringify({ input: "text('ok')" }))
functionCall("web__run", JSON.stringify({ input: "const r = await tools.web__run(...); text(r)" }))
functionCall("web__run", JSON.stringify({ search_query: [{ q: "GPT news" }] }))
functionCall("web__run", JSON.stringify({ search_query: [{ q: "GPT news" }], response_length: "short" }))
```

Expected normalized item: `type:"function_call"`, `name:"exec"`, identical `id/call_id/status`, and arguments shaped as `{input:string}`. Direct web objects must generate exactly:

```js
const result = await tools.web__run(<canonical-json>);
text(JSON.stringify(result, null, 2));
```

Add unchanged cases for malformed JSON, array/scalar arguments, unknown name, disabled plan flag, direct-declaration plan flag false, and ordinary declared `exec`.

Add catalog-selection fixtures for duplicate custom exec, duplicate function exec, function/custom same-name, namespace conflict, and replay-only `additional_tools`; every ambiguous case must return no declaration/plan.

- [ ] **Step 2: Verify RED**

Run `bun test /tmp/opencodex-nested-exec-payload.test.ts`. Expected: module/export missing.

- [ ] **Step 3: Implement pure recursive transformation**

Use canonical JSON with recursively sorted object keys and array order preserved. Rewrite complete items in:

- a direct item;
- `response.output_item.done.item`;
- `response.completed|incomplete|failed.response.output`;
- a bare Responses object `output`.

`findUniqueCurrentTurnExecDeclaration()` returns a structured kind only when the current-turn catalog contains exactly one unambiguous `custom:exec` or `function:exec` and no same-wire-name function/custom/namespace conflict. Duplicate declarations, function/custom same-name, namespace conflicts, and replay-only declarations return `undefined`.

Never rewrite `custom_tool_call`, namespaced items, or an alias whose plan flag is false. Analyze the complete payload before mutating: if any recognized enabled alias is malformed, unsupported, or exceeds 64 KiB, return the original whole payload with `outcome:"rejected"`; do not partially repair sibling calls. Return `"unchanged"` for ordinary payloads and `"repaired"` only when every enabled alias in the payload converts safely. The streaming barrier uses `rejected` to choose original fail-closed output.

- [ ] **Step 4: Verify payload/JSON GREEN**

Run the payload test. Add JSON round-trip assertions for non-streaming and terminal snapshots; require call IDs/order unchanged and raw aliases absent only when repair succeeds.

### Task 3: Add Atomic SSE Barrier

**Files:**
- Create: `src/server/responses-nested-exec-call-repair.ts`
- Test: `/tmp/opencodex-nested-exec-sse.test.ts`

**Interfaces:**
- Produces:

```ts
export const NESTED_EXEC_MAX_BARRIER_BYTES = 256 * 1024;
export type NestedExecRepairCoordinator = Readonly<{
  stageCacheCandidate(response: unknown, remember: (response: unknown) => void): void;
  markClientCommitted(): void;
  reject(): void;
  dispose(): void;
}>;
export function createNestedExecRepairCoordinator(
  budget?: TranslatorBudget,
): NestedExecRepairCoordinator;
export function createNestedExecCallRepairBlockRewrite(
  plan: NestedExecRepairPlan,
  coordinator: NestedExecRepairCoordinator,
  budget?: TranslatorBudget,
): SseBlockRewrite;
export type NestedExecInspectionDecision = Readonly<{
  action: "defer" | "inspect" | "reject";
  value?: unknown;
}>;
export type NestedExecInspectionState = Readonly<{
  notePayload(payload: unknown): NestedExecInspectionDecision;
  prepareResponseForCache(response: unknown): NestedExecInspectionDecision;
  dispose(): void;
}>;
export function createNestedExecInspectionState(
  plan: NestedExecRepairPlan,
  coordinator: NestedExecRepairCoordinator,
  budget?: TranslatorBudget,
): NestedExecInspectionState;
export function createNestedExecClientOutcomeBlockRewrite(
  coordinator: NestedExecRepairCoordinator,
): SseBlockRewrite;
```

- Consumes: `repairNestedExecCallsInPayload()` from Task 2 and ordinary Responses SSE blocks.

- [ ] **Step 1: Write failing atomic-stream fixtures**

Build SSE helpers for `output_item.added`, argument delta/done, `output_item.done`, terminal and `[DONE]`. Assert:

- no candidate block is emitted before matching done;
- `web__run` direct JSON and input-wrapper calls flush as normalized `exec` lifecycle; original argument fragments never reach the composed custom restore;
- each completed candidate produces exactly one deterministic normalized argument delta and one argument done carrying the same `{input:string}` wrapper before its normalized output-item done;
- when no arguments.done exists, normalized delta+done are inserted immediately before output_item.done; conflicting done/item arguments force original fallback;
- `functions.exec` flushes with arguments unchanged;
- two candidate calls and unrelated reasoning/message blocks preserve global input order;
- terminal-before-done, malformed, item-id mismatch, per-call >64 KiB, and barrier >256 KiB flush original blocks to the next guard;
- completed/incomplete/failed/[DONE] close the barrier correctly;
- abort/dispose releases retained bytes and emits no uncommitted candidate;
- every charge has a matching release in success and fallback paths.
- inspection defers enabled alias added, inspects a normalized done/terminal, rejects malformed/incomplete candidates, and retains normalized done items only until cache preparation/terminal;
- terminal snapshots missing a completed repaired call are augmented from inspection state by output index without replacing unrelated provider output.
- an inspection terminal arriving before the client branch only stages cache; a 256 KiB client overflow, original fallback, guard rejection, abort or dispose rejects the coordinator and prevents remember; only a terminal that passes the guard triggers the non-mutating outcome observer and commits staged cache.

- [ ] **Step 2: Verify RED**

Run `bun test /tmp/opencodex-nested-exec-sse.test.ts`. Expected: module/export missing.

- [ ] **Step 3: Implement the barrier state machine**

Track a single global ordered `retainedBlocks` array plus per-call state keyed by item id and output index. Once the first enabled alias `output_item.added` arrives, retain every subsequent block. Mark candidates complete only after matching `output_item.done`; use the complete done item to compute and store one `normalizedArguments` string for that candidate.

During a successful atomic flush, rewrite added/output-item-done/terminal snapshots, suppress every original argument delta, and replace the original argument-done position with exactly one full normalized delta plus one normalized done. Unrelated retained blocks keep their global relative order. During fallback, emit every original block byte-for-byte so the final guard sees the original alias.

If no independent arguments.done exists, insert the deterministic normalized delta+done immediately before the matching output_item.done. If an arguments.done and output_item.done.arguments both exist, require byte-equivalent parsed JSON; conflict or multiple done events forces original fallback.

The pure transformer enforces the 64 KiB argument limit without charging retained memory. The barrier charges each retained SSE block once toward `TranslatorBudget` and the 256 KiB barrier limit; argument bytes are a subset of those blocks and are not double charged.

Flush policy:

- all candidates complete and repairable: transform every retained complete payload, then emit in original block order;
- any candidate fails or a terminal arrives with open candidates: emit original retained blocks in original order;
- EOF/abort/dispose: release retained bytes and emit nothing newly;
- after flush, clear all maps/arrays and release all budget charges exactly once.

Implement `createNestedExecInspectionState()` with the same candidate identity and complete-payload transformer. It never emits client blocks: enabled alias added returns `defer`; safe done/terminal returns `inspect` with upstream-wire `function_call(name="exec")`; malformed/open terminal returns `reject`. Retained normalized done items are budgeted and released on cache preparation, terminal, abort/EOF disposal, or explicit dispose.

Implement one coordinator shared by the barrier and inspection state. Inspection may only stage a repaired cache candidate. Barrier fallback/overflow/dispose calls `reject()`. A final non-mutating outcome observer marks committed only after a terminal block has passed every client rewrite and the generic guard; committed invokes the staged remember callback once, rejected never does. Test both tee orderings: inspection-terminal-first and client-terminal-first.

- [ ] **Step 4: Verify SSE GREEN and composition**

Compose the new rewrite before `createRoutedCustomToolRestoreBlockRewrite()` in the test. Assert the final client sequence is `custom_tool_call(name="exec")` plus `custom_tool_call_input.delta/done`, with no raw alias, and that an original fallback sequence is rejected by a composed generic guard.

### Task 4: Wire Request Authorization, Streaming, JSON, and Replay

**Files:**
- Modify: `src/server/responses/core.ts`
- Modify: `src/server/responses-undeclared-tool-guard.ts`
- Test: `/tmp/opencodex-nested-exec-core-contract.test.ts`

**Interfaces:**
- Consumes: `clientToolAuthorizationBody`, `clientDeclaredWireToolNames`, `request.convertedRoutedCustomToolNames`, `findUniqueCurrentTurnExecDeclaration()`, `buildNestedExecRepairPlan()`, payload/JSON repair, and SSE barrier.
- Produces: one request-local `NestedExecRepairPlan | undefined`; no persisted config/type/registry field.

- [ ] **Step 1: Write the failing authorization/order contract test**

Use source-level imports plus fixture bodies to assert plan creation requires all of:

- one unique current-turn structured `custom:exec` that was lowered, or one unique canonical `function:exec` declaration;
- the corresponding conversion/declaration fact that authorizes `exec`;
- `clientDeclaredWireToolNames` does not directly contain the alias.

Assert explicit top-level `web__run`, exact `functions.exec`, and namespace `web.run` disable only their corresponding alias repair. Add replay-prefix fixtures so historical `additional_tools` never authorize repair.

Add duplicate custom exec, duplicate function exec, function/custom same-name and namespace conflict fixtures. No ambiguous current-turn catalog may build a plan.

Add coordinator fixtures where inspection terminal arrives before client terminal, client terminal arrives first, barrier overflow follows a staged cache candidate, client abort follows staging, and guard rejects a different undeclared tool. Remember must run exactly once only in the two successful terminal orderings and zero times otherwise.

- [ ] **Step 2: Verify RED**

Run `bun test /tmp/opencodex-nested-exec-core-contract.test.ts`. Expected: plan builder/wiring missing.

- [ ] **Step 3: Build the request-local plan**

After `adapter.buildRequest()` exposes `convertedRoutedCustomToolNames`, derive the plan from the already bounded current-turn raw catalog. Do not add fields to `OcxParsedRequest`, provider registry, router, or catalog.

- [ ] **Step 4: Insert streaming rewrite in the exact order**

In `blockRewrites`, place:

```text
existing payload rewrites
→ nested exec SSE repair
→ existing routed custom-tool restore
→ existing tool-search/GitHub/snapshot/field repairs
→ existing generic undeclared-tool guard
→ non-mutating nested-exec outcome observer
```

The guard remains the last payload-changing/security rewrite. Add an optional `onReject(name)` callback to `createUndeclaredToolCallGuardBlockRewrite()`; default omission preserves every existing caller/test. Core passes `() => coordinator.reject()` only when a nested repair coordinator exists. The final outcome observer must return block bytes unchanged.

- [ ] **Step 5: Make inspection and continuation cache repair-aware**

Create one request-local coordinator and `NestedExecInspectionState` beside `inspectionSawUndeclaredTool`. `noteInspectedPayload()` must:

- skip sticky undeclared on `action:"defer"`;
- run `undeclaredToolCallName()` against `action:"inspect"` normalized upstream-wire payload;
- set sticky undeclared on `action:"reject"`.

`rememberPassthroughResponseChecked()` must call `prepareResponseForCache()` first, reject on `action:"reject"`, then run the ordinary undeclared response check on the normalized response and stage—not immediately invoke—the existing remember callback. The coordinator invokes remember only after the client terminal passes the guard/outcome observer. Dispose/reject inspection and coordinator on every abort/EOF path. Apply the same logic to tee inspection and eager inline inspection; neither may inspect/cache raw enabled aliases.

- [ ] **Step 6: Wire both bounded JSON paths**

Before every `restoreRoutedCustomCallsInJson()` and before every `undeclaredToolCallNameInResponse()` check in the `application/json`/forced-bounded branches, call the shared JSON/payload repair when the request plan exists. Parse/stringify at most once per branch and preserve the existing model/content-channel/item-id rewrites. After the synchronous JSON guard passes, call remember immediately with the repaired upstream-wire response—not raw `text`; JSON has no client/inspection tee race and must not wait on the SSE coordinator.

- [ ] **Step 7: Verify real remember→expand two-round replay**

Run the actual existing continuation state functions: remember a repaired first-round JSON/SSE response, then expand a second request containing the client `custom_tool_call_output`. Assert cached upstream-wire state contains `function_call(name="exec")`, adapter lowering produces matching `function_call_output`, call ID/output/order are unchanged, and neither cache nor expanded body contains raw `web__run/functions.exec`. Cover tee, eager-inspection fixture, ordinary JSON and forced bounded JSON.

- [ ] **Step 8: Run contract/static GREEN**

Run all four temporary Bun suites, `bun run src/cli/index.ts --help`, the following static check, and `git diff --no-index --check` against the backup:

```bash
rg -n --glob '*.ts' \
  'CLIENT_WEB_RUN_SCHEMA_V1|clientWebRunPassthroughModels|_clientWebRunOverlay|_clientWebRunAuthorized|applyClientWebRunOverlay' \
  "$PACKAGE_ROOT/src"
```

The result must be empty. `web__run` may occur only in the generic nested-call
normalizer/tests as an alias token; it must not appear in a top-level tool
declaration or in provider/model/dialect routing logic. The real model matrix
below is validation data only, never a runtime allowlist.

### Task 5: Cover Chat Completions and Claude Messages Adapter Paths

**Files:**
- Modify: `src/responses/nested-exec-call-repair.ts`
- Create: `src/responses/nested-exec-adapter-events.ts`
- Modify: `src/server/responses/core.ts`
- Modify: `src/server/chat-native.ts`
- Modify: `src/server/claude-messages.ts`
- Test: `/tmp/opencodex-nested-exec-adapter-events.test.ts`
- Test: `/tmp/opencodex-nested-exec-protocol-surfaces.test.ts`
- Test: `/tmp/opencodex-nested-exec-http-integration.test.ts`

**Interfaces:**
- Consumes: current-turn canonical tool catalog, `NestedExecRepairPlan`, complete-call normalizer, `AdapterEvent`, `TranslatorBudget`.
- Produces: one generic event-stream repair used before every `bridgeToResponsesSSE()` / `buildResponseJSON()` adapter lane; no provider/model registry field.

- [ ] **Step 1: Write failing AdapterEvent tests**

Cover `web__run` input/direct JSON and `functions.exec`, fragmented arguments, two candidates interleaved with text/thinking/heartbeat, malformed JSON, 64 KiB call limit, 256 KiB retained limit, error/done/EOF before end, consumer cancel/iterator `return()`, downstream throw, upstream abort, direct declaration precedence, and ordinary non-candidate events. Assert atomic all-or-nothing output, cancellation never replays a retained alias, and every budget charge is released exactly once.

- [ ] **Step 2: Extract one complete-call normalizer**

Expose a pure helper from `nested-exec-call-repair.ts` that takes `{name, arguments}` and the request plan. Payload, Responses SSE, and AdapterEvent paths must all call this helper. Do not duplicate canonical JSON/wrapper logic.

- [ ] **Step 3: Implement the bounded AdapterEvent barrier**

Create an async iterable wrapper. On a candidate `tool_call_start`, retain the whole candidate lifecycle until its matching `tool_call_end`; collect deltas under the existing 64 KiB limit, normalize atomically, then emit `tool_call_start(name="exec")`, exactly one normalized delta, and end at the original lifecycle position. Retain interleaved events under 256 KiB and preserve their global order. On malformed/overflow/terminal/EOF, release all budget and replay the original event group unchanged so the bridge's declared-tool guard fails closed. Non-candidate events stream through without delay when no barrier is active. Implement the wrapper with `try/finally`: consumer cancel, downstream `return()`/throw, upstream abort, and source exception must idempotently release every retained charge exactly once and invoke the source iterator's `return()` when available; cancellation/throw paths discard retained aliases instead of replaying them.

- [ ] **Step 4: Wire every adapter lane before the bridge**

Wrap runTurn streaming/buffered events and ordinary adapter streaming/buffered events before `bridgeToResponsesSSE()` or `buildResponseJSON()`. The same request plan applies whether `inboundWire` is `responses`, `chat`, or `anthropic`, and whether the resolved upstream adapter is `openai-chat`, `anthropic`, or another AdapterEvent implementation. Continuation and empty-completion sources must be inside the same normalization boundary so retries cannot bypass it.

- [ ] **Step 5: Generalize request-local authorization without widening it**

Accept either the one current-turn Responses `custom:exec` that was lowered, or one unique canonical `function:exec` produced from Chat/Claude tool translation. Derive repair only from this structured declaration, conversion state, and direct-declaration precedence; do not inspect description text. Reject duplicate/conflicting/history-only declarations, and preserve explicit top-level/namespace alias precedence. The output call shape remains whatever the original declared `exec` requires: custom/freeform callers restore to custom, function callers remain function/tool calls.

- [ ] **Step 6: Keep native shortcuts and credential domains correct**

Add a pure request-surface predicate for a unique nested `exec` declaration. A routed key/local Chat request carrying this surface must skip `isNativeChatRouteEligible()` and enter the canonical translated Responses/AdapterEvent pipeline with the same configured provider/credential; ordinary Chat requests keep native fast path. Caller-credential Claude direct-native passthrough is explicitly out of ordinary routed scope and stays byte/protocol/auth unchanged. Configured routed Claude Messages (including `volcengine-claude`) already translate and must receive the shared repair. Do not disable native paths globally or move caller Anthropic credentials into `handleResponses`.

- [ ] **Step 7: Test the complete 3×3 routed protocol matrix**

Start one bounded local fake upstream and call the real `/v1/responses`, `/v1/chat/completions`, and `/v1/messages` handlers against each forced resolved adapter (`openai-responses`, `openai-chat`, `anthropic`), streaming and non-streaming: 9 routed combinations. Assert the captured upstream pathname for every combination. Verify legitimate exec calls, both alias repairs, malformed fail closed, tool-result replay/call-id parity, direct declaration precedence, and declaration-provenance output kinds: Responses custom/function, Chat `tool_calls`/`role:tool`, Claude `tool_use`/`tool_result`. Separately verify unchanged Chat native fast path without the nested surface and unchanged Claude caller-credential direct-native passthrough.

- [ ] **Step 8: Run all protocol suites GREEN**

Run the existing four suites plus AdapterEvent, protocol-surface, and real HTTP 3×3 integration suites (seven total), CLI module load, scoped no-index diff check, forbidden symbol scan, and bridge source-order contract.

### Task 6: Real Aligned-Environment Matrix

**Files:**
- Temporary template home: `/tmp/opencodex-aligned-template-*`
- Temporary per-run homes: `/tmp/opencodex-search-run-*`
- Temporary observer/logs: `/tmp/opencodex-search-matrix-*`

**Interfaces:**
- Consumes: completed Tasks 1–5 and ready `localhost:10100` proxy.
- Produces: per-model raw request/alpha/status summaries, CLI JSONL/stderr, and zero-retry acceptance results.

- [ ] **Step 1: Reload safely**

Verify exact PID/uid/command/package root, terminate only that process, run `OCX_DEBUG=1 CI=1 ocx start --port 10100`, and require `ocx ready` plus provider debug ON. Main config hash must remain unchanged.

- [ ] **Step 2: Build one clean aligned template**

Under `umask 077`, create the template directory as `0700`. Clone main `config.toml`, auth, `AGENTS.md`, agents, hooks, rules, skills, plugins, packages, MCP dependencies, memories, catalog and cache without widening source modes. Rewrite absolute main-home paths into the template. The only behavior differences are temporary catalog path, provider base `10101/v1`, `supports_standalone_web_search=true`, and WebSocket disabled for HTTP observation. Logs may contain only redacted shapes/statuses, never credentials or raw auth headers.

- [ ] **Step 3: Clone a fresh home per run**

Never reuse runtime state between models or repetitions. Clone the clean template before each `codex exec`; rewrite template paths to the run home. Keep hooks/MCP/agents visible. The prompt must forbid delegation/MCP/shell/memory as substitutes but must not mention `exec`, `web__run`, or implementation details.

- [ ] **Step 4: Run the target matrix twice**

Responses representatives:

```text
volcengine-agent-plan/deepseek-v4-flash
deepseek/deepseek-v4-flash
volcengine-agent-plan/kimi-k3
```

`kimi-k3` is a separately verified Agent Plan model (`POST /responses` 200/completed); `k3` and `k3[1m]` are excluded because Ark returned `UnsupportedModel`. 用户已手动把 `kimi-k3` 持久加入 Agent Plan provider，并明确要求运行 `ocx sync` 刷新主 catalog；测试直接使用该用户配置，不做临时 mutation，也不得在回滚中删除它。

Chat representative (must remain resolved `openai-chat`):

```text
deepseek/deepseek-v4-flash-vision-exp
```

Claude Messages representative (must remain resolved `anthropic`):

```text
volcengine-claude/deepseek-v4-flash
```

Use each catalog's supported default effort and run these five routes twice with the same prompt, for 10 current-run summaries total. Existing summaries for the other previously passing Agent Plan/DeepSeek models remain historical regression evidence only and do not count toward this run.

- [ ] **Step 5: Enforce strict success**

Every run must have exactly one selected-model `exec-*` web_search start/end, exactly one `/v1/alpha/search` 2xx, at least one source URL, final answer after tool result, and `turn.completed`. Reject any run containing reconnect, raw alias, Sidecar, delegation substitute, `partial/prefill`, active-item, undeclared/unsupported, alpha 404, timeout, or provider 4xx—even if a later retry succeeds.

- [ ] **Step 6: Stop on independent continuation failure**

If nested aliases are zero but an Ark `partial/prefill` error remains, stop without changing this implementation. Preserve the exact raw request/response evidence and open the separate continuation Spec required by the approved design.

- [ ] **Step 7: Final health**

Stop observers, verify no listener remains on 10101, and delete every sensitive temporary HOME through a root-validated cleanup that only accepts the explicit `/tmp/opencodex-search-run-*` and template paths. Verify auth copies no longer exist. Re-run `ocx ready`, provider debug status, all static tests, baseline hashes, OpenCodex config hash/mode, and main config hash. Leave 10100 ready on the exact package.

### Task 7: Independent Subagent V2 Reviews

**Files:**
- Review package: Approved Spec, scoped backup diff, seven Bun suite outputs, static checks, 10 current real-run summaries, usage/attempt resolved-adapter provenance, GPT-5.4 standalone ON/OFF evidence, separately labeled historical regression evidence, raw observer/alpha evidence, final health.

**Interfaces:**
- Produces: independent `SPEC_COMPLIANCE` and `CODE_QUALITY` decisions.
- Consumes: bounded evidence only; `fork_turns:"none"`.

- [ ] **Step 1: Dispatch both reviewers**

Use two fresh V2 `reviewer` tasks, one per review mode. Require named-risk checks for direct-declaration precedence, atomic barrier ordering/budget release, JSON/replay parity, guard-last ordering, no model list, no main-config drift, and real zero-retry matrix provenance.

- [ ] **Step 2: Fix and re-review blockers**

Every Critical/Important finding blocks delivery. Reuse the same reviewer with `REVIEW_PHASE: RE_REVIEW`, full prior findings, fix diff, and new verification evidence.

- [ ] **Step 3: Deliver only after both Approved**

Report changed source paths, backup/restore path, unit/static evidence, each model's two-run outcome, alpha 2xx provenance, final PID/health, and any separate Ark continuation residual.

## Conditional Rollback

On an uncorrectable implementation/reload failure: verify and stop only the exact proxy PID, run the rehearsed manifest restore against the installed package root, verify every hash/mode/absent state, static-load the CLI, restart 10100 with the same external-provider-preserving behavior, and require ready. Never modify or restore the main Codex config because this plan never writes it.

# Responses Call-ID-Less Tool Output Repair Implementation Plan

> **Execution choice is binding:** Use `superpowers:executing-plans` for inline execution in the current checkout. Do not switch implementation to subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve call-ID-less task-coordination outputs across Responses provider switches by degrading only structurally invalid tool-output items into truthful user-message carriers.

**Architecture:** Add one pure normalizer to the existing Responses passthrough adapter and invoke it after empty-output annotation but before the official forward/stateless full orphan repair. The normalizer changes only `function_call_output` and `custom_tool_call_output` items whose `call_id` is missing or blank; provider state semantics and every valid item stay unchanged.

**Tech Stack:** Bun-native TypeScript, OpenAI Responses request objects, `bun:test`, existing `createResponsesPassthroughAdapter()` and `toolOutputText()` helpers.

**Spec:** `docs/superpowers/specs/2026-08-31-responses-call-idless-tool-output-design.md`

## Global Constraints

- Work in the current checkout and branch; do not create a worktree.
- Preserve unrelated concurrent edits in `src/server/relay.ts`, `src/server/relay-eager.ts`, and `tests/fork-overload-error-eof-fidelity.test.ts`.
- Modify only `src/adapters/openai-responses.ts` in production code.
- Add a new isolated `tests/responses-call-idless-tool-output.test.ts`; do not append this regression to an existing test file.
- Do not set or infer `statelessResponses` for Volcengine.
- Do not change non-empty orphan `call_id` behavior, stateful top-level fields, provider routing, retries, fallback, reasoning replay, encrypted content, or agent-task recovery.
- Do not synthesize a `call_id`, mutate the supplied raw body/input/items, or delete the original output text.
- Convert only `function_call_output` and `custom_tool_call_output` items whose `call_id` is absent, non-string, empty, or whitespace-only.
- Use TDD: observe the new focused test fail for the missing behavior before editing production code.
- Real installation/restart and Desktop replay require explicit per-action user authorization; source verification must finish first.

---

## File responsibility map

- `src/adapters/openai-responses.ts` — owns the pure call-ID-less tool-output normalizer and its single pipeline activation point.
- `tests/responses-call-idless-tool-output.test.ts` — owns real-shape key-auth/stateful regression coverage, immutability, valid-item preservation, and top-level state preservation.
- `docs/superpowers/specs/2026-08-31-responses-call-idless-tool-output-design.md` — approved semantic authority.

---

### Task 1: Drive the stateful key-auth reproduction RED

**Files:**
- Create: `tests/responses-call-idless-tool-output.test.ts`

**Interfaces:**
- Consumes: `createResponsesPassthroughAdapter(provider)` from `src/adapters/openai-responses.ts`.
- Produces: a focused `build(input, topLevel?)` harness returning the serialized outbound Responses body.
- Proves: an ordinary key-auth provider with no `statelessResponses` currently forwards call-ID-less outputs unchanged.

- [ ] **Step 1: Record the official baseline before production editing**

Run these read-only commands and retain their outputs in the implementation evidence:

```bash
git rev-parse upstream/dev
git merge-base upstream/dev HEAD
git diff --numstat upstream/dev...HEAD -- src/adapters/openai-responses.ts
git diff upstream/dev...HEAD -- src/adapters/openai-responses.ts
```

Expected at plan authoring time: `upstream/dev` resolves to a concrete commit and the scoped Fork diff is approximately 54 added/2 deleted lines. Confirm that the existing Fork changes concern GLM/Kimi compatibility, routed progress, outbound diagnostics, and cross-provider reasoning cleanup; none provides a call-ID-less tool-output normalizer. Record why one private helper plus one call in the existing request-repair pipeline remains the smallest lower-coupling delta.

- [ ] **Step 2: Create the focused adapter harness**

Create `tests/responses-call-idless-tool-output.test.ts` with this setup:

```ts
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";

const provider = {
  adapter: "openai-responses" as const,
  baseUrl: "https://ark.example/v3",
  responsesPath: "/responses",
  authMode: "key" as const,
  apiKey: "test-key",
};

function build(
  input: unknown[],
  topLevel: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildRawBody({
    model: "glm-5.3-flash",
    input,
    stream: true,
    ...topLevel,
  });
}

function buildRawBody(rawBody: Record<string, unknown>): Record<string, unknown> {
  const adapter = createResponsesPassthroughAdapter(provider);
  const request = adapter.buildRequest({
    modelId: "glm-5.3-flash",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: rawBody,
  }, { headers: new Headers() });
  return JSON.parse(request.body) as Record<string, unknown>;
}
```

The provider deliberately omits `statelessResponses`, proving the selected behavior is independent of that capability.

- [ ] **Step 3: Add the real three-output regression, changed-path immutability, and final invariant**

Add a test whose input contains three real-shape records with no `call_id`:

```ts
test("converts call-ID-less task messages before a strict routed Responses request", () => {
  const input = [
    {
      type: "function_call_output",
      id: "fco_1",
      name: "send_message_to_thread",
      namespace: "codex_app",
      output: "delegation one",
      internal_chat_message_metadata_passthrough: { source: "task-a" },
    },
    {
      type: "function_call_output",
      id: "fco_2",
      name: "send_message_to_thread",
      output: "delegation two",
    },
    {
      type: "function_call_output",
      id: "fco_3",
      name: "send_message_to_thread",
      output: "delegation three",
    },
  ];

  const rawBody = { model: "glm-5.3-flash", input, stream: true };
  const originalSnapshot = structuredClone(rawBody);
  const body = buildRawBody(rawBody);
  const outbound = body.input as Array<Record<string, unknown>>;

  expect(outbound).toHaveLength(3);
  expect(outbound.every(item => item.type === "message" && item.role === "user")).toBe(true);
  expect(JSON.stringify(outbound)).toContain("send_message_to_thread");
  expect(JSON.stringify(outbound)).toContain("original call_id missing");
  expect(JSON.stringify(outbound[0])).toContain("delegation one");
  expect(JSON.stringify(outbound[1])).toContain("delegation two");
  expect(JSON.stringify(outbound[2])).toContain("delegation three");
  for (const item of outbound) {
    expect(JSON.stringify(item)).toContain("send_message_to_thread");
  }
  expect(outbound.some(item => (
    (item.type === "function_call_output" || item.type === "custom_tool_call_output")
    && (typeof item.call_id !== "string" || item.call_id.trim() === "")
  ))).toBe(false);
  expect(outbound[0]).not.toHaveProperty("id");
  expect(outbound[0]).not.toHaveProperty("namespace");
  expect(outbound[0]).not.toHaveProperty("internal_chat_message_metadata_passthrough");
  expect(outbound[0]).not.toHaveProperty("call_id");
  expect(rawBody).toEqual(originalSnapshot);
  expect(rawBody.input).toBe(input);
  expect(outbound).not.toBe(input);
});
```

- [ ] **Step 4: Add invalid-ID variants and custom-output coverage**

Use a table for absent, non-string, empty, and whitespace-only IDs and cover both output types:

```ts
for (const [label, callId] of [
  ["missing", undefined],
  ["non-string", 42],
  ["empty", ""],
  ["whitespace", "  \n"],
] as const) {
  test(`converts ${label} call ids on both tool-output kinds`, () => {
    const outbound = build([
      { type: "function_call_output", name: "fn", output: "function result", ...(callId === undefined ? {} : { call_id: callId }) },
      { type: "custom_tool_call_output", name: "custom", output: [{ type: "output_text", text: "custom result" }], ...(callId === undefined ? {} : { call_id: callId }) },
    ]).input as Array<Record<string, unknown>>;

    expect(outbound).toHaveLength(2);
    expect(outbound).toMatchObject([
      { type: "message", role: "user" },
      { type: "message", role: "user" },
    ]);
    expect(JSON.stringify(outbound)).toContain("function result");
    expect(JSON.stringify(outbound)).toContain("custom result");
  });
}
```

- [ ] **Step 5: Add valid-item and state-field preservation coverage**

Add one test containing:

```ts
const input = [
  { type: "function_call", id: "fc_ok", call_id: "call_ok", name: "exec", arguments: "{}" },
  { type: "function_call_output", call_id: "call_ok", output: "paired" },
  { type: "function_call_output", call_id: "call_stateful_orphan", output: "provider-state result" },
  { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
];
const originalSnapshot = structuredClone(input);
const topLevel = {
  store: true,
  metadata: { trace: "keep" },
  conversation: "conv_keep",
  prompt: { id: "prompt_keep" },
};

const body = build(input, topLevel);

expect(body.input).toEqual(input);
expect(input).toEqual(originalSnapshot);
expect(body).toMatchObject(topLevel);
```

This locks the selected boundary: valid and non-empty call ids retain their existing ordinary stateful key-auth behavior, and no stateless field stripping occurs.

- [ ] **Step 6: Run the new test and verify RED**

Run:

```bash
bun test tests/responses-call-idless-tool-output.test.ts
```

Expected: the real-shape and invalid-ID tests fail because the serialized outbound body still contains the original tool-output items; the valid/stateful preservation test passes.

- [ ] **Step 7: Record the RED evidence**

Save the command, non-zero exit status, failing test names, and the first assertion diff. Do not edit production code until the failure proves the missing normalizer rather than a test setup error.

---

### Task 2: Implement the narrow outbound normalizer GREEN

**Files:**
- Modify: `src/adapters/openai-responses.ts` by adding the helper beside `toolOutputText()` and activating it in `buildRequest()` immediately before the existing `repairOrphanedInputItems()` call; do not modify `repairOrphanedInputItems()` itself
- Test: `tests/responses-call-idless-tool-output.test.ts`

**Interfaces:**
- Consumes: `toolOutputText(output: unknown): string`.
- Produces: private `repairCallIdlessToolOutputs(body: unknown): unknown`.
- Preserves: `repairOrphanedInputItems(body, dropReasoning, synthesizeMissingCallOutputs)` and its `forward || stateless` gate.

- [ ] **Step 1: Add the pure normalizer beside `toolOutputText()`**

Add this implementation immediately after `toolOutputText()`:

```ts
function repairCallIdlessToolOutputs(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item)) return item;
    if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") return item;
    if (typeof item.call_id === "string" && item.call_id.trim().length > 0) return item;

    changed = true;
    const toolName = typeof item.name === "string" && item.name.trim().length > 0
      ? item.name.trim()
      : "unknown tool";
    return {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `[unlinked tool output from ${toolName}; original call_id missing]\n${toolOutputText(item.output)}`,
      }],
    };
  });
  return changed ? { ...body, input } : body;
}
```

Do not export the helper; the public contract remains the adapter's serialized request.

- [ ] **Step 2: Activate it at the exact pipeline boundary**

In `buildRequest()`, preserve the current state and empty-output steps, then add one unconditional call before the existing full orphan repair:

```ts
const stateless = provider.statelessResponses === true;
if (stateless) outBody = stripStatefulResponsesParams(outBody);
if (provider.annotateEmptyToolOutputs === true) {
  outBody = annotateEmptyResponsesToolOutputs(outBody, true);
}
outBody = repairCallIdlessToolOutputs(outBody);
if (forward || stateless) {
  outBody = repairOrphanedInputItems(outBody, unexpandedMiss, stateless && !forward);
}
```

Do not change any surrounding transform, flag, condition, or provider capability.

- [ ] **Step 3: Run the focused test and verify GREEN**

Run:

```bash
bun test tests/responses-call-idless-tool-output.test.ts
```

Expected: all tests pass. Confirm the valid/stateful preservation test still passes, not merely the malformed cases.

- [ ] **Step 4: Run directly coupled regressions**

Run:

```bash
bun test \
  tests/responses-stateless-dangling-call-repair.test.ts \
  tests/openai-responses-passthrough.test.ts \
  tests/deepseek-inbound-wire.test.ts
```

Expected: all selected tests pass with no changes to their fixtures or assertions.

- [ ] **Step 5: Check the scoped diff**

Run:

```bash
git diff --check -- \
  src/adapters/openai-responses.ts \
  tests/responses-call-idless-tool-output.test.ts
git diff --stat -- \
  src/adapters/openai-responses.ts \
  tests/responses-call-idless-tool-output.test.ts
```

Expected: no whitespace errors; production changes remain one private helper and one pipeline call.

---

### Task 3: Verify, independently review, and commit the implementation

**Files:**
- Review: `src/adapters/openai-responses.ts`
- Review: `tests/responses-call-idless-tool-output.test.ts`
- Preserve: unrelated concurrent working-tree files.

**Interfaces:**
- Consumes: Task 2 GREEN implementation.
- Produces: verification evidence, independent L2 review decisions, and one scoped implementation commit.

- [ ] **Step 1: Run repository gates proportionate to the shared network adapter**

Run:

```bash
bun run typecheck
bun run test:changed
bun run privacy:scan
git diff --check
```

Expected: all commands exit 0. `test:changed` may select more than the focused files because `openai-responses.ts` is shared; do not replace it with a bare `bun test` or the full suite unless the selected result is ambiguous or fails outside a known unrelated concurrent change.

- [ ] **Step 2: Produce the bounded review package**

Record:

```bash
git diff -- src/adapters/openai-responses.ts tests/responses-call-idless-tool-output.test.ts
git diff --numstat -- src/adapters/openai-responses.ts tests/responses-call-idless-tool-output.test.ts
```

Include the approved Spec path, this Plan path, RED/GREEN output, all verification outputs, and named risks: provider state preservation, valid-item preservation, input immutability, no fake identity, no recovery/reasoning overlap, and minimum Fork delta.

- [ ] **Step 3: Run independent L2 reviews**

Dispatch two fresh read-only reviewers with `fork_turns: "none"`:

```text
REVIEW_MODE: SPEC_COMPLIANCE
REVIEW_PHASE: INITIAL
REVIEW_SCOPE_ID: responses-call-idless-tool-output-2026-08-31
```

and:

```text
REVIEW_MODE: CODE_QUALITY
REVIEW_PHASE: INITIAL
REVIEW_SCOPE_ID: responses-call-idless-tool-output-2026-08-31
```

Any Critical or Important finding blocks the commit. Fix findings inline with TDD where behavior changes, rerun the affected verification, and resume the same reviewer with `REVIEW_PHASE: RE_REVIEW`, complete `PRIOR_FINDINGS`, `FIX_DIFF`, and `VERIFICATION_EVIDENCE`.

- [ ] **Step 4: Stage only this task's implementation files**

Run:

```bash
test -z "$(git diff --cached --name-only)"
git add -- \
  src/adapters/openai-responses.ts \
  tests/responses-call-idless-tool-output.test.ts
test "$(git diff --cached --name-only | sort)" = "$(printf '%s\n' \
  src/adapters/openai-responses.ts \
  tests/responses-call-idless-tool-output.test.ts | sort)"
git diff --cached --check
```

Do not stage the concurrent relay/overload files or use `git add -A`.

- [ ] **Step 5: Commit the reviewed implementation**

Run:

```bash
git commit -m "fix(responses): 修复缺失 call_id 的工具结果"
```

Expected: the commit contains exactly the adapter and new focused test file.

- [ ] **Step 6: Verify post-commit ownership**

Run:

```bash
git show --name-status --format= HEAD
git status --short
```

Expected: the implementation commit lists exactly two task files. Any remaining relay/overload changes are preserved as unrelated working-tree state.

---

### Task 4: Perform authorized live acceptance without history repair

**Files:**
- Read only: installed OCX status, usage log, provider debug, and Codex task state.
- Do not edit: Codex rollout JSONL, SQLite, provider history, or user messages.

**Interfaces:**
- Consumes: reviewed implementation commit and explicit user authorization to install/restart the local OCX package.
- Produces: a real provider-switch acceptance result against the original malformed history.

- [ ] **Step 1: Stop at the installation authority boundary**

If the user has not explicitly authorized this specific local install/restart action, report that source verification is complete and request authorization. Do not infer authorization from an older installation request.

- [ ] **Step 2: Select the exact authorized install branch**

If the user authorizes package replacement but not process restart, run exactly:

```bash
bun run install:local -- --no-restart
```

This replaces the global package but deliberately leaves the proxy stopped; do not claim live acceptance until restart is separately authorized.

Only if the user explicitly authorizes both local package replacement and proxy restart, run exactly:

```bash
bun run install:local
```

The repository authority is `scripts/install-local.ts`, whose accepted syntax is `bun run install:local [-- --no-restart]`. The default path stops the current proxy, replaces the immutable packed package, and refreshes/restarts the packaged proxy. This server-side compatibility repair does not require restarting the Codex Desktop app or mutating Desktop login/provider state.

- [ ] **Step 3: Verify the running identity after an authorized restart**

Run:

```bash
ocx status
ocx --version
curl -fsS http://127.0.0.1:10100/healthz
```

Record the running PID, runtime path, installed/proxy version, config path, and health result before attributing behavior to the new checkout. If the installed version or runtime path does not identify the just-installed package, stop and diagnose the installation rather than proceeding to replay.

- [ ] **Step 4: Stop at the Desktop replay authority boundary**

After running-identity verification, request separate explicit authorization to send one acceptance continuation to exactly:

```text
codex://threads/01a055cf-5453-7172-aa06-2d5ab7cf964f
provider: volcengine-agent-plan
model: glm-5.3-flash
```

Do not infer this write authorization from package installation, proxy restart, source implementation, or any older replay request. If authorization is not granted, report source/runtime readiness and leave the historical task unchanged.

- [ ] **Step 5: Replay the original failing conversation through Volcengine**

Use task:

```text
codex://threads/01a055cf-5453-7172-aa06-2d5ab7cf964f
```

Keep:

```text
provider: volcengine-agent-plan
model: glm-5.3-flash
```

Send a new ordinary user continuation without deleting or rewriting the three historical `send_message_to_thread` outputs.

- [ ] **Step 6: Verify the exact runtime outcome**

Require all of:

- no `MissingParameter input.call_id` error;
- a normal streamed model turn rather than a pre-token HTTP 400;
- usage entry is not `invalid_request_error` for the replay request;
- provider-debug outbound shape contains no call-ID-less tool output and shows the three historical records carried as messages;
- delegation content remains model-visible;
- no new agent-task recovery, reasoning replay, or provider-routing failure appears.

If the replay fails, preserve the exact request id and compare raw outbound type counts and upstream error before proposing another change.

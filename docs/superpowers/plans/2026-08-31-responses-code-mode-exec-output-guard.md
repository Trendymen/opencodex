# Responses Code-Mode Exec Output Guard Implementation Plan

> **Execution choice is binding:** Use `superpowers:executing-plans` for inline execution in the current checkout. Do not switch implementation to subagent-driven development or create a worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent third-party native Responses models from treating a successful Codex code-mode `exec` cell with no emitted program value as an empty search or broken shell, while preserving canonical OpenAI traffic and every non-proven tool result.

**Architecture:** Derive one request-level eligibility decision from the logical Codex tool catalog, `tool_choice`, destination, compaction state, and string instructions. Reuse it first to normalize only uniquely paired client-wire `custom_tool_call(name=exec)` empty wrappers before custom-to-function lowering, then to append the shared `CODE_MODE_RESULT_ECHO_SENTENCE` before the existing routed progress contract. Reuse all existing predicates and result-normalization text; add no configuration or provider-specific branch.

**Tech Stack:** Bun-native strict TypeScript, OpenAI Responses request objects, `bun:test`, existing `createResponsesPassthroughAdapter()`, tool-choice predicates, code-mode predicates, routed progress contract, and empty-exec result normalizer.

**Spec:** `docs/superpowers/specs/2026-08-31-responses-code-mode-exec-output-guard-design.md`

## Global Constraints

- Work in the current checkout and branch; do not create a worktree.
- The approved predecessor is `4fbafab9f fix(responses): 修复缺失 call_id 的工具结果`; preserve `repairCallIdlessToolOutputs()` and `tests/responses-call-idless-tool-output.test.ts`.
- Plan-authoring `HEAD` is `c838e5e88`; refresh all refs and scoped diffs before implementation because another task may advance the shared branch.
- Preserve `18fdfe87b`, `227e4e1ba`, `4fbafab9f`, `034771396`, and `c838e5e88`; do not squash, amend, revert, or mix their files into this task.
- Modify exactly two production files: `src/adapters/openai-responses.ts` and `src/adapters/exec-tool-result-normalize.ts`.
- Add exactly one isolated test file: `tests/responses-code-mode-exec-output-guard.test.ts`.
- Do not modify `src/adapters/tool-catalog-nudge.ts`, provider registry/config, Responses core, relay, routing, GUI, docs-site, or structure documents.
- Do not rewrite generated JavaScript, execute or retry nested commands, infer stdout, synthesize tool identity, or automatically echo arbitrary nested helper results.
- Canonical OpenAI API, canonical ChatGPT forward, routed compaction, non-code-mode catalogs, excluded tool choices, missing/non-string instructions, unpaired outputs, function/local-shell history, and ambiguous call ids remain outside the new normalization.
- Preserve generic empty-output annotation precedence, predecessor call-ID-less degradation, and existing forward/stateless orphan repair order.
- Use TDD: record a failing focused test before production editing, then implement only enough to make it pass.
- Use `bun scripts/test.ts --changed=origin/dev` as the authoritative task-scoped import-graph gate while implementation remains uncommitted. `origin/dev` is the Fork-owned daily integration baseline; never use the ambiguous `--changed=dev` alias, which resolves `upstream/dev` first in this repository.
- Relative to the refreshed official baseline, keep the new production delta to private helpers, imports, one early normalization call, and one late instruction call.
- Do not install, replace, repair, or restart the globally installed OpenCodex package/service. Live Desktop replay requires separate explicit authorization after source acceptance.
- Commit messages are Chinese and grouped by functional boundary: one documentation commit, then one implementation commit after verification and L2 review.

---

## File Responsibility Map

- `docs/superpowers/specs/2026-08-31-responses-code-mode-exec-output-guard-design.md` — approved semantic authority and exclusions.
- `docs/superpowers/plans/2026-08-31-responses-code-mode-exec-output-guard.md` — executable TDD, verification, review, and commit sequence.
- `src/adapters/openai-responses.ts` — owns native Responses request eligibility, pre-lowering paired-output normalization, and late routed instruction composition.
- `src/adapters/exec-tool-result-normalize.ts` — owns the monotonic successful empty-wrapper classifier shared by Responses, Cursor, and Kiro while preserving the exported `.test()` compatibility surface.
- `tests/responses-code-mode-exec-output-guard.test.ts` — owns prevention, shared eligibility, provenance, ambiguity, pipeline precedence, canonical isolation, and immutability coverage.
- `tests/responses-call-idless-tool-output.test.ts` — predecessor-owned regression that must stay unchanged and green.

---

### Task 0: Commit Approved Documents and Freeze the Refreshed Baseline

**Files:**
- Add or revise: `docs/superpowers/specs/2026-08-31-responses-code-mode-exec-output-guard-design.md`
- Add or revise: `docs/superpowers/plans/2026-08-31-responses-code-mode-exec-output-guard.md`
- Preserve: all other tracked and untracked files

**Interfaces:**
- Consumes: approved `SPEC_DOCUMENT` and `PLAN_DOCUMENT` decisions.
- Produces: reviewed documentation commit(s) pushed to `origin/dev` and a recorded predecessor/official baseline for the implementation review package.

- [ ] **Step 1: Confirm the predecessor and shared worktree release**

Run:

```bash
git status --short
git log -8 --oneline --decorate
git show --stat --oneline 4fbafab9f
git show --stat --oneline c838e5e88
```

`4fbafab9f` must still own only `src/adapters/openai-responses.ts` plus `tests/responses-call-idless-tool-output.test.ts`; `c838e5e88` must own only the Volta installer source/test. The Responses implementation may already be dirty during a reviewed document revision. Preserve it, and never stage unrelated branch-governance files with this document boundary.

- [ ] **Step 2: Record the official and Fork baselines**

Run and retain the exact output:

```bash
git rev-parse upstream/dev upstream-release HEAD
git merge-base upstream/dev HEAD
git diff --numstat upstream/dev...HEAD -- src/adapters/openai-responses.ts
git diff -U0 upstream/dev...HEAD -- src/adapters/openai-responses.ts
git diff --numstat upstream/dev...HEAD -- src/adapters/exec-tool-result-normalize.ts
git diff -U0 upstream/dev...HEAD -- src/adapters/exec-tool-result-normalize.ts
```

At plan authoring time the refs were:

```text
upstream/dev       7ee96b94ea6983f35e81b5df1bdec8f0f398cbce
upstream-release   54e2274cff231631c0ea2ff12574ff03829d5fe6
HEAD               c838e5e881dc83d0e713ce6075adc5c43a3bc6e3
merge-base         4180067b4a458d21ea902cb2522ddd204e9ffd32
adapter numstat    89  2
```

These are observations, not immutable expectations. If refs move, record the new values and verify that the predecessor helper still appears immediately after generic empty-output annotation and immediately before broad orphan repair. The task remains valid only if the new change can stay in the two approved production files.

- [ ] **Step 3: Stage only the reviewed documents**

Run:

```bash
git add \
  docs/superpowers/specs/2026-08-31-responses-code-mode-exec-output-guard-design.md \
  docs/superpowers/plans/2026-08-31-responses-code-mode-exec-output-guard.md
git diff --cached --check
git diff --cached --stat
git diff --cached --name-only
```

Expected staged names are exactly the two document paths above.

- [ ] **Step 4: Commit the document boundary**

Run:

```bash
git commit -m "docs: 收紧 Responses code-mode 空输出防护边界"
git push origin dev
```

Record the commit id as `DOC_COMMIT` for the final review package.

- [ ] **Step 5: Confirm the Fork integration baseline contains every reviewed document change**

Run:

```bash
git rev-parse HEAD origin/dev
git diff --name-only origin/dev --
```

Expected before the task-scoped changed gate: `HEAD` equals `origin/dev`, and the diff names exactly
`src/adapters/openai-responses.ts`, `src/adapters/exec-tool-result-normalize.ts`, and
`tests/responses-code-mode-exec-output-guard.test.ts`. If unrelated shared-worktree files appear,
wait for their owner to commit and push them to `origin/dev`; do not stash, discard, or stage them
inside this task.

---

### Task 1: Drive the Code-Mode Guard Reproduction RED

**Files:**
- Create: `tests/responses-code-mode-exec-output-guard.test.ts`
- Read: `src/adapters/openai-responses.ts`
- Read: `src/adapters/tool-catalog-nudge.ts`
- Read: `src/adapters/exec-tool-result-normalize.ts`
- Read: `src/fork/routed-progress-contract.ts`

**Interfaces:**
- Consumes: `createResponsesPassthroughAdapter(provider)`, `withTestTranslatorBudget(adapter)`, `OcxTool`, `OcxToolChoice`, `OcxProviderConfig`, and existing exported diagnostic constants.
- Produces: a focused serialized-request harness and failing assertions for prevention plus post-call diagnosis.

- [ ] **Step 1: Create the exact provider/tool/request harness**

Create `tests/responses-code-mode-exec-output-guard.test.ts` with these imports and fixtures:

```ts
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import {
  CODE_MODE_RESULT_ECHO_SENTENCE,
  EMPTY_EXEC_OUTPUT_REGEX,
  EMPTY_EXEC_OUTPUT_MESSAGE,
  FAILED_EXEC_OUTPUT_MESSAGE,
} from "../src/adapters/exec-tool-result-normalize";
import { EMPTY_TOOL_OUTPUT_ANNOTATION } from "../src/adapters/empty-tool-output-annotation";
import { ROUTED_PROGRESS_CONTRACT } from "../src/fork/routed-progress-contract";
import { namespacedToolName, type OcxProviderConfig, type OcxTool, type OcxToolChoice } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const SUCCESS_EMPTY_WRAPPER = "Script completed\nWall time 0.2 seconds\nOutput:\n";
const FAILED_EMPTY_WRAPPER = "Script failed\nWall time 0.2 seconds\nOutput:\n";
const LEGACY_SUCCESSFUL_WRAPPER_REGEX = /^(?:(?:Script completed|Command finished|Execution finished)[^\n]*\n+)?(?:Wall time[^\n]*\n+)?(?:Output:\s*)?(?:<empty>)?\s*$/;
const BASE_INSTRUCTIONS = "BASE CODE-MODE INSTRUCTIONS";
const MISSING_INSTRUCTIONS = Symbol("missing instructions");

const THIRD_PARTY: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://ark.example/api/plan/v3",
  responsesPath: "/responses",
  authMode: "key",
  apiKey: "test-key",
};

const OPENAI_API: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authMode: "key",
  apiKey: "test-key",
};

const CHATGPT_FORWARD: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
};

const NONCANONICAL_FORWARD: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://forward.example/v1",
  authMode: "forward",
};

const CODE_MODE_EXEC: OcxTool = {
  name: "exec",
  description: "Run JavaScript in a V8 isolate.",
  parameters: {},
  freeform: true,
};

const STRUCTURED_EXEC: OcxTool = {
  name: "exec",
  description: "Run a structured command.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const WAIT_TOOL: OcxTool = {
  name: "wait",
  description: "Wait for a cell.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const BARE_SHELL: OcxTool = {
  name: "exec_command",
  description: "Run shell directly.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const NAMESPACED_SHELL: OcxTool = {
  namespace: "mcp__docker",
  name: "shell_command",
  description: "Run shell in Docker.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
```

Add these exact helper contracts:

```ts
function wireTool(tool: OcxTool): Record<string, unknown> {
  const name = namespacedToolName(tool.namespace, tool.name);
  return tool.freeform === true
    ? { type: "custom", name, description: tool.description, format: { type: "text" } }
    : { type: "function", name, description: tool.description, parameters: tool.parameters };
}

function wireToolChoice(choice: OcxToolChoice): unknown {
  if (typeof choice === "string") return choice;
  if ("allowedTools" in choice) {
    return {
      type: "allowed_tools",
      mode: choice.mode,
      tools: choice.allowedTools.map(name => ({
        type: name === "exec" ? "custom" : "function",
        name,
      })),
    };
  }
  return { type: choice.name === "exec" ? "custom" : "function", name: choice.name };
}

function pairedCustomExec(
  output: unknown = SUCCESS_EMPTY_WRAPPER,
  callId = "call_exec",
): Array<Record<string, unknown>> {
  return [
    { type: "custom_tool_call", id: "ctc_exec", call_id: callId, name: "exec", input: "noop" },
    { type: "custom_tool_call_output", call_id: callId, output },
  ];
}

type BuildOptions = {
  provider?: OcxProviderConfig;
  contextTools?: OcxTool[];
  toolChoice?: OcxToolChoice;
  instructions?: unknown | typeof MISSING_INSTRUCTIONS;
  input?: unknown[];
  compaction?: boolean;
  annotateEmpty?: boolean;
  stateless?: boolean;
};

function build(options: BuildOptions = {}): {
  body: Record<string, unknown>;
  rawBody: Record<string, unknown>;
  rawBodySnapshot: Record<string, unknown>;
  contextTools: OcxTool[];
} {
  const contextTools = options.contextTools ?? [CODE_MODE_EXEC, WAIT_TOOL];
  const toolChoice = options.toolChoice ?? "auto";
  const baseProvider = options.provider ?? THIRD_PARTY;
  const provider: OcxProviderConfig = {
    ...baseProvider,
    ...(options.annotateEmpty ? { annotateEmptyToolOutputs: true } : {}),
    ...(options.stateless ? { statelessResponses: true } : {}),
  };
  const rawBody: Record<string, unknown> = {
    model: "glm-5.3-flash",
    input: options.input ?? pairedCustomExec(),
    tools: contextTools.map(wireTool),
    tool_choice: wireToolChoice(toolChoice),
    stream: true,
    ...(options.instructions === MISSING_INSTRUCTIONS
      ? {}
      : { instructions: options.instructions ?? BASE_INSTRUCTIONS }),
  };
  const rawBodySnapshot = structuredClone(rawBody);
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
  const request = adapter.buildRequest({
    modelId: "glm-5.3-flash",
    context: { messages: [], tools: contextTools },
    stream: true,
    options: { toolChoice },
    _rawBody: rawBody,
    ...(options.compaction ? { _compactionRequest: true } : {}),
  }, { headers: new Headers({ "thread-id": "thread-code-mode-output-guard" }) });
  return {
    body: JSON.parse(request.body) as Record<string, unknown>,
    rawBody,
    rawBodySnapshot,
    contextTools,
  };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function outputFor(body: Record<string, unknown>, callId: string): unknown {
  const input = body.input as Array<Record<string, unknown>>;
  return input.find(item => (
    (item.type === "custom_tool_call_output" || item.type === "function_call_output")
    && item.call_id === callId
  ))?.output;
}
```

- [ ] **Step 2: Mark the new test intent-to-add so every later diff contains it**

Run:

```bash
git add -N -- tests/responses-code-mode-exec-output-guard.test.ts
git status --short tests/responses-code-mode-exec-output-guard.test.ts
git diff --stat -- tests/responses-code-mode-exec-output-guard.test.ts
```

Expected: status reports an intent-to-add entry and the working-tree diff/stat includes the complete new test content. `git add -N` records only the path; it does not stage the file content. Do not run ordinary `git add` until the reviewed functional commit step.

- [ ] **Step 3: Add prevention, idempotence, and immutability tests**

Append:

```ts
describe("Responses code-mode exec output guard", () => {
  test("adds the shared echo rule once before the fresh routed progress contract", () => {
    const { body } = build();
    const instructions = String(body.instructions);

    expect(instructions).toContain(BASE_INSTRUCTIONS);
    expect(occurrences(instructions, CODE_MODE_RESULT_ECHO_SENTENCE)).toBe(1);
    expect(occurrences(instructions, ROUTED_PROGRESS_CONTRACT)).toBe(1);
    expect(instructions.indexOf(CODE_MODE_RESULT_ECHO_SENTENCE))
      .toBeLessThan(instructions.indexOf(ROUTED_PROGRESS_CONTRACT));
  });

  test("does not duplicate caller-supplied echo or progress contracts", () => {
    for (const instructions of [
      `${BASE_INSTRUCTIONS}\n\n${CODE_MODE_RESULT_ECHO_SENTENCE}`,
      `${BASE_INSTRUCTIONS}\n\n${ROUTED_PROGRESS_CONTRACT}`,
      `${BASE_INSTRUCTIONS}\n\n${ROUTED_PROGRESS_CONTRACT}\n\n${CODE_MODE_RESULT_ECHO_SENTENCE}`,
    ]) {
      const body = build({ instructions }).body;
      const outbound = String(body.instructions);
      expect(occurrences(outbound, CODE_MODE_RESULT_ECHO_SENTENCE)).toBe(1);
      expect(occurrences(outbound, ROUTED_PROGRESS_CONTRACT)).toBe(1);
      expect(outbound).toContain(instructions);
    }
  });
```

The first test intentionally expects both missing behaviors: the echo sentence is absent and the successful wrapper still survives. Keep the test file open; the closing `});` is added after the remaining tests below.

- [ ] **Step 4: Add the shared eligibility matrix for both operations**

Append this exact matrix and assertion loop:

```ts
  const gateCases: Array<{
    label: string;
    options: BuildOptions;
    expected: boolean;
  }> = [
    { label: "third-party code mode", options: {}, expected: true },
    { label: "official OpenAI API", options: { provider: OPENAI_API }, expected: false },
    { label: "canonical ChatGPT forward", options: { provider: CHATGPT_FORWARD }, expected: false },
    { label: "structured exec", options: { contextTools: [STRUCTURED_EXEC, WAIT_TOOL] }, expected: false },
    { label: "bare shell bridge", options: { contextTools: [CODE_MODE_EXEC, BARE_SHELL] }, expected: false },
    { label: "namespaced MCP shell", options: { contextTools: [CODE_MODE_EXEC, NAMESPACED_SHELL] }, expected: true },
    { label: "tool choice none", options: { toolChoice: "none" }, expected: false },
    {
      label: "allowed tools exclude exec",
      options: { toolChoice: { allowedTools: ["wait"], mode: "auto" } },
      expected: false,
    },
    { label: "routed compaction", options: { compaction: true }, expected: false },
    { label: "missing instructions", options: { instructions: MISSING_INSTRUCTIONS }, expected: false },
    { label: "non-string instructions", options: { instructions: { text: BASE_INSTRUCTIONS } }, expected: false },
  ];

  for (const { label, options, expected } of gateCases) {
    test(`shares one eligibility decision for ${label}`, () => {
      const body = build(options).body;
      const instructions = typeof body.instructions === "string" ? body.instructions : "";
      expect(instructions.includes(CODE_MODE_RESULT_ECHO_SENTENCE)).toBe(expected);
      expect(JSON.stringify(body).includes(EMPTY_EXEC_OUTPUT_MESSAGE)).toBe(expected);
      expect(outputFor(body, "call_exec"))
        .toBe(expected ? EMPTY_EXEC_OUTPUT_MESSAGE : SUCCESS_EMPTY_WRAPPER);
    });
  }
```

For compaction the output may be converted from custom to function, but it remains in `body.input`; `outputFor()` deliberately accepts both output kinds.

- [ ] **Step 5: Add exact provenance, wire-kind, and ambiguity tests**

Append:

```ts
  test("normalizes successful and failed wrappers only on a unique custom exec pair", () => {
    expect(outputFor(build().body, "call_exec")).toBe(EMPTY_EXEC_OUTPUT_MESSAGE);
    expect(outputFor(build({ input: pairedCustomExec(FAILED_EMPTY_WRAPPER, "call_failed") }).body, "call_failed"))
      .toBe(FAILED_EXEC_OUTPUT_MESSAGE);
  });

  test("leaves function and local-shell history unchanged inside an otherwise eligible request", () => {
    const input = [
      ...pairedCustomExec(SUCCESS_EMPTY_WRAPPER, "call_exec"),
      { type: "function_call", call_id: "call_fn_exec", name: "exec", arguments: "{}" },
      { type: "function_call_output", call_id: "call_fn_exec", output: SUCCESS_EMPTY_WRAPPER },
      { type: "function_call", call_id: "call_shell", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call_shell", output: SUCCESS_EMPTY_WRAPPER },
      { type: "function_call", call_id: "call_named_shell", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_named_shell", output: SUCCESS_EMPTY_WRAPPER },
      { type: "function_call", call_id: "call_named_local", name: "local_shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_named_local", output: SUCCESS_EMPTY_WRAPPER },
      { type: "local_shell_call", call_id: "call_local_item", name: "local_shell", action: {} },
      { type: "function_call_output", call_id: "call_local_item", output: SUCCESS_EMPTY_WRAPPER },
    ];
    const body = build({ input }).body;
    expect(outputFor(body, "call_exec")).toBe(EMPTY_EXEC_OUTPUT_MESSAGE);
    expect(outputFor(body, "call_fn_exec")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(outputFor(body, "call_shell")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(outputFor(body, "call_named_shell")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(outputFor(body, "call_named_local")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(outputFor(body, "call_local_item")).toBe(SUCCESS_EMPTY_WRAPPER);
  });

  test("requires the paired custom exec call to be bare and unnamespaced", () => {
    const body = build({
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_namespaced_exec",
          namespace: "mcp__sandbox",
          name: "exec",
          input: "noop",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_namespaced_exec",
          output: SUCCESS_EMPTY_WRAPPER,
        },
      ],
    }).body;
    expect(outputFor(body, "call_namespaced_exec")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
  });

  test("does not cross-pair function and custom wire kinds", () => {
    const body = build({
      input: [
        { type: "function_call", call_id: "call_cross_fn", name: "exec", arguments: "{}" },
        { type: "custom_tool_call_output", call_id: "call_cross_fn", output: SUCCESS_EMPTY_WRAPPER },
        { type: "custom_tool_call", call_id: "call_cross_custom", name: "exec", input: "noop" },
        { type: "function_call_output", call_id: "call_cross_custom", output: SUCCESS_EMPTY_WRAPPER },
      ],
    }).body;
    expect(outputFor(body, "call_cross_fn")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(outputFor(body, "call_cross_custom")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
  });

  for (const [label, calls] of [
    ["identical exec duplicates", [
      { type: "custom_tool_call", call_id: "call_dup", name: "exec", input: "noop" },
      { type: "custom_tool_call", call_id: "call_dup", name: "exec", input: "noop" },
    ]],
    ["different exec duplicates", [
      { type: "custom_tool_call", call_id: "call_dup", name: "exec", input: "one" },
      { type: "custom_tool_call", call_id: "call_dup", name: "exec", input: "two" },
    ]],
    ["exec plus non-exec duplicate", [
      { type: "custom_tool_call", call_id: "call_dup", name: "exec", input: "noop" },
      { type: "custom_tool_call", call_id: "call_dup", name: "other", input: "noop" },
    ]],
  ] as const) {
    test(`skips ${label}`, () => {
      const body = build({
        input: [
          ...calls,
          { type: "custom_tool_call_output", call_id: "call_dup", output: SUCCESS_EMPTY_WRAPPER },
        ],
      }).body;
      expect(outputFor(body, "call_dup")).toBe(SUCCESS_EMPTY_WRAPPER);
      expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
    });
  }

  test("leaves non-exec, non-string, and ordinary non-empty custom outputs unchanged", () => {
    const objectOutput = { result: "structured" };
    const body = build({
      input: [
        { type: "custom_tool_call", call_id: "call_other", name: "other", input: "noop" },
        { type: "custom_tool_call_output", call_id: "call_other", output: SUCCESS_EMPTY_WRAPPER },
        { type: "custom_tool_call", call_id: "call_object", name: "exec", input: "noop" },
        { type: "custom_tool_call_output", call_id: "call_object", output: objectOutput },
        { type: "custom_tool_call", call_id: "call_normal", name: "exec", input: "noop" },
        { type: "custom_tool_call_output", call_id: "call_normal", output: "normal stdout" },
      ],
    }).body;
    expect(outputFor(body, "call_other")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(outputFor(body, "call_object")).toBe(JSON.stringify(objectOutput));
    expect(outputFor(body, "call_normal")).toBe("normal stdout");
    expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
  });
```

- [ ] **Step 6: Add pipeline-precedence and provider-policy tests**

Append the remaining tests and close the `describe` block:

```ts
  test("keeps generic empty annotation ahead of exec-specific diagnosis", () => {
    const body = build({
      annotateEmpty: true,
      input: pairedCustomExec(""),
    }).body;
    expect(outputFor(body, "call_exec")).toBe(EMPTY_TOOL_OUTPUT_ANNOTATION);
    expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
  });

  test("keeps call-ID-less output on the predecessor truthful carrier path", () => {
    const body = build({
      input: [{ type: "custom_tool_call_output", name: "exec", output: SUCCESS_EMPTY_WRAPPER }],
    }).body;
    expect(JSON.stringify(body)).toContain("original call_id missing");
    expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
  });

  test("normalizes an eligible paired wrapper on noncanonical forward and stateless routes", () => {
    for (const options of [
      { provider: NONCANONICAL_FORWARD },
      { stateless: true },
    ] satisfies BuildOptions[]) {
      const body = build(options).body;
      expect(String(body.instructions)).toContain(CODE_MODE_RESULT_ECHO_SENTENCE);
      expect(outputFor(body, "call_exec")).toBe(EMPTY_EXEC_OUTPUT_MESSAGE);
    }
  });

  test("is a no-op for unpaired stateful output and preserves existing forward/stateless policy", () => {
    const unpaired = [{ type: "custom_tool_call_output", call_id: "call_orphan", output: SUCCESS_EMPTY_WRAPPER }];

    const stateful = build({ input: unpaired }).body;
    expect(outputFor(stateful, "call_orphan")).toBe(SUCCESS_EMPTY_WRAPPER);

    for (const options of [
      { provider: NONCANONICAL_FORWARD },
      { stateless: true },
    ] satisfies BuildOptions[]) {
      const body = build({ ...options, input: unpaired }).body;
      expect(JSON.stringify(body)).toContain("[tool output for call_orphan]");
      expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
    }
  });

  test("does not mutate raw body, input items, or logical tools while normalizing", () => {
    const input = pairedCustomExec();
    const contextTools = [CODE_MODE_EXEC, WAIT_TOOL];
    const rawInputSnapshot = structuredClone(input);
    const toolsSnapshot = structuredClone(contextTools);
    const result = build({ input, contextTools });

    expect(result.rawBody).toEqual(result.rawBodySnapshot);
    expect(result.rawBody.instructions).toBe(BASE_INSTRUCTIONS);
    expect(input).toEqual(rawInputSnapshot);
    expect(contextTools).toEqual(toolsSnapshot);
    expect(result.rawBody.input).toBe(input);
    expect(result.rawBody.tools).toEqual(contextTools.map(wireTool));
    expect(result.contextTools).toBe(contextTools);
    expect(outputFor(result.body, "call_exec")).toBe(EMPTY_EXEC_OUTPUT_MESSAGE);
  });

  test("preserves the legacy successful-wrapper grammar on a bounded short corpus", () => {
    const corpus = [
      "",
      " ",
      "<empty>",
      "  <empty>",
      "Output:",
      "Output:   ",
      "Output:\t\n <empty>\r\n",
      "Output:<empty><empty>",
      "Output: payload",
      "Script completed\n",
      "Script completed detail\nOutput:",
      "Command finished with suffix\n\nWall time 0.2s\nOutput: <empty>",
      "Execution finished\r\nOutput:",
      "Execution finished without newline",
      "Wall time 1s\nOutput:",
      "Wall time without newline",
      "Script failed\nOutput:",
      "Script completed\n<empty>",
      "Script completed\n  <empty>",
      "Script completed\n\nWall time 1s\n\nOutput:\n<empty>",
    ];

    for (const value of corpus) {
      expect(EMPTY_EXEC_OUTPUT_REGEX.test(value))
        .toBe(LEGACY_SUCCESSFUL_WRAPPER_REGEX.test(value));
    }
  });

  test("classifies a long successful-wrapper near-match in bounded CPU work", () => {
    const warmup = `Output:${" ".repeat(8_000)}x`;
    const malformed = `Output:${" ".repeat(64_000)}x`;

    // Warm up allocation and JIT outside the measured call.
    build({ input: pairedCustomExec(warmup, "call_warmup") });

    const before = process.cpuUsage();
    const body = build({ input: pairedCustomExec(malformed, "call_long") }).body;
    const spent = process.cpuUsage(before);
    const cpuMs = (spent.user + spent.system) / 1000;

    expect(outputFor(body, "call_long")).toBe(malformed);
    expect(cpuMs).toBeLessThan(250);
  });
});
```

The orphan assertion intentionally locks the current `repairOrphanedInputItems()` prefix. Do not change production behavior or loosen it to a generic `message` check.

- [ ] **Step 7: Run the focused test and verify RED**

Run:

```bash
bun test tests/responses-code-mode-exec-output-guard.test.ts
```

Expected non-zero result:

- the fresh third-party prevention test fails because `CODE_MODE_RESULT_ECHO_SENTENCE` is absent;
- eligible matrix rows fail because `EMPTY_EXEC_OUTPUT_MESSAGE` is absent and the wrapper remains;
- successful/failed wrapper tests fail for the same missing normalizer;
- after the first GREEN, the adversarial near-match fails its 250 ms CPU tripwire against the
  overlapping successful-wrapper regex; measured plan-authoring growth was approximately 27 ms at
  8,000 spaces, 105 ms at 16,000, 412 ms at 32,000, and 1,645 ms at 64,000;
- isolation/provenance tests that describe existing behavior may already pass.

If the harness fails before these assertions, fix only the test setup and rerun until RED proves the missing production behavior. Record command, exit status, failing test names, and the first assertion diff. Do not edit production code before this evidence exists.

---

### Task 2: Implement the Shared Scanner, Eligibility, Paired Diagnosis, and Preventive Echo GREEN

**Files:**
- Modify: `src/adapters/exec-tool-result-normalize.ts:14-90` to replace the successful-wrapper regex engine path with a monotonic scanner while preserving `.test()` compatibility
- Modify: `src/adapters/openai-responses.ts:1-35`
- Modify: `src/adapters/openai-responses.ts:852-927` near `toolOutputText()`, `repairCallIdlessToolOutputs()`, and generic empty-output annotation
- Modify: `src/adapters/openai-responses.ts:2097-2207` at the early repair pipeline and late routed instruction composition
- Test: `tests/responses-code-mode-exec-output-guard.test.ts`

**Interfaces:**
- Consumes: `toolChoiceToolPredicate()`, `isCodexCodeModeExecTool()`, `isBareShellBridgeTool()`, `CODE_MODE_RESULT_ECHO_SENTENCE`, and `normalizeEmptyExecToolResultText()`.
- Produces: shared `isSuccessfulEmptyExecWrapper()`, compatibility `EMPTY_EXEC_OUTPUT_REGEX.test()`, and private `isRoutedCodeModeExecOutputGuardEligible()`, `normalizePairedCodeModeExecOutputs()`, and `appendCodeModeResultEchoSentence()`.
- Preserves: `repairCallIdlessToolOutputs()`, `annotateEmptyResponsesToolOutputs()`, `repairOrphanedInputItems()`, custom-tool lowering, progress-contract composition, and canonical destination behavior.

- [ ] **Step 1: Add only the required existing-helper imports**

Change the top imports to add `toolChoiceToolPredicate` and the two existing helper modules:

```ts
import {
  namespacedToolName,
  toolChoiceToolPredicate,
  type AdapterEvent,
  type OcxParsedRequest,
  type OcxProviderConfig,
  type OcxUsage,
  type TierDecision,
} from "../types";
import {
  CODE_MODE_RESULT_ECHO_SENTENCE,
  normalizeEmptyExecToolResultText,
} from "./exec-tool-result-normalize";
import { isBareShellBridgeTool, isCodexCodeModeExecTool } from "./tool-catalog-nudge";
```

Do not import `buildNonOpenAIToolCatalogNudgeForTools()`; native Responses tool names are rewritten later, and this task must not inject a pre-lowering full catalog.

- [ ] **Step 2: Replace the shared successful-wrapper regex with a monotonic compatibility scanner**

In `src/adapters/exec-tool-result-normalize.ts`, remove the regex declaration at the top. Keep the
existing whitespace helper, then add this code immediately after `skipFailedWrapperLine()`:

```ts
const SUCCESSFUL_EXEC_WRAPPER_PREFIXES = [
  "Script completed",
  "Command finished",
  "Execution finished",
] as const;

function skipSuccessfulWrapperLine(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  if (newline === -1) return -1;
  let index = newline + 1;
  while (index < text.length && text[index] === "\n") index += 1;
  return index;
}

export function isSuccessfulEmptyExecWrapper(text: string): boolean {
  let index = 0;
  if (SUCCESSFUL_EXEC_WRAPPER_PREFIXES.some(prefix => text.startsWith(prefix, index))) {
    index = skipSuccessfulWrapperLine(text, index);
    if (index === -1) return false;
  }
  if (text.startsWith("Wall time", index)) {
    index = skipSuccessfulWrapperLine(text, index);
    if (index === -1) return false;
  }
  if (text.startsWith("Output:", index)) {
    index = skipFailedWrapperWhitespace(text, index + "Output:".length);
  }
  if (text.startsWith("<empty>", index)) index += "<empty>".length;
  return skipFailedWrapperWhitespace(text, index) === text.length;
}

/** Backward-compatible `.test()` surface for the existing Cursor consumer. */
export const EMPTY_EXEC_OUTPUT_REGEX: Pick<RegExp, "test"> = {
  test: isSuccessfulEmptyExecWrapper,
};
```

Do not alter `isFailedEmptyExecWrapper()`. Do not add a length cap or adapter-local classifier. The
scanner must preserve the old successful grammar and make one monotonic pass with no prefix retry.

- [ ] **Step 3: Add the one shared request-level eligibility helper**

Immediately before `toolOutputText()`, add:

```ts
function isRoutedCodeModeExecOutputGuardEligible(
  parsed: OcxParsedRequest,
  body: unknown,
  provider: OcxProviderConfig,
): boolean {
  if (parsed._compactionRequest === true) return false;
  if (isOpenAiOperatedResponsesDestination(provider)) return false;
  if (!isPlainObject(body) || typeof body.instructions !== "string") return false;

  const tools = parsed.context.tools ?? [];
  const visible = tools.filter(toolChoiceToolPredicate(parsed.options.toolChoice, tools));
  return visible.some(isCodexCodeModeExecTool)
    && !visible.some(isBareShellBridgeTool);
}
```

This helper is the only source of truth for both new operations. Do not repeat any subset of its conditions at either call site.

- [ ] **Step 4: Add the copy-on-change paired custom-exec normalizer**

Immediately after `repairCallIdlessToolOutputs()` and before `isToolOutputEmpty()`, add:

```ts
type CustomCallOccurrence = {
  count: number;
  call: Record<string, unknown>;
};

function normalizePairedCodeModeExecOutputs(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;

  const calls = new Map<string, CustomCallOccurrence>();
  for (const item of body.input) {
    if (!isPlainObject(item) || item.type !== "custom_tool_call") continue;
    if (typeof item.call_id !== "string" || item.call_id.trim().length === 0) continue;
    const occurrence = calls.get(item.call_id);
    if (occurrence) occurrence.count += 1;
    else calls.set(item.call_id, { count: 1, call: item });
  }

  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item) || item.type !== "custom_tool_call_output") return item;
    if (typeof item.call_id !== "string" || item.call_id.trim().length === 0) return item;
    if (typeof item.output !== "string") return item;

    const occurrence = calls.get(item.call_id);
    if (!occurrence || occurrence.count !== 1) return item;
    if (occurrence.call.name !== "exec" || occurrence.call.namespace !== undefined) return item;

    const normalized = normalizeEmptyExecToolResultText(item.output, { toolName: "exec" });
    if (normalized === undefined || normalized === item.output) return item;
    changed = true;
    return { ...item, output: normalized };
  });

  return changed ? { ...body, input } : body;
}
```

The first pass counts every custom call before checking its name. Do not narrow the map to exec calls; `exec + non-exec` with the same ID must remain ambiguous.

- [ ] **Step 5: Add the idempotent instruction appender**

Immediately after the result normalizer, add:

```ts
function appendCodeModeResultEchoSentence(body: unknown): unknown {
  if (!isPlainObject(body) || typeof body.instructions !== "string") return body;
  if (body.instructions.includes(CODE_MODE_RESULT_ECHO_SENTENCE)) return body;
  const instructions = body.instructions.length > 0
    ? `${body.instructions}\n\n${CODE_MODE_RESULT_ECHO_SENTENCE}`
    : CODE_MODE_RESULT_ECHO_SENTENCE;
  return { ...body, instructions };
}
```

Do not reorder an already-present routed progress contract. Fresh requests receive the echo sentence before the existing progress appender runs.

- [ ] **Step 6: Activate the paired normalizer at the predecessor-owned early boundary**

In `buildRequest()`, calculate eligibility after state-policy normalization and before generic output annotation, then activate the new normalizer immediately after the predecessor helper:

```ts
const stateless = provider.statelessResponses === true;
if (stateless) outBody = stripStatefulResponsesParams(outBody);
const codeModeExecOutputGuardEligible = isRoutedCodeModeExecOutputGuardEligible(
  parsed,
  outBody,
  provider,
);
if (provider.annotateEmptyToolOutputs === true) {
  outBody = annotateEmptyResponsesToolOutputs(outBody, true);
}
outBody = repairCallIdlessToolOutputs(outBody, {
  omitInputImages: parsed._compactionRequest === true
    && !isCanonicalOpenAiForwardProvider(provider),
});
if (codeModeExecOutputGuardEligible) {
  outBody = normalizePairedCodeModeExecOutputs(outBody);
}
if (forward || stateless) {
  outBody = repairOrphanedInputItems(outBody, unexpandedMiss, stateless && !forward);
}
```

Do not move, merge, or edit the predecessor helper. Generic annotation must still run first; broad orphan repair must still run last in this four-step sequence.

- [ ] **Step 7: Activate prevention immediately before the existing routed progress contract**

At the late instruction boundary, add only the first `if`:

```ts
if (codeModeExecOutputGuardEligible) {
  outBody = appendCodeModeResultEchoSentence(outBody);
}
if (parsed._compactionRequest !== true && !isOpenAiOperatedResponsesDestination(provider)) {
  outBody = applyRoutedProgressContractToResponsesBody(outBody);
}
```

Do not combine these conditions or change the existing progress predicate; the single saved eligibility decision already includes destination, compaction, instruction, tool-choice, and semantic code-mode checks.

- [ ] **Step 8: Run the focused test and verify GREEN**

Run:

```bash
bun test tests/responses-code-mode-exec-output-guard.test.ts
```

Expected: all tests pass. Confirm the positive prevention/result rows pass as well as canonical, compaction, provenance, duplicate-ID, generic annotation, and orphan-policy negative rows.

- [ ] **Step 9: Run directly coupled regressions**

Run:

```bash
bun test \
  tests/responses-call-idless-tool-output.test.ts \
  tests/tool-catalog-nudge.test.ts \
  tests/openai-responses-passthrough.test.ts \
  tests/fork-routed-progress-contract.test.ts \
  tests/cursor-exec-empty-result.test.ts \
  tests/kiro-adapter.test.ts
```

Expected: all selected tests pass with no edits to those existing test files.

- [ ] **Step 10: Check the task-scoped diff and minimum official delta**

Run:

```bash
TASK_MERGE_BASE=$(git merge-base upstream/dev HEAD)
git diff --check -- \
  src/adapters/exec-tool-result-normalize.ts \
  src/adapters/openai-responses.ts \
  tests/responses-code-mode-exec-output-guard.test.ts
git diff --stat -- \
  src/adapters/exec-tool-result-normalize.ts \
  src/adapters/openai-responses.ts \
  tests/responses-code-mode-exec-output-guard.test.ts
git diff --numstat "$TASK_MERGE_BASE" -- src/adapters/openai-responses.ts
git diff -U0 "$TASK_MERGE_BASE" -- src/adapters/openai-responses.ts
git diff --numstat "$TASK_MERGE_BASE" -- src/adapters/exec-tool-result-normalize.ts
git diff -U0 "$TASK_MERGE_BASE" -- src/adapters/exec-tool-result-normalize.ts
```

Expected: no whitespace errors; intent-to-add makes the working diff name two production files plus the complete new test. The single-ended merge-base comparison includes committed Fork history and current working edits. The adapter increment remains imports, three private helpers, and two guarded calls; the shared-helper increment is only the monotonic scanner and `.test()` compatibility object. If a third production file appears necessary, stop and revise the Spec instead of widening silently.

---

### Task 3: Verify, Independently Review, and Commit the Implementation

**Files:**
- Review: `src/adapters/exec-tool-result-normalize.ts`
- Review: `src/adapters/openai-responses.ts`
- Review: `tests/responses-code-mode-exec-output-guard.test.ts`
- Preserve: every other path and all predecessor commits

**Interfaces:**
- Consumes: Task 1 RED evidence and Task 2 GREEN implementation.
- Produces: repository verification evidence, two independent L2 review decisions, and one Chinese implementation commit.

- [ ] **Step 1: Run repository gates proportionate to a shared network adapter**

Run:

```bash
bun run typecheck
bun scripts/test.ts --changed=origin/dev
bun run privacy:scan
git diff --check
```

Expected: all commands exit 0. At this point reviewed document-only and unrelated branch-governance changes have been committed and pushed to `origin/dev`; only the shared normalizer, adapter, and intent-to-add test are uncommitted, so the selector must report exactly three changed files. The central adapter can still fan out to many import-connected tests; that is valid task scope. Do not replace this command with bare `bun test`. Run the full `bun run test` only if the task-scoped selector reports an ambiguous indirect dependency or the user explicitly requests the PR-ready full gate.

Never use `bun run test:changed` or bare `--changed=dev` for this Fork task: the alias resolves `upstream/dev` first. The authoritative baseline is always explicit `origin/dev`.

- [ ] **Step 2: Produce the bounded implementation review package**

Record:

```bash
TASK_MERGE_BASE=$(git merge-base upstream/dev HEAD)
git diff -- \
  src/adapters/exec-tool-result-normalize.ts \
  src/adapters/openai-responses.ts \
  tests/responses-code-mode-exec-output-guard.test.ts
git diff --numstat -- \
  src/adapters/exec-tool-result-normalize.ts \
  src/adapters/openai-responses.ts \
  tests/responses-code-mode-exec-output-guard.test.ts
git diff --numstat "$TASK_MERGE_BASE" -- src/adapters/openai-responses.ts
git diff -U0 "$TASK_MERGE_BASE" -- src/adapters/openai-responses.ts
git diff --numstat "$TASK_MERGE_BASE" -- src/adapters/exec-tool-result-normalize.ts
git diff -U0 "$TASK_MERGE_BASE" -- src/adapters/exec-tool-result-normalize.ts
git status --short
```

Because Task 1 used `git add -N`, the first two commands must include the full new-test diff rather than only its filename. If they do not, stop and repair the review package before dispatching reviewers.

The review package must include:

- `DOC_COMMIT`, implementation base commit, refreshed `upstream/dev`, `upstream-release`, merge-base, and pre/post adapter numstat;
- approved Spec and Plan paths;
- exact Task 1 RED output;
- focused GREEN, bounded near-match CPU result, coupled regression, typecheck, task-scoped `--changed=origin/dev`, privacy, and diff-check outputs;
- named risks: successful-wrapper scan complexity/parity, semantic code-mode detection, shared eligibility, canonical isolation, compaction isolation, same-kind unique pairing, duplicate IDs, generic annotation precedence, predecessor call-ID-less repair, broad orphan policy, input immutability, and minimum official delta.

- [ ] **Step 3: Dispatch independent L2 Spec Compliance review**

Use a fresh read-only reviewer with `fork_turns: "none"`:

```text
REVIEW_MODE: SPEC_COMPLIANCE
REVIEW_PHASE: INITIAL
REVIEW_SCOPE_ID: responses-code-mode-exec-output-guard-2026-08-31
```

Provide only the bounded requirements, approved Spec, approved Plan, task-scoped diff, implementation report, and real verification evidence. Do not pass the main-session history or a predicted verdict.

- [ ] **Step 4: Dispatch independent L2 Code Quality review**

Use a second fresh read-only reviewer with `fork_turns: "none"`:

```text
REVIEW_MODE: CODE_QUALITY
REVIEW_PHASE: INITIAL
REVIEW_SCOPE_ID: responses-code-mode-exec-output-guard-2026-08-31
```

Require explicit named-risk checks for algorithmic pairing correctness, request immutability, transform ordering, canonical byte-shape preservation, privacy, test quality, and relative-official minimum modification surface.

- [ ] **Step 5: Resolve every blocking finding through the original reviewer**

For each Critical or Important finding:

1. update the implementation with the smallest fix;
2. rerun the focused test and every verification command affected by that fix;
3. send `REVIEW_PHASE: RE_REVIEW`, complete `PRIOR_FINDINGS`, scoped `FIX_DIFF`, and fresh `VERIFICATION_EVIDENCE` to the same reviewer;
4. repeat until both independent reviews report PASS.

Minor findings may remain only when explicitly recorded as non-blocking residual risk. Do not commit while either review has an open Critical or Important finding.

- [ ] **Step 6: Stage only the functional implementation**

Run:

```bash
git add \
  src/adapters/exec-tool-result-normalize.ts \
  src/adapters/openai-responses.ts \
  tests/responses-code-mode-exec-output-guard.test.ts
git diff --cached --check
git diff --cached --stat
git diff --cached --name-only
```

Expected staged names are exactly the shared normalizer, production adapter, and new isolated test. The document and branch-governance commits are separate, and no installer, relay, core, existing test, config, or generated file may be staged.

- [ ] **Step 7: Commit the reviewed functional boundary**

Run:

```bash
git commit -m "fix(responses): 修复 code-mode exec 空输出误判"
```

Record the implementation commit id and the two final reviewer verdicts.

- [ ] **Step 8: Confirm the final repository state without deploying**

Run:

```bash
git status --short
git log -3 --oneline --decorate
```

Expected: clean tree; the newest two task commits are the Chinese implementation commit and the preceding documentation commit. Report that source verification is complete and that global installation/restart/live Desktop replay were intentionally not performed because they require separate authorization.

---

## Acceptance Checklist

- [ ] An eligible third-party code-mode request contains `CODE_MODE_RESULT_ECHO_SENTENCE` exactly once.
- [ ] The reproduced successful wrapper becomes `EMPTY_EXEC_OUTPUT_MESSAGE` only for a unique custom exec pair.
- [ ] A failed wrapper becomes `FAILED_EXEC_OUTPUT_MESSAGE`.
- [ ] Canonical OpenAI API and ChatGPT forward receive neither new instruction nor result rewrite.
- [ ] Compaction, structured exec, bare shell bridge, excluded tool choice, and invalid instructions receive neither operation.
- [ ] Namespaced MCP shell does not cancel genuine code mode.
- [ ] Function/local-shell history, cross-kind pairs, unpaired outputs, and every duplicate-ID shape remain outside this normalizer.
- [ ] Generic empty annotation, call-ID-less degradation, and broad orphan repair retain their existing precedence and content.
- [ ] Original raw body, input items, and logical tools are not mutated.
- [ ] Production scope is exactly the shared normalizer plus one adapter file; test scope is exactly one new isolated test file.
- [ ] The long successful-wrapper near-match remains byte-identical and stays below the bounded CPU tripwire.
- [ ] Focused tests, coupled regressions, typecheck, task-scoped `--changed=origin/dev`, privacy scan, and diff check pass.
- [ ] Independent Spec Compliance and Code Quality reviewers both pass with no open Critical/Important findings.
- [ ] Documentation and implementation are separate Chinese commits.
- [ ] No global installation, service restart, or persisted conversation mutation occurs.

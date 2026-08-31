# Responses Code-Mode Exec Output Guard Design

## Goal

Prevent third-party native Responses models from repeatedly misreading a successful Codex
code-mode `exec` cell as an empty search or broken shell when the generated JavaScript awaited a
nested helper result but never emitted it through `text(...)` or `notify(...)`.

The repair must preserve the Codex programmatic-tool contract, keep canonical OpenAI traffic
unchanged, avoid rewriting generated JavaScript, and reuse the provider-neutral echo guidance and
empty-exec diagnostics that already exist in the repository.

## Confirmed failure

On 2026-08-31, a routed `volcengine-agent-plan/glm-5.3-flash` turn issued several code-mode cells of
this form:

```js
await tools.exec_command({ cmd: "..." })
```

The nested commands completed successfully and produced stdout, but the outer V8 cell did not call
`text(...)` or `notify(...)`. The Codex client therefore returned only an empty success wrapper:

```text
Script completed
Wall time 0.2 seconds
Output:
```

The model interpreted that wrapper as an empty search result or inconsistent shell propagation,
repeated equivalent searches, and eventually discovered the correct `text(...)` pattern itself.
No command, filesystem, or relay transport failure occurred.

The live request used the `openai-responses` adapter and advertised `exec` as a provider-facing
function after the existing custom-tool compatibility lowering. The repository already contains:

- `CODE_MODE_RESULT_ECHO_SENTENCE`, which states before execution that a bare nested helper result
  is discarded unless the program emits it;
- `EMPTY_EXEC_OUTPUT_MESSAGE` and `FAILED_EXEC_OUTPUT_MESSAGE`, which explain successful and failed
  empty exec wrappers after execution;
- semantic detection for Codex's freeform code-mode `exec`, distinct from a structured tool that
  merely shares the name;
- translated-adapter and Cursor/Kiro integrations that already use these contracts.

Native third-party Responses passthrough currently uses neither protection. Its optional generic
`annotateEmptyToolOutputs` path also cannot repair the reproduced wrapper because the wrapper is a
non-empty string.

## Predecessor dependency

Implementation is sequenced after the in-progress Responses call-ID-less tool-output repair. That
task adds `repairCallIdlessToolOutputs()` to the same adapter pipeline. Before implementation:

1. wait for the predecessor task to finish and commit;
2. refresh `HEAD`, the scoped diff, and the exact helper order;
3. preserve its behavior and tests without folding the two fixes into one semantic helper;
4. place this task's result normalization after optional generic empty-output annotation and after
   call-ID-less degradation, but before the existing broad forward/stateless orphan repair.

The two tasks solve different invalid states. A call-ID-less output has no valid Responses identity
and must degrade to a truthful text carrier. This task handles a validly paired custom code-mode
exec result whose outer cell emitted no usable value.

## Scope

### In scope

- Native `openai-responses` requests sent to destinations not operated by OpenAI.
- Non-compaction turns whose visible tool choice includes Codex's semantic freeform code-mode
  `exec` and no bare top-level shell bridge.
- Existing string `instructions` fields.
- `custom_tool_call(name=exec)` items that can be uniquely paired by a non-empty `call_id` with a
  `custom_tool_call_output` item in the same outbound `input` array, before the existing
  provider-facing custom-to-function lowering.
- Successful and failed empty exec wrappers recognized by the existing
  `normalizeEmptyExecToolResultText()` contract.
- Stateful, stateless, key-auth, and noncanonical forward Responses destinations inside the same
  non-OpenAI gate.

### Out of scope

- Canonical ChatGPT forwarding and the official OpenAI API.
- Routed compaction requests.
- Requests with missing or non-string top-level `instructions`.
- Automatically executing, retrying, or recovering the nested command.
- Recovering stdout that the outer V8 program did not emit.
- Rewriting generated JavaScript to insert `text(...)`, `notify(...)`, `return`, or wrappers.
- Automatically echoing every nested tool result.
- Guessing a tool name from an unpaired output, item position, transcript prose, or historical
  provider state.
- Treating `function_call`, `function_call_output`, or `local_shell_call` history as proof of the
  client-owned freeform code-mode `exec` identity.
- Changing generic empty-tool-output configuration or annotations.
- Changing tool lowering, namespace aliases, custom-tool restoration, tool search, tool choice,
  route selection, retry/fallback behavior, provider catalog data, reasoning replay, encrypted
  content, or agent-task recovery.
- Installing, replacing, restarting, or repairing the globally installed OpenCodex service.
- Adding configuration, GUI, docs-site, or management API surface.

## Options considered

### Rely on the model and existing tool description

This preserves the current wire but leaves a reproduced multi-call failure mode unchanged. The
model already had access to `text(...)` as a helper and still inferred REPL-style implicit echo.
This is not selected.

### Inject the complete non-OpenAI tool-catalog nudge

Translated adapters can build their final tool names before composing that nudge. Native Responses
passthrough later lowers custom tools, tool search, and namespaces into provider-facing functions.
Injecting a catalog derived from the pre-lowering logical tools could name a different surface from
the final wire and would broaden this task into full Responses catalog-prompt parity. This is not
selected.

### Inject only the shared echo sentence

This is selected for prevention. The sentence describes the V8 result contract without naming or
renaming any provider-facing tool. It reuses the single wording already shared by the repository's
pre-call and post-call protections.

### Repair only after the first empty result

This would stop repeated retries but still wastes the first call and leaves the model uncertain
until the next turn. It is useful as a fallback but insufficient alone.

### Combine narrow prevention and narrow post-call diagnosis

This is the selected complete design. Prevention covers the normal path. Post-call diagnosis
handles models that ignore or forget the instruction without inventing missing stdout or execution
history.

## Design

### 1. Code-mode eligibility

Derive the effective visible logical tools from `parsed.context.tools` and
`parsed.options.toolChoice` using the existing tool-choice predicate. Use one request-level
eligibility result for both the preventive appender and the paired-result normalizer. The request
is code-mode eligible only when:

- at least one visible tool satisfies `isCodexCodeModeExecTool()`;
- no visible tool satisfies `isBareShellBridgeTool()`;
- the destination is not OpenAI-operated;
- the request is not a compaction request; and
- the outbound body has a string `instructions` field.

This preserves the existing semantic distinction:

- a freeform bare `exec` with no bare shell bridge is Codex code mode;
- a structured `exec` is not code mode;
- a freeform `exec` next to a bare `exec_command` or `shell_command` is the flat bridge shape;
- a namespaced MCP shell helper does not cancel Codex code mode;
- `tool_choice: none` or an allowed-tool set that excludes `exec` does not receive guidance.

The eligible semantic tool is the bare, unnamespaced freeform `exec`. The result normalizer may
therefore recognize only a same-input `custom_tool_call` whose name is exactly `exec` and whose
namespace is absent. A `custom_tool_call` is the client wire representation of that freeform tool;
the adapter may lower it to `function_call(name=exec)` only after this task's normalization step.
A historical `function_call(name=exec)` is not sufficient provenance and remains unchanged.

### 2. Preventive instruction

Append exactly `CODE_MODE_RESULT_ECHO_SENTENCE` to the existing string `instructions`, separated by
one blank line. If the exact sentence is already present, return the original body reference.

Do not append the complete tool catalog, synthesize a new `instructions` field, or modify
non-string instruction values. Run this alongside the existing routed progress-contract step after
the provider-facing tool transformations and before GLM/Kimi outbound compatibility. On the normal
fresh path, add the echo sentence before the progress contract. If either exact sentence already
exists, preserve the existing instruction order and add only the missing sentence; do not reorder
caller-provided instructions merely to make the progress contract physically last.

Conceptual flow:

```text
logical Codex tool catalog + tool_choice
  -> semantic code-mode eligibility
  -> third-party Responses tool lowering (unchanged)
  -> append shared code-mode echo sentence (new, eligible turns only)
  -> append routed progress contract (unchanged)
  -> provider-specific compatibility and schema normalization (unchanged)
```

### 3. Paired exec-result normalization

Add one private pure body normalizer in `src/adapters/openai-responses.ts`. It runs only when the
same request-level code-mode eligibility used by the preventive appender is true. It performs two
bounded passes over `body.input`:

1. collect every `custom_tool_call` with a non-empty string `call_id`, counting all occurrences per
   ID and retaining the sole call record only while the count is exactly one;
2. inspect only `custom_tool_call_output` items whose non-empty `call_id` resolves to exactly one
   collected custom call and whose unique call is bare, unnamespaced, and named exactly `exec`.

Any duplicated custom-call ID is ambiguous and skipped, even when the records have identical names,
namespaces, or inputs, and also when one call is `exec` while another is a different custom tool.
`function_call_output` pairs only with `function_call` in the existing broad orphan repair and is
outside this normalizer. `local_shell_call` is also outside scope.

For a paired output whose `output` is a string, call:

```ts
normalizeEmptyExecToolResultText(output, {
  toolName: "exec",
})
```

If it returns diagnostic text, replace only the output item's `output` field using a shallow clone.
Otherwise preserve the original item reference. Return the original body reference when no item
changes.

The helper must skip:

- non-exec calls;
- outputs without a same-input paired call;
- all `function_call`, `function_call_output`, and `local_shell_call` items;
- missing, empty, or non-string `call_id` values;
- every duplicated call id, including byte-identical duplicate calls;
- non-string outputs;
- ordinary non-empty exec results;
- all unrelated messages, reasoning, compaction, and tool declarations.

This is diagnostic normalization, not execution recovery. A successful empty wrapper becomes
`EMPTY_EXEC_OUTPUT_MESSAGE`; a failed empty wrapper becomes `FAILED_EXEC_OUTPUT_MESSAGE`. The latter
must never be described as a successful empty cell.

### 4. Request-pipeline position

After the predecessor task lands, preserve this order:

```text
raw routed Responses body
  -> stateful/stateless parameter policy (unchanged)
  -> optional generic empty-output annotation (unchanged and retains precedence)
  -> call-ID-less output degradation (predecessor task)
  -> uniquely paired custom exec empty-wrapper diagnosis (new, eligible third-party
     non-compaction turns)
  -> forward/stateless broad orphan repair (unchanged)
  -> remaining provider and schema transforms (unchanged)
```

Keeping generic annotation first means a provider explicitly configured to annotate a truly empty
string retains that established wording. The reproduced non-empty wrapper bypasses generic
annotation and reaches the exec-specific diagnostic.

### 5. Immutability and privacy

Both new operations are copy-on-change:

- do not mutate `parsed._rawBody`, its input array, input items, context tools, or instructions;
- do not log generated JavaScript, command output, instruction text, or diagnostic bodies;
- preserve every non-matching object and string byte-for-byte;
- do not add provider-debug fields unless a later review proves existing shape diagnostics cannot
  establish delivery without private content.

The existing outbound diagnostics already record destination, model, tool presence, input item
types, and body size. This task does not require a new persisted log surface.

## Error and compatibility behavior

- A compliant model emits nested results through `text(...)` and sees no post-call rewrite.
- A model that omits the emit receives an explicit diagnostic on the next Responses request instead
  of a misleading empty wrapper.
- A failed empty cell remains a failure diagnosis.
- Ordinary shell commands with real stdout remain unchanged.
- This task's paired-exec normalizer is a no-op for an unpaired wrapper because it cannot prove
  which tool produced it. An ordinary stateful key-auth route therefore preserves the original
  output. Forward/stateless routes continue through the existing broad orphan repair and may
  degrade that output into their established truthful user-message carrier; this task must not
  bypass or alter that provider-policy behavior.
- Canonical OpenAI and ChatGPT requests remain byte-shape native with respect to this task.
- Compaction remains unchanged and does not receive operational tool guidance.
- The predecessor's call-ID-less text carriers remain text carriers and are never reclassified as
  paired exec results.
- Existing custom-tool lowering converts the paired custom call/output to provider-facing function
  history later; the client-facing call/output identity remains intact because normalization
  changes only output text before that conversion.

## File scope

Required production file:

- Modify `src/adapters/openai-responses.ts` to add the local eligibility/appender and paired-result
  normalizer, import existing predicates/constants/helpers, and activate them at two existing
  request-pipeline boundaries.

Required test file:

- Add `tests/responses-code-mode-exec-output-guard.test.ts` for isolated regression coverage,
  following the local test-file isolation rule.

No changes are required in:

- `src/adapters/tool-catalog-nudge.ts`;
- `src/adapters/exec-tool-result-normalize.ts`;
- provider registry/configuration;
- Responses core, relay, routing, GUI, docs-site, or structure documents.

If implementation proves that either existing shared helper must change, stop and revise this Spec
before widening the production file scope.

## Test design

The dedicated test must construct serialized requests through
`createResponsesPassthroughAdapter()` and a real `TranslatorBudget`, rather than testing a copied
helper implementation.

Required prevention cases:

1. A third-party key-auth Responses request with semantic freeform `exec`, string instructions, and
   `tool_choice: auto` contains `CODE_MODE_RESULT_ECHO_SENTENCE` exactly once.
2. Existing instructions and the routed progress contract remain present, with the original raw
   body unchanged.
3. A canonical OpenAI API request does not receive the sentence.
4. A structured `exec` does not receive it.
5. A freeform `exec` beside a bare shell bridge does not receive it.
6. A namespaced MCP shell tool does not cancel genuine code mode.
7. `tool_choice: none` and an allowed-tool set excluding `exec` do not receive it.
8. Compaction, missing instructions, and non-string instructions remain unchanged.
9. An already-present sentence is not duplicated.

Required result cases:

10. A same-input uniquely paired `custom_tool_call(name=exec)` plus the reproduced successful empty wrapper
    becomes `EMPTY_EXEC_OUTPUT_MESSAGE` after provider-facing serialization.
11. A failed empty wrapper becomes `FAILED_EXEC_OUTPUT_MESSAGE`, never the successful diagnostic.
12. A current-turn eligible request whose input also contains paired historical `function_call`
    names `exec`, `exec_command`, `shell`, or `local_shell` leaves all of those outputs unchanged.
13. A `custom_tool_call` with any name other than bare `exec` leaves the same wrapper unchanged.
14. A cross-kind same-ID `function_call`/`custom_tool_call_output` pair and the reverse kind remain
    under existing policy and never receive this task's exec diagnostic.
15. An unpaired custom output is a no-op for this task: it stays unchanged on ordinary stateful
    key-auth, while forward/stateless requests still follow existing orphan degradation and do not
    contain this task's exec diagnostic.
16. Duplicate custom calls sharing one ID remain unchanged when their records are identical, when
    two exec records differ, and when one call is bare exec while the other is a non-exec custom
    tool; none may produce this task's diagnostic.
17. A normal non-empty custom exec output remains byte-identical.
18. A non-string output remains unchanged.
19. A call-ID-less output continues through the predecessor task's truthful text-carrier path.
20. The raw body, input array, input items, and context tools remain unchanged.

Required shared-gate result matrix:

21. Parameterize a paired custom exec wrapper through canonical OpenAI API, canonical ChatGPT
    forward, structured `exec`, visible bare shell bridge, namespaced MCP shell, `tool_choice: none`,
    an allowed-tool set excluding exec, compaction, missing instructions, and non-string
    instructions. Only the genuine third-party code-mode case and the namespaced-MCP-shell case may
    receive either the echo sentence or exec-output diagnostic.
22. Assert both the final `instructions` and output field in every matrix row so the two new
    operations cannot diverge in eligibility.
23. With `annotateEmptyToolOutputs: true`, a paired custom exec whose output is the truly empty
    string retains `EMPTY_TOOL_OUTPUT_ANNOTATION`; generic annotation keeps precedence over this
    task's exec-specific normalizer.
24. On a fresh eligible request, the echo sentence precedes the newly appended routed progress
    contract. If the caller already supplied either contract in another position, both remain
    exactly once without reordering existing text.

## Verification and acceptance

Focused source gates:

```bash
bun test tests/responses-code-mode-exec-output-guard.test.ts
bun test tests/responses-call-idless-tool-output.test.ts
bun test tests/tool-catalog-nudge.test.ts
bun test tests/openai-responses-passthrough.test.ts
bun test tests/fork-routed-progress-contract.test.ts
bun test tests/cursor-exec-empty-result.test.ts
bun run typecheck
bun run test:changed
bun run privacy:scan
git diff --check
```

Acceptance requires:

- the historical wrapper shape serializes upstream as the existing explicit exec diagnostic;
- an eligible third-party request receives the exact shared echo sentence once;
- canonical OpenAI, compaction, non-code-mode, and non-empty cases stay unchanged; the new
  normalizer is a no-op for unpaired outputs while existing forward/stateless orphan policy remains
  unchanged;
- the predecessor task's test remains green;
- no production file outside `src/adapters/openai-responses.ts` changes;
- the implementation remains the smallest additive delta relative to the refreshed official
  baseline and predecessor commit.

No global installation or service restart is part of source acceptance. A later live Desktop replay
requires separate explicit authorization for the installation/restart action; if authorized, it
must use the original conversation state rather than editing persisted history.

## Commit and execution sequencing

1. Draft and independently review this Spec and its Plan without touching implementation files.
2. Wait for the predecessor task to reach a terminal completed state and commit its scoped changes.
3. Refresh `HEAD`, `git status`, the official baseline, and the overlapping adapter diff.
4. Update the document only if the landed pipeline differs from the dependency assumed above.
5. Commit the approved Spec/Plan as one Chinese documentation commit.
6. Execute the implementation in the current checkout using the explicitly selected execution
   method; do not create a worktree.
7. Complete focused verification and independent implementation review before the Chinese
   functional implementation commit.

## Residual risks

- Prompt guidance is probabilistic. The paired-result diagnostic is retained because a model can
  still ignore or forget the preventive sentence.
- The same-input pairing requirement intentionally misses histories whose call exists only in
  provider-side state. Widening that boundary would require new provenance and is not justified by
  the reproduced request.
- Exact diagnostic text becomes model-visible. It contains no command body or stdout and reuses the
  existing repository contract, but it can still influence the next model turn by design.
- Both this task and its predecessor touch the shared Responses adapter. Sequencing avoids a write
  conflict, but the final implementation review must re-check pipeline ordering after both land.

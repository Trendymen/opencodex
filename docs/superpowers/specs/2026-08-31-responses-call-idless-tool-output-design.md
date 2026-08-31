# Responses Call-ID-Less Tool Output Repair Design

## Goal

Allow a Codex conversation containing task-coordination tool outputs without a
`call_id` to continue after switching from a permissive Responses provider to a
strict provider, without declaring the destination stateless, inventing tool
call identities, deleting delegation content, or changing valid tool history.

## Confirmed failure

Conversation `01a055cf-5453-7172-aa06-2d5ab7cf964f` completed repeated turns
through `zhipu-bigmodel-codex/glm-5.3-flash`, then failed twice immediately
after switching to `volcengine-agent-plan/glm-5.3-flash`:

```text
HTTP 400 MissingParameter: input.call_id
```

The persisted rollout contains exactly three `function_call_output` items with
no `call_id`. All three are asynchronous `send_message_to_thread` deliveries.
The outbound Volcengine request contains 90 function calls and 93 function-call
outputs, matching those three invalid items. The request fails before the model
emits any token.

The existing official `repairOrphanedInputItems()` implementation already
converts an unpaired tool output into a user message, but the call site runs
only for `authMode: "forward"` or `statelessResponses: true`. Neither the Zhipu
nor Volcengine provider in the reproduced route declares either capability.
Zhipu accepts the invalid shape; Volcengine validates it strictly.

## Scope

### In scope

- Outbound OpenAI Responses bodies built by the passthrough adapter.
- `function_call_output` and `custom_tool_call_output` items whose `call_id` is
  absent, not a string, empty, or whitespace-only.
- Preservation of the original output text and an available tool name.
- Stateful, stateless, forward-auth, and key-auth Responses providers.
- Provider switches within an existing Codex conversation.
- Existing empty-output annotation and full orphan-repair behavior.

### Out of scope

- Mutating rollout JSONL, SQLite state, or an existing Codex conversation.
- Assigning a synthetic `call_id` or guessing a paired call by name, position,
  item id, or timestamp.
- Changing the handling of a non-empty `call_id` that has no paired call in the
  current input. The official `forward || stateless` policy retains ownership
  of that case.
- Marking Volcengine Agent Plan as globally stateless.
- Changing `previous_response_id`, `conversation`, `background`, `metadata`,
  `prompt`, or `store` semantics.
- Changing encrypted V2 agent-task recovery, reasoning replay, route selection,
  provider fallback, or model selection.
- Adding a user-facing configuration option.

## Options considered

### Set `statelessResponses: true` on Volcengine

This enters the existing repair path and fixes the reproduced request, but it
also strips all stateful Responses parameters and enables missing-result
placeholder synthesis for every Volcengine turn. It couples an item-level
schema repair to a provider-wide state declaration and is not selected.

### Run the complete orphan repair for every Responses provider

This also fixes the failure, but it changes the behavior of valid, non-empty
`call_id` outputs whose paired call might live in provider-side state. That is a
larger semantic change than the evidence requires and is not selected.

### Normalize only call-ID-less tool outputs on every Responses route

This is the selected option. A tool result without a non-empty string
`call_id` is invalid under the Responses wire contract regardless of provider
state. Converting only that invalid item into a user message preserves its
content while leaving every valid or state-resolvable item unchanged.

## Design

### Narrow normalizer

Add a private, pure helper in `src/adapters/openai-responses.ts`:

```ts
function repairCallIdlessToolOutputs(body: unknown): unknown
```

The helper returns the original reference unless `body.input` contains at
least one record whose type is `function_call_output` or
`custom_tool_call_output` and whose `call_id` is not a non-empty trimmed
string.

Each matching item becomes this Responses message shape:

```json
{
  "type": "message",
  "role": "user",
  "content": [
    {
      "type": "input_text",
      "text": "[unlinked tool output from send_message_to_thread; original call_id missing]\n..."
    }
  ]
}
```

The label uses a non-empty `name` when present and otherwise uses
`unknown tool`. The content uses the adapter's existing tool-output text
conversion rather than adding a second output serializer.

The normalizer must not:

- synthesize or retain an empty `call_id`;
- claim that a corresponding tool call was executed;
- retain protocol-only fields from the invalid output item;
- change non-matching input items;
- mutate `parsed._rawBody` or the original `input` array.

### Pipeline position

The normalizer runs after optional empty-output annotation and before the
existing complete orphan repair:

```text
raw routed Responses body
  -> stateful/stateless parameter policy (unchanged)
  -> optional empty-output annotation (unchanged)
  -> call-ID-less output normalization (new, every provider)
  -> forward/stateless full orphan repair (unchanged)
  -> all remaining provider and schema transforms (unchanged)
```

This ordering preserves the existing explicit annotation for an empty result,
then removes the structurally invalid output before a strict destination sees
it. Forward and stateless routes continue through their existing broader
repair without double-processing the converted message.

### Why a user message

Dropping the item loses task delegation. Creating a fake call id manufactures
history and may pair with a future call accidentally. A user message is the
existing official degradation strategy for an unpaired output: it preserves
model-visible evidence without representing it as a valid tool execution.

The generated prefix explicitly states that the original call id is missing,
so the model cannot reasonably infer a successful paired invocation from the
carrier alone.

## Error and compatibility behavior

- One malformed item does not fail the whole request locally; it becomes a
  truthful text carrier.
- Multiple malformed outputs are converted independently and remain in input
  order.
- Valid calls and outputs remain byte-equivalent at the object level.
- A non-empty orphan `call_id` keeps the existing provider-state-dependent
  behavior.
- Empty or whitespace-only output remains governed by the existing provider
  annotation setting before conversion.
- Non-text output parts use the existing `toolOutputText()` degradation policy.
- The repair creates no new logs containing output bodies. Existing outbound
  shape diagnostics can show the type-count change without private content.

## Agent-task recovery boundary

Encrypted agent-task recovery operates on encrypted `agent_message` payloads
and routed recovery before ordinary destination execution. This repair only
examines two tool-output item types during the final Responses body build. It
does not inspect, decrypt, strip, or rewrite `encrypted_content`, and it does
not depend on the `agentTaskRecovery` switch.

## File scope

Required files:

- Modify `src/adapters/openai-responses.ts` for the pure normalizer and one
  pipeline call.
- Add `tests/responses-call-idless-tool-output.test.ts` for isolated regression
  coverage, following the local test-file isolation rule.

No production file outside the adapter is required. No config, GUI, docs-site,
core server, recovery, or persisted-state file changes are part of the fix.

## Test design

The dedicated test uses a normal key-auth Responses provider with
`statelessResponses` absent, proving the repair is independent of state policy.

Required cases:

1. A real-shape call-ID-less `send_message_to_thread` function output becomes a
   user message that retains its name and output.
2. A call-ID-less custom-tool output follows the same rule.
3. Missing, non-string, empty, and whitespace-only call ids are invalid.
4. Three invalid outputs are all converted in order.
5. A valid paired function call and output remain unchanged.
6. A valid non-empty orphan output remains unchanged on an ordinary stateful
   key-auth route, preserving existing policy ownership.
7. Stateful top-level fields remain present, proving the fix does not activate
   `statelessResponses` semantics.
8. The final input contains no tool-output item with a missing or blank call id.
9. Existing forward, stateless, DeepSeek, and passthrough regression suites
   remain green.
10. `buildRequest()` does not mutate the supplied raw body, its original input
    array, or any original input item.
11. A converted message does not retain the original tool-output `id`,
    `namespace`, `internal_chat_message_metadata_passthrough`, or invalid
    `call_id` fields.

## Verification and acceptance

Focused gates:

```bash
bun test tests/responses-call-idless-tool-output.test.ts
bun test tests/responses-stateless-dangling-call-repair.test.ts
bun test tests/openai-responses-passthrough.test.ts
bun test tests/deepseek-inbound-wire.test.ts
bun run typecheck
bun run test:changed
bun run privacy:scan
git diff --check
```

After an explicitly authorized local installation/restart, replay conversation
`01a055cf-5453-7172-aa06-2d5ab7cf964f` through
`volcengine-agent-plan/glm-5.3-flash`. Acceptance requires no
`MissingParameter input.call_id`, a normal streamed turn, and outbound debug
type counts consistent with the three invalid outputs becoming messages.

The live replay must not modify the conversation database to remove or patch
the historical records; passing with the original history is the proof that
the compatibility repair works.

## Residual risks

- A provider may previously have accepted a call-ID-less output and attached
  private semantics to it. Such an item is outside the standard Responses
  contract; the selected degradation favors portable, truthful behavior.
- The converted text becomes model-visible user input. The prefix preserves
  its tool origin and unpaired status, but the user-message carrier may still
  make instruction-like content influential to the model; this matches the
  existing official orphan-output degradation strategy.
- Real installation and Desktop replay require separate authorization because
  they replace the installed OCX package and restart user processes.

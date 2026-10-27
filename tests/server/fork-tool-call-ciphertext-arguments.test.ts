import { describe, expect, test } from "bun:test";
import { stripToolCallCiphertextArgumentsInPlace } from "../../src/server/responses/encrypted-payload";
import { FERNET_TASK, SECOND_FERNET_TASK } from "../helpers/agent-task-recovery";

const PLAIN_ARGS = JSON.stringify({ task_name: "v257", agent_type: "reviewer", fork_turns: "none" });

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe("stripToolCallCiphertextArgumentsInPlace", () => {
  test("replaces a poisoned spawn argument and preserves sibling fields", () => {
    const input = [{
      type: "function_call",
      name: "collaboration__spawn_agent",
      call_id: "call-1",
      arguments: JSON.stringify({ task_name: "v257", message: FERNET_TASK }),
    }];
    expect(stripToolCallCiphertextArgumentsInPlace(input)).toBe(1);
    const args = JSON.parse((input[0] as { arguments: string }).arguments);
    expect(args.task_name).toBe("v257");
    expect(args.message).toBe("[encrypted content omitted]");
    expect(JSON.stringify(input)).not.toContain(FERNET_TASK);
  });

  test("replaces a whole-ciphertext arguments string", () => {
    const input = [{
      type: "function_call",
      name: "collaboration__spawn_agent",
      call_id: "call-2",
      arguments: FERNET_TASK,
    }];
    expect(stripToolCallCiphertextArgumentsInPlace(input)).toBe(1);
    expect((input[0] as { arguments: string }).arguments).toBe("[encrypted content omitted]");
  });

  test("replaces every ciphertext field in object-form arguments", () => {
    const input = [{
      type: "function_call",
      name: "collaboration__spawn_agent",
      call_id: "call-multi",
      arguments: {
        task_name: "v257",
        message: FERNET_TASK,
        followup: SECOND_FERNET_TASK,
      },
    }];
    expect(stripToolCallCiphertextArgumentsInPlace(input)).toBe(1);
    const args = (input[0] as { arguments: Record<string, unknown> }).arguments;
    expect(args.task_name).toBe("v257");
    expect(args.message).toBe("[encrypted content omitted]");
    expect(args.followup).toBe("[encrypted content omitted]");
    expect(JSON.stringify(input)).not.toContain(FERNET_TASK);
    expect(JSON.stringify(input)).not.toContain(SECOND_FERNET_TASK);
  });

  test("leaves plaintext collaboration arguments untouched", () => {
    const input = [{
      type: "function_call",
      name: "collaboration__spawn_agent",
      call_id: "call-3",
      arguments: PLAIN_ARGS,
    }];
    const before = clone(input);
    expect(stripToolCallCiphertextArgumentsInPlace(input)).toBe(0);
    expect(input).toEqual(before);
  });

  test("ignores non-function items", () => {
    const input = [
      { type: "message", role: "user", content: FERNET_TASK },
      { type: "custom_tool_call", name: "collab", call_id: "call-4", input: FERNET_TASK },
    ];
    const before = clone(input);
    expect(stripToolCallCiphertextArgumentsInPlace(input)).toBe(0);
    expect(input).toEqual(before);
  });

  test("repairs every poisoned call in a replayed history", () => {
    const history = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "派双审" }] },
      {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call-poisoned",
        arguments: JSON.stringify({ task_name: "v257_spec_review3", message: FERNET_TASK }),
      },
      {
        type: "function_call_output",
        call_id: "call-poisoned",
        output: "done",
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] },
    ];
    expect(stripToolCallCiphertextArgumentsInPlace(history)).toBe(1);
    expect(JSON.stringify(history)).not.toContain(FERNET_TASK);
    expect((history[1] as { arguments: string }).arguments)
      .toBe(JSON.stringify({ task_name: "v257_spec_review3", message: "[encrypted content omitted]" }));
  });
});

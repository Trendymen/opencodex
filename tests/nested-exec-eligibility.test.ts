import { describe, expect, test } from "bun:test";
import { carriesCodeModeNestedExecSurface } from "../src/chat/nested-exec-eligibility";

describe("nested exec Chat eligibility", () => {
  test("recognizes a structured exec declaration without inspecting its description", () => {
    expect(carriesCodeModeNestedExecSurface({
      model: "test",
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        type: "function",
        name: "exec",
        description: "ordinary tool description",
        parameters: { type: "object" },
      }],
    })).toBe(true);
  });

  test("does not reject a request with no structured exec declaration", () => {
    expect(carriesCodeModeNestedExecSurface({
      model: "test",
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        type: "function",
        name: "shell_command",
        description: "Run a local script.",
        parameters: { type: "object" },
      }],
    })).toBe(false);
  });
});

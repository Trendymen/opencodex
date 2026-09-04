import { describe, expect, test } from "bun:test";
import { carriesCodeModeNestedExecSurface } from "../src/chat/nested-exec-eligibility";

describe("nested exec Chat eligibility", () => {
  test("does not treat an ordinary Chat function named exec as Code Mode", () => {
    expect(carriesCodeModeNestedExecSurface({
      model: "test",
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        type: "function",
        name: "exec",
        parameters: { type: "object" },
      }],
    })).toBe(false);
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

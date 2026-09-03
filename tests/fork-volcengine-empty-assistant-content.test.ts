import { describe, expect, test } from "bun:test";
import { applyGlmKimiOutboundCompatibility } from "../src/fork/glm-kimi-compat";
import type { OcxProviderConfig } from "../src/types";

const ARK_PLAN_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";

function responsesProvider(baseUrl = ARK_PLAN_URL): OcxProviderConfig {
  return { adapter: "openai-responses", baseUrl } as OcxProviderConfig;
}

function apply(body: unknown, provider = responsesProvider()): unknown {
  return applyGlmKimiOutboundCompatibility({
    body,
    provider,
    modelId: "glm-5.3-flash",
  }).body;
}

describe("fork Volcengine Agent Plan empty assistant content compatibility", () => {
  test("removes an empty assistant message from the middle of replayed input", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "first request" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "second request" }] },
      ],
    };

    expect(apply(body)).toEqual({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "first request" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "second request" }] },
      ],
    });
  });

  test("removes an already-empty trailing assistant before trailing-user compatibility runs", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "first request" }] },
        { type: "message", role: "assistant", content: [] },
      ],
    };

    expect(apply(body)).toEqual({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "first request" }] },
      ],
    });
  });

  test("removes whitespace-only and non-string assistant text parts", () => {
    const body = {
      input: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: " \n\t " },
            { type: "input_text" },
          ],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    };

    expect(apply(body)).toEqual({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    });
  });

  test("treats a typeless assistant as a message and removes it when all text is empty", () => {
    const body = {
      input: [
        { role: "assistant", content: [{ type: "output_text", text: "" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    };

    expect(apply(body)).toEqual({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    });
  });

  test("keeps typeless assistant fields while removing only empty mixed text", () => {
    const body = {
      input: [
        {
          role: "assistant",
          phase: "commentary",
          content: [
            { type: "output_text", text: "" },
            { type: "output_text", text: "still useful" },
          ],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    };

    expect(apply(body)).toEqual({
      input: [
        {
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "still useful" }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    });
  });

  test("does not treat an explicit non-message item as a message even when it has assistant role", () => {
    const body = {
      input: [
        { type: "agent_message", role: "assistant", content: [{ type: "output_text", text: "" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    };

    expect(apply(body)).toBe(body);
  });

  test("keeps a mixed assistant message while dropping only its empty text part", () => {
    const body = {
      input: [
        {
          type: "message",
          role: "assistant",
          id: "msg_mixed",
          content: [
            { type: "output_text", text: "" },
            { type: "output_text", text: "use the mall category IDs" },
          ],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next request" }] },
      ],
    };

    expect(apply(body)).toEqual({
      input: [
        {
          type: "message",
          role: "assistant",
          id: "msg_mixed",
          content: [{ type: "output_text", text: "use the mall category IDs" }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next request" }] },
      ],
    });
  });

  test("keeps assistant messages that have another valid non-text content part", () => {
    const body = {
      input: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "" },
            { type: "refusal", refusal: "Cannot complete that request" },
          ],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next request" }] },
      ],
    };

    expect(apply(body)).toEqual({
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "Cannot complete that request" }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next request" }] },
      ],
    });
  });

  test("does not rewrite empty user content, tool items, or standard input", () => {
    const body = {
      input: [
        { type: "function_call_output", call_id: "call_1", output: "{}" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "" }] },
      ],
    };

    expect(apply(body)).toBe(body);
  });

  test("only rewrites the exact Volcengine Agent Plan Responses endpoint", () => {
    const body = {
      input: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next request" }] },
      ],
    };
    const providers = [
      responsesProvider("https://example.test/v1"),
      responsesProvider("https://ark.cn-beijing.volces.com/api/v3"),
      responsesProvider("https://open.bigmodel.cn/api/v1"),
      { adapter: "openai-chat", baseUrl: ARK_PLAN_URL } as OcxProviderConfig,
    ];

    for (const provider of providers) expect(apply(body, provider)).toBe(body);
  });

  test("leaves malformed body and input structures by identity", () => {
    for (const body of [null, {}, { input: {} }, { input: ["not an item"] }]) {
      expect(apply(body)).toBe(body);
    }
  });
});

/**
 * Routed Responses providers differ in how strictly they validate tool history.
 * Task-coordination deliveries can be persisted as function_call_output items
 * without a call_id; these tests require the outbound adapter to preserve their
 * evidence as user messages instead of forwarding an invalid tool-result shape.
 */
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import type { OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

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

function buildRawBody(
  rawBody: Record<string, unknown>,
  options: { provider?: OcxProviderConfig; compactionRequest?: boolean } = {},
): Record<string, unknown> {
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(options.provider ?? provider));
  const request = adapter.buildRequest({
    modelId: "glm-5.3-flash",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: rawBody,
    ...(options.compactionRequest ? { _compactionRequest: true } : {}),
  }, { headers: new Headers() });
  return JSON.parse(request.body) as Record<string, unknown>;
}

function singleCarrierText(body: Record<string, unknown>): string {
  const outbound = body.input as Array<Record<string, unknown>>;
  expect(outbound.some(item => (
    (item.type === "function_call_output" || item.type === "custom_tool_call_output")
    && (typeof item.call_id !== "string" || item.call_id.trim() === "")
  ))).toBe(false);
  const carriers = outbound.filter(item => {
    if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) return false;
    const first = item.content[0];
    return typeof first === "object" && first !== null
      && (first as Record<string, unknown>).type === "input_text"
      && String((first as Record<string, unknown>).text).startsWith(
        "[unlinked tool output from vision_result; original call_id missing]",
      );
  });
  expect(carriers).toHaveLength(1);
  const content = carriers[0]!.content as Array<Record<string, unknown>>;
  return String(content[0]!.text);
}

describe("Responses call-ID-less tool output repair", () => {
  test("converts call-ID-less task messages before a strict routed request", () => {
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

  for (const [label, callId] of [
    ["missing", undefined],
    ["non-string", 42],
    ["empty", ""],
    ["whitespace", "  \n"],
  ] as const) {
    test(`converts ${label} call ids on both tool-output kinds`, () => {
      const outbound = build([
        {
          type: "function_call_output",
          name: "fn",
          output: "function result",
          ...(callId === undefined ? {} : { call_id: callId }),
        },
        {
          type: "custom_tool_call_output",
          name: "custom",
          output: [{ type: "output_text", text: "custom result" }],
          ...(callId === undefined ? {} : { call_id: callId }),
        },
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

  test("preserves valid tool history and stateful top-level fields", () => {
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
  });

  test("uses an explicit fallback label when a malformed output has no tool name", () => {
    const outbound = build([
      { type: "function_call_output", output: "anonymous result" },
    ]).input as Array<Record<string, unknown>>;

    expect(outbound).toMatchObject([{ type: "message", role: "user" }]);
    expect(JSON.stringify(outbound[0])).toContain("unknown tool");
    expect(JSON.stringify(outbound[0])).toContain("anonymous result");
  });

  const imageOutput = {
    type: "function_call_output",
    name: "vision_result",
    output: {
      content: [
        { type: "input_text", text: "visible evidence" },
        { type: "input_image", image_url: "data:image/png;base64,PRIVATE" },
      ],
    },
  };

  test("ordinary turns keep the existing tool-output text conversion", () => {
    const carrierText = singleCarrierText(build([imageOutput]));

    expect(carrierText).toContain("visible evidence");
    expect(carrierText).toContain("input_image");
    expect(carrierText).not.toContain("[image omitted for compaction]");
  });

  test("routed compaction omits nested images before creating the text carrier", () => {
    const rawBody = { model: "glm-5.3-flash", input: [imageOutput], stream: true };
    const body = buildRawBody(rawBody, { compactionRequest: true });
    const outbound = body.input as Array<Record<string, unknown>>;
    const carrierText = singleCarrierText(body);

    expect(outbound).toHaveLength(2);
    expect(outbound[1]).toMatchObject({ type: "message", role: "user" });
    expect(carrierText).toContain("visible evidence");
    expect(carrierText).toContain("[image omitted for compaction]");
    expect(carrierText).not.toContain("input_image");
    expect(carrierText).not.toContain("base64,PRIVATE");
  });

  test("canonical private compact does not inherit routed image omission", () => {
    const canonical: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    };
    const rawBody = { model: "gpt-5.6-sol", input: [imageOutput], stream: true };
    const carrierText = singleCarrierText(buildRawBody(rawBody, {
      provider: canonical,
      compactionRequest: true,
    }));

    expect(carrierText).toContain("visible evidence");
    expect(carrierText).toContain("input_image");
    expect(carrierText).not.toContain("[image omitted for compaction]");
  });
});

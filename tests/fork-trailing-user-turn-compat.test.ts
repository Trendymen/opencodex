import { describe, expect, test } from "bun:test";
import { applyGlmKimiOutboundCompatibility } from "../src/fork/glm-kimi-compat";
import type { OcxProviderConfig } from "../src/types";

const ARK_PLAN_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
const ZHIPU_CODEX_URL = "https://open.bigmodel.cn/api/v1";

function responsesProvider(baseUrl: string, extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "openai-responses", baseUrl, ...extra } as OcxProviderConfig;
}

function assistantTailBody(): { input: Array<Record<string, unknown>> } {
  return { input: [{ type: "message", role: "assistant", content: "prefill" }] };
}

function appendedUserContinuation(result: { body: unknown }): boolean {
  const input = (result.body as { input: Array<Record<string, unknown>> }).input;
  const last = input[input.length - 1];
  return last?.type === "message"
    && last.role === "user"
    && JSON.stringify(last.content) === JSON.stringify([{ type: "input_text", text: "(continue)" }]);
}

describe("fork trailing-user-turn compatibility for prefill-restricted Responses destinations", () => {
  test("appends a user continuation for every third-party non-GPT model with an assistant tail", () => {
    const cases: Array<[OcxProviderConfig, string]> = [
      [responsesProvider(ARK_PLAN_URL), "glm-5.3"],
      [responsesProvider(ARK_PLAN_URL), "glm-5.3-flash"],
      [responsesProvider(ARK_PLAN_URL), "kimi-k3"],
      [responsesProvider(ZHIPU_CODEX_URL), "glm-5.3-flash"],
      [responsesProvider("https://example.test/v1"), "deepseek-v4-flash"],
      [responsesProvider("https://example.test/v1"), "glm-5.3-flash"],
    ];
    for (const [provider, modelId] of cases) {
      const result = applyGlmKimiOutboundCompatibility({ body: assistantTailBody(), provider, modelId });
      expect(appendedUserContinuation(result)).toBe(true);
    }
  });

  test("never appends for OpenAI-operated destinations", () => {
    const officialForward = responsesProvider("https://chatgpt.com/backend-api/codex", { authMode: "forward" });
    const officialApi = responsesProvider("https://api.openai.com/v1");
    for (const provider of [officialForward, officialApi]) {
      const body = assistantTailBody();
      const result = applyGlmKimiOutboundCompatibility({ body, provider, modelId: "glm-5.3" });
      expect(result.body).toBe(body);
      const input = (result.body as { input: Array<unknown> }).input;
      expect(input).toHaveLength(1);
    }
  });

  test("never appends for GPT-family models even on third-party destinations", () => {
    for (const modelId of ["gpt-5.1", "gpt-4o", "codex-mini", "chatgpt-4o-latest", "o3", "o3-mini", "o4-mini"]) {
      const result = applyGlmKimiOutboundCompatibility({
        body: assistantTailBody(),
        provider: responsesProvider("https://example.test/v1"),
        modelId,
      });
      expect((result.body as { input: Array<unknown> }).input).toHaveLength(1);
    }
  });

  test("leaves non-Responses adapters and non-assistant tails untouched", () => {
    const body = assistantTailBody();
    const chatAdapter = applyGlmKimiOutboundCompatibility({
      body,
      provider: { adapter: "openai-chat", baseUrl: ARK_PLAN_URL } as OcxProviderConfig,
      modelId: "glm-5.3-flash",
    });
    expect(chatAdapter.body).toBe(body);

    const userTail = { input: [{ type: "message", role: "user", content: "hi" }] };
    expect(applyGlmKimiOutboundCompatibility({
      body: userTail,
      provider: responsesProvider(ARK_PLAN_URL),
      modelId: "glm-5.3-flash",
    }).body).toBe(userTail);

    const toolCallTail = { input: [{ type: "function_call", name: "exec", call_id: "c1" }] };
    expect(applyGlmKimiOutboundCompatibility({
      body: toolCallTail,
      provider: responsesProvider(ARK_PLAN_URL),
      modelId: "glm-5.3-flash",
    }).body).toBe(toolCallTail);

    const empty = { input: [] };
    expect(applyGlmKimiOutboundCompatibility({
      body: empty,
      provider: responsesProvider(ARK_PLAN_URL),
      modelId: "glm-5.3-flash",
    }).body).toBe(empty);
  });
});

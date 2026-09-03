import { describe, expect, test } from "bun:test";
import { applyGlmKimiOutboundCompatibility, usesVolcengineAgentPlanResponses } from "../src/fork/glm-kimi-compat";
import type { OcxProviderConfig } from "../src/types";

const ARK_PLAN_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";

function arkProvider(): OcxProviderConfig {
  return { adapter: "openai-responses", baseUrl: ARK_PLAN_URL } as OcxProviderConfig;
}

describe("fork GLM/Kimi Responses compatibility", () => {
  test("identifies only the exact Ark Responses destination for fork defaults", () => {
    expect(usesVolcengineAgentPlanResponses(arkProvider())).toBe(true);
    expect(usesVolcengineAgentPlanResponses({ ...arkProvider(), baseUrl: "https://example.test/v3" })).toBe(false);
  });

  test("appends a user continuation for GLM-5.3 at the exact Ark plan endpoint and other third-party Responses destinations", () => {
    const result = applyGlmKimiOutboundCompatibility({
      body: { input: [{ type: "message", role: "assistant", content: "prefill" }] },
      provider: arkProvider(),
      modelId: "glm-5.3",
    });
    expect(result.body).toEqual({
      input: [
        { type: "message", role: "assistant", content: "prefill" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "(continue)" }] },
      ],
    });

    const appended = applyGlmKimiOutboundCompatibility({
      body: { input: [{ type: "message", role: "assistant", content: "prefill" }] },
      provider: { ...arkProvider(), baseUrl: "https://example.test/v3" },
      modelId: "glm-5.3",
    });
    expect((appended.body as { input: Array<{ role: string }> }).input).toHaveLength(2);
    expect((appended.body as { input: Array<{ role: string }> }).input[1]?.role).toBe("user");
  });
});

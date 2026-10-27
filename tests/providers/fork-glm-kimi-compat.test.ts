import { describe, expect, test } from "bun:test";
import { usesVolcengineAgentPlanResponses } from "../../src/fork/glm-kimi-compat";
import type { OcxProviderConfig } from "../../src/types";

const ARK_PLAN_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";

function arkProvider(): OcxProviderConfig {
  return { adapter: "openai-responses", baseUrl: ARK_PLAN_URL } as OcxProviderConfig;
}

describe("fork GLM/Kimi Responses compatibility", () => {
  test("identifies only the exact Ark Responses destination for fork defaults", () => {
    expect(usesVolcengineAgentPlanResponses(arkProvider())).toBe(true);
    expect(usesVolcengineAgentPlanResponses({ ...arkProvider(), baseUrl: "https://example.test/v3" })).toBe(false);
  });
});

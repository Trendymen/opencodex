import { describe, expect, test } from "bun:test";
import { applyGlmKimiOutboundCompatibility } from "../src/fork/glm-kimi-compat";
import type { OcxProviderConfig } from "../src/types";

const ZHIPU_CODEX_URL = "https://open.bigmodel.cn/api/v1";

function zhipuCodexProvider(): OcxProviderConfig {
  return { adapter: "openai-responses", baseUrl: ZHIPU_CODEX_URL } as OcxProviderConfig;
}

function automationTool(): Record<string, unknown> {
  return {
    type: "function",
    name: "mcp__codex_app__automation_update",
    description: "Create, update, view, or delete an automation",
    parameters: {
      $defs: {
        view: {
          type: "object",
          properties: {
            id: { type: "string" },
            mode: { const: "view" },
          },
          required: ["id", "mode"],
          additionalProperties: false,
        },
        update: {
          type: "object",
          properties: {
            id: { type: "string" },
            mode: { const: "update" },
            prompt: { type: "string" },
          },
          required: ["id", "mode", "prompt"],
          additionalProperties: false,
        },
      },
      oneOf: [
        { $ref: "#/$defs/view" },
        { $ref: "#/$defs/update" },
      ],
    },
  };
}

describe("Zhipu Codex GLM function-tool schema lowering", () => {
  test("lowers the complex automation schema only for GLM-5.3 models on the exact Responses destination", () => {
    for (const [baseUrl, modelId] of [
      [ZHIPU_CODEX_URL, "glm-5.3"],
      [`${ZHIPU_CODEX_URL}/`, "glm-5.3-flash"],
    ]) {
      const tools = [
        { type: "function", name: "simple", parameters: { type: "object", properties: { value: { type: "string" } } } },
        automationTool(),
      ];
      const body = { tools };
      const original = structuredClone(body);

      const result = applyGlmKimiOutboundCompatibility({
        body,
        provider: { ...zhipuCodexProvider(), baseUrl },
        modelId,
      });
      const loweredTools = (result.body as { tools: Array<Record<string, unknown>> }).tools;
      const lowered = loweredTools[1]?.parameters as Record<string, unknown>;
      const properties = lowered.properties as Record<string, Record<string, unknown>>;

      expect(body).toEqual(original);
      expect(result.body).not.toBe(body);
      expect(loweredTools).toHaveLength(2);
      expect(loweredTools[0]).toEqual(tools[0]);
      expect(loweredTools[1]?.name).toBe("mcp__codex_app__automation_update");
      expect(lowered.$defs).toBeUndefined();
      expect(lowered.oneOf).toBeUndefined();
      expect(lowered.required).toBeUndefined();
      expect(lowered.additionalProperties).toBe(true);
      expect(Object.keys(properties).sort()).toEqual(["id", "mode", "prompt"]);
      expect(properties.mode?.enum).toEqual(["view", "update"]);
    }
  });

  test("does not widen schema lowering to neighboring adapters, endpoints, or GLM models", () => {
    const body = { tools: [automationTool()] };
    const controls: Array<[OcxProviderConfig, string]> = [
      [{ ...zhipuCodexProvider(), adapter: "openai-chat" }, "glm-5.3-flash"],
      [{ ...zhipuCodexProvider(), baseUrl: "https://open.bigmodel.cn/api/paas/v4" }, "glm-5.3-flash"],
      [zhipuCodexProvider(), "glm-5.2"],
      [zhipuCodexProvider(), "kimi-k3"],
    ];

    for (const [provider, modelId] of controls) {
      expect(applyGlmKimiOutboundCompatibility({ body, provider, modelId }).body).toBe(body);
    }
  });

  test("lowers Responses Lite additional tools without changing the group or ordinary tools", () => {
    const simple = {
      type: "function",
      name: "simple",
      description: "ordinary schema",
      parameters: { type: "object", properties: { value: { type: "string" } } },
    };
    const automation = automationTool();
    const body = {
      input: [{
        type: "additional_tools",
        role: "developer",
        deferred: true,
        tools: [simple, automation],
      }],
    };
    const original = structuredClone(body);

    const result = applyGlmKimiOutboundCompatibility({
      body,
      provider: zhipuCodexProvider(),
      modelId: "glm-5.3-flash",
    });
    const item = (result.body as { input: Array<Record<string, unknown>> }).input[0]!;
    const tools = item.tools as Array<Record<string, unknown>>;
    const lowered = tools[1]?.parameters as Record<string, unknown>;

    expect(body).toEqual(original);
    expect(result.body).not.toBe(body);
    expect(item).toMatchObject({ type: "additional_tools", role: "developer", deferred: true });
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual(simple);
    expect(tools[1]?.name).toBe("mcp__codex_app__automation_update");
    expect(tools[1]?.description).toBe("Create, update, view, or delete an automation");
    expect(lowered.$defs).toBeUndefined();
    expect(lowered.oneOf).toBeUndefined();
    expect(Object.keys(lowered.properties as Record<string, unknown>).sort()).toEqual(["id", "mode", "prompt"]);
    expect(result.kimiToolSchemaLowering).toBeUndefined();
  });
});

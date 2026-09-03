import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyGlmKimiOutboundCompatibility,
  persistKimiToolSchemaCatalog,
} from "../src/fork/glm-kimi-compat";
import type { OcxProviderConfig } from "../src/types";

const ARK_PLAN_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";

function arkProvider(): OcxProviderConfig {
  return { adapter: "openai-responses", baseUrl: ARK_PLAN_URL } as OcxProviderConfig;
}

function functionTool(name: string, parameters: Record<string, unknown>): Record<string, unknown> {
  return { type: "function", name, description: `description:${name}`, parameters };
}

let previousHome: string | undefined;
let testHome = "";

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testHome = mkdtempSync(join(tmpdir(), "ocx-kimi-schema-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

describe("Agent Plan Kimi function-tool schema compiler", () => {
  test("lowers only the exact K3 destination while preserving metadata, visible properties, nested anyOf, and the original body", () => {
    const parameters = {
      type: "object",
      $defs: {
        entry: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      anyOf: [
        { $ref: "#/$defs/entry", description: "root-ref-branch" },
        { type: "object", properties: { alternate: { type: "boolean" } } },
      ],
      properties: {
        referenced: { $ref: "#/$defs/entry", description: "visible-ref-sibling" },
        nestedUnion: { anyOf: [{ type: "string" }, { type: "number" }] },
        scalarUnion: { oneOf: [{ const: "alpha" }, { const: "beta" }] },
        combined: {
          allOf: [
            { type: "object", properties: { left: { type: "string" } } },
            { type: "object", properties: { right: { type: "number" } } },
          ],
        },
      },
      required: ["referenced"],
      additionalProperties: false,
    };
    const body = { tools: [functionTool("complex_tool", parameters)] };
    const original = structuredClone(body);

    const result = applyGlmKimiOutboundCompatibility({
      body,
      provider: arkProvider(),
      modelId: "kimi-k3",
    });
    const loweredTool = (result.body as { tools: Array<Record<string, unknown>> }).tools[0]!;
    const lowered = loweredTool.parameters as Record<string, unknown>;
    const properties = lowered.properties as Record<string, Record<string, unknown>>;

    expect(body).toEqual(original);
    expect(result.body).not.toBe(body);
    expect(loweredTool.name).toBe("complex_tool");
    expect(loweredTool.description).toBe("description:complex_tool");
    expect(lowered.$defs).toBeUndefined();
    expect(lowered.anyOf).toBeUndefined();
    expect(lowered.required).toBeUndefined();
    expect(lowered.additionalProperties).toBe(true);
    expect(Object.keys(properties).sort()).toEqual([
      "alternate",
      "combined",
      "nestedUnion",
      "referenced",
      "scalarUnion",
      "value",
    ]);
    expect(properties.referenced?.description).toBe("visible-ref-sibling");
    expect(properties.referenced?.required).toBeUndefined();
    expect(properties.referenced?.additionalProperties).toBe(true);
    expect(properties.nestedUnion?.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
    expect(properties.scalarUnion?.enum).toEqual(["alpha", "beta"]);
    expect((properties.combined?.properties as Record<string, unknown>)).toEqual({
      left: { type: "string" },
      right: { type: "number" },
    });
    expect(result.kimiToolSchemaLowering?.tools).toEqual([{
      name: "complex_tool",
      originalBytes: Buffer.byteLength(JSON.stringify(parameters), "utf8"),
      loweredBytes: Buffer.byteLength(JSON.stringify(lowered), "utf8"),
    }]);

    for (const [provider, modelId] of [
      [{ ...arkProvider(), baseUrl: "https://example.test/api/plan/v3" }, "kimi-k3"],
      [{ ...arkProvider(), adapter: "openai-chat" }, "kimi-k3"],
      [arkProvider(), "glm-5.3"],
    ] as Array<[OcxProviderConfig, string]>) {
      const untouched = applyGlmKimiOutboundCompatibility({ body, provider, modelId });
      expect(untouched.body).toBe(body);
      expect(untouched.kimiToolSchemaLowering).toBeUndefined();
    }
  });

  test("keeps a complete 39-tool catalog and lowers only the schemas that need it", () => {
    const tools = Array.from({ length: 39 }, (_, index) => functionTool(
      `tool_${index}`,
      index === 38
        ? { anyOf: [
            { type: "object", properties: { query: { type: "string" } } },
            { type: "object", properties: { id: { type: "number" } } },
          ] }
        : { type: "object", properties: { value: { type: "string" } } },
    ));
    const body = { tools };

    const result = applyGlmKimiOutboundCompatibility({
      body,
      provider: arkProvider(),
      modelId: "kimi-k3",
    });
    const loweredTools = (result.body as { tools: Array<Record<string, unknown>> }).tools;

    expect(loweredTools).toHaveLength(39);
    expect(loweredTools.map(tool => tool.name)).toEqual(tools.map(tool => tool.name));
    expect(loweredTools.slice(0, 38)).toEqual(tools.slice(0, 38));
    expect(result.kimiToolSchemaLowering?.tools.map(tool => tool.name)).toEqual(["tool_38"]);
    expect(Object.keys((loweredTools[38]?.parameters as { properties: Record<string, unknown> }).properties).sort())
      .toEqual(["id", "query"]);
  });

  test("falls back atomically when depth or node budgets are exceeded", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 40; index += 1) deep = { oneOf: [deep] };
    const nodeHeavy = { oneOf: Array.from({ length: 4_100 }, (_, index) => ({ const: index })) };

    for (const parameters of [deep, nodeHeavy]) {
      const body = { tools: [functionTool("over_budget", parameters)] };
      const result = applyGlmKimiOutboundCompatibility({
        body,
        provider: arkProvider(),
        modelId: "kimi-k3",
      });
      expect(result.body).toBe(body);
      expect(result.kimiToolSchemaLowering).toBeUndefined();
    }
  });

  test("persists one bounded owner-only schema catalog without filtering tool entries", () => {
    const catalogDir = join(testHome, "kimi-tool-schema-catalogs");
    const tools = [
      functionTool(`first_${testHome.split("/").at(-1)}`, { type: "object", properties: { a: { type: "string" } } }),
      functionTool("second", { type: "object", properties: { b: { type: "number" } } }),
    ];

    persistKimiToolSchemaCatalog({
      body: { tools },
      provider: arkProvider(),
      modelId: "glm-5.3",
      url: `${ARK_PLAN_URL}/responses`,
    });
    expect(existsSync(catalogDir)).toBe(false);

    persistKimiToolSchemaCatalog({
      body: { tools },
      provider: arkProvider(),
      modelId: "kimi-k3",
      url: `${ARK_PLAN_URL}/responses`,
    });
    const files = readdirSync(catalogDir).filter(name => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const path = join(catalogDir, files[0]!);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(tools.map(tool => ({
      name: tool.name,
      parameters: tool.parameters,
    })));
    if (process.platform !== "win32") {
      expect(statSync(catalogDir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  test("oversized or unserializable diagnostic catalogs never write or affect a request", () => {
    const catalogDir = join(testHome, "kimi-tool-schema-catalogs");
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;

    expect(() => persistKimiToolSchemaCatalog({
      body: { tools: [functionTool("cyclic", cyclic)] },
      provider: arkProvider(),
      modelId: "kimi-k3",
      url: `${ARK_PLAN_URL}/responses`,
    })).not.toThrow();
    expect(existsSync(catalogDir)).toBe(false);

    persistKimiToolSchemaCatalog({
      body: { tools: [functionTool("oversized", {
        type: "object",
        description: "x".repeat(1024 * 1024 + 1),
      })] },
      provider: arkProvider(),
      modelId: "kimi-k3",
      url: `${ARK_PLAN_URL}/responses`,
    });
    expect(existsSync(catalogDir)).toBe(false);
  });

  test("rotates unique catalogs under one directory-wide byte budget", () => {
    const catalogDir = join(testHome, "kimi-tool-schema-catalogs");
    for (let index = 0; index < 6; index += 1) {
      persistKimiToolSchemaCatalog({
        body: { tools: [functionTool(`catalog_${index}_${testHome.split("/").at(-1)}`, {
          type: "object",
          description: `${index}:${"x".repeat(768 * 1024)}`,
        })] },
        provider: arkProvider(),
        modelId: "kimi-k3",
        url: `${ARK_PLAN_URL}/responses`,
      });
    }
    const files = readdirSync(catalogDir).filter(name => name.endsWith(".json"));
    const totalBytes = files.reduce((total, name) => total + statSync(join(catalogDir, name)).size, 0);
    expect(totalBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(files.length).toBeLessThan(6);
  });
});

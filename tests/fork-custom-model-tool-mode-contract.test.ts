import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleModels } from "../src/cli/models";
import { handleModelsRuntimeCommand } from "../src/cli/models-runtime";
import { exportModelsFromProxyRows } from "../src/cli/export-command";
import { buildClientConfig, type ExportClientId } from "../src/clients/config-export";
import { loadConfig, saveConfigPreservingClaudeCode } from "../src/config";
import { handleModelRoutes } from "../src/server/management/model-routes";
import { listManagementModelRows } from "../src/server/management/model-rows";
import { safeConfigDTO } from "../src/server/auth-cors";
import type { OcxConfig } from "../src/types";

const SECRET_KEYS = {
  apiKey: "must-not-leak",
  headers: { authorization: "must-not-leak" },
  futureOpaque: { keepInternally: true },
};

function custom(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "existing-uuid",
    provider: "deepseek",
    modelId: "deepseek-v4",
    displayName: "DeepSeek V4",
    codexToolMode: "shell",
    addedAt: "2026-09-01T00:00:00.000Z",
    ...SECRET_KEYS,
    ...overrides,
  };
}

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "deepseek",
    providers: {
      deepseek: {
        adapter: "openai-chat",
        baseUrl: "https://example.invalid/v1",
        liveModels: false,
        models: [],
      },
    },
    customModels: [custom() as any],
  } as OcxConfig;
}

describe("Fork custom model tool-mode management contract", () => {
  let fixture: OcxConfig;
  let persistCalls = 0;
  let convergeCalls = 0;

  beforeEach(() => {
    fixture = config();
    persistCalls = 0;
    convergeCalls = 0;
  });

  async function call(method: "GET" | "POST" | "PUT", body?: unknown, pathname = "/api/custom-models") {
    const url = new URL(`http://127.0.0.1:10199${pathname}`);
    const req = new Request(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return handleModelRoutes({
      req,
      url,
      config: fixture,
      deps: {
        saveConfigPreservingClaudeCode: () => { persistCalls += 1; },
      } as Parameters<typeof handleModelRoutes>[0]["deps"],
      convergeCodexCatalog: async () => {
        convergeCalls += 1;
        return { status: "committed", changed: false, degraded: false, notices: [] };
      },
      syncClaudeAgentDefsBestEffort: async () => {},
    });
  }

  test("GET projects known fields and stored tool mode without opaque keys", async () => {
    const response = await call("GET");
    expect(response?.status).toBe(200);
    const rows = await response!.json() as Array<Record<string, unknown>>;
    expect(rows).toEqual([{
      id: "existing-uuid",
      provider: "deepseek",
      modelId: "deepseek-v4",
      displayName: "DeepSeek V4",
      codexToolMode: "shell",
      addedAt: "2026-09-01T00:00:00.000Z",
    }]);
  });

  test("POST stores both enums, preserves omission, and rejects null or invalid before side effects", async () => {
    for (const [suffix, value] of [["code", "code_mode_only"], ["shell", "shell"], ["inherit", undefined]] as const) {
      fixture.customModels = [];
      persistCalls = 0;
      convergeCalls = 0;
      const created = await call("POST", {
        provider: "deepseek",
        modelId: `new-${suffix}`,
        ...(value === undefined ? {} : { codexToolMode: value }),
        ...SECRET_KEYS,
      });
      expect(created?.status).toBe(201);
      const response = await created!.json() as Record<string, unknown>;
      expect(response.codexToolMode).toBe(value);
      expect(response.apiKey).toBeUndefined();
      expect(response.headers).toBeUndefined();
      expect(response.futureOpaque).toBeUndefined();
      expect(fixture.customModels?.[0]?.codexToolMode).toBe(value);
      expect(persistCalls).toBe(1);
      expect(convergeCalls).toBe(1);
    }

    for (const value of [null, "invalid"]) {
      fixture.customModels = [];
      persistCalls = 0;
      convergeCalls = 0;
      const rejected = await call("POST", {
        provider: "deepseek",
        modelId: `rejected-${String(value)}`,
        codexToolMode: value,
      });
      expect(rejected?.status).toBe(400);
      expect(persistCalls).toBe(0);
      expect(convergeCalls).toBe(0);
      expect(fixture.customModels).toEqual([]);
    }
  });

  test("POST rejects malformed canonical fields without normalization or side effects", async () => {
    const invalidBodies = [
      { provider: 42, modelId: "new-model" },
      { provider: " deepseek", modelId: "new-model" },
      { provider: "deepseek", modelId: 42 },
      { provider: "deepseek", modelId: "" },
      { provider: "deepseek", modelId: " padded-model " },
      { provider: "deepseek", modelId: "new-model", displayName: 42 },
      { provider: "deepseek", modelId: "new-model", displayName: "" },
      { provider: "deepseek", modelId: "new-model", displayName: " padded " },
      { provider: "deepseek", modelId: "new-model", contextWindow: 1.5 },
      { provider: "deepseek", modelId: "new-model", contextWindow: 0 },
      { provider: "deepseek", modelId: "new-model", contextWindow: "128000" },
      { provider: "deepseek", modelId: "new-model", defaultReasoningEffort: null },
    ];
    for (const body of invalidBodies) {
      fixture.customModels = [];
      persistCalls = 0;
      convergeCalls = 0;
      const before = structuredClone(fixture.customModels);
      const response = await call("POST", body);
      expect(response?.status, JSON.stringify(body)).toBe(400);
      expect(fixture.customModels).toEqual(before);
      expect(persistCalls).toBe(0);
      expect(convergeCalls).toBe(0);
    }
  });

  test("PUT preserves omitted, sets enums, clears with null, and never leaks opaque keys", async () => {
    const preserved = await call("PUT", { displayName: "Renamed" }, "/api/custom-models/existing-uuid");
    expect((await preserved!.json() as Record<string, unknown>).codexToolMode).toBe("shell");

    const set = await call("PUT", { codexToolMode: "code_mode_only" }, "/api/custom-models/existing-uuid");
    expect((await set!.json() as Record<string, unknown>).codexToolMode).toBe("code_mode_only");
    expect(fixture.customModels?.[0]?.codexToolMode).toBe("code_mode_only");

    const cleared = await call("PUT", { codexToolMode: null }, "/api/custom-models/existing-uuid");
    const clearedBody = await cleared!.json() as Record<string, unknown>;
    expect(clearedBody.codexToolMode).toBeUndefined();
    expect(clearedBody.apiKey).toBeUndefined();
    expect(clearedBody.headers).toBeUndefined();
    expect(clearedBody.futureOpaque).toBeUndefined();
    expect(Object.hasOwn(fixture.customModels![0]!, "codexToolMode")).toBe(false);
    expect((fixture.customModels![0] as any).apiKey).toBe("must-not-leak");
    const reloaded = JSON.parse(JSON.stringify(fixture)) as OcxConfig;
    expect(Object.hasOwn(reloaded.customModels![0]!, "codexToolMode")).toBe(false);
  });

  test("PUT rejects invalid tool mode without persistence or convergence", async () => {
    const before = structuredClone(fixture.customModels);
    const response = await call("PUT", { codexToolMode: "invalid" }, "/api/custom-models/existing-uuid");
    expect(response?.status).toBe(400);
    expect(fixture.customModels).toEqual(before);
    expect(persistCalls).toBe(0);
    expect(convergeCalls).toBe(0);
  });

  test("PUT rejects malformed canonical fields before mutation and keeps explicit clears", async () => {
    for (const body of [
      { modelId: 42 },
      { modelId: "" },
      { modelId: " padded-model " },
      { displayName: 42 },
      { displayName: " padded " },
      { contextWindow: "128000" },
      { contextWindow: 1.5 },
      { contextWindow: 0 },
    ]) {
      fixture = config();
      persistCalls = 0;
      convergeCalls = 0;
      const before = structuredClone(fixture.customModels);
      const response = await call("PUT", body, "/api/custom-models/existing-uuid");
      expect(response?.status, JSON.stringify(body)).toBe(400);
      expect(fixture.customModels).toEqual(before);
      expect(persistCalls).toBe(0);
      expect(convergeCalls).toBe(0);
    }

    fixture = config();
    const clearedName = await call("PUT", { displayName: "" }, "/api/custom-models/existing-uuid");
    expect(clearedName?.status).toBe(200);
    expect(fixture.customModels?.[0]?.displayName).toBeUndefined();

    const clearedContext = await call("PUT", { contextWindow: null }, "/api/custom-models/existing-uuid");
    expect(clearedContext?.status).toBe(200);
    expect(fixture.customModels?.[0]?.contextWindow).toBeUndefined();
  });

  test("PUT allows metadata-only edits on a historical collision but rejects identity expansion", async () => {
    fixture.customModels = [
      custom({ id: "slash", modelId: "openai/gpt-5.5" }) as any,
      custom({ id: "hyphen", modelId: "openai-gpt-5.5" }) as any,
    ];
    const metadata = await call("PUT", { displayName: "Renamed" }, "/api/custom-models/slash");
    expect(metadata?.status).toBe(200);
    expect(fixture.customModels[0]?.displayName).toBe("Renamed");
    expect(fixture.customModels).toHaveLength(2);

    persistCalls = 0;
    convergeCalls = 0;
    const before = structuredClone(fixture.customModels);
    const collision = await call("PUT", { modelId: "openai-gpt-5.5" }, "/api/custom-models/slash");
    expect(collision?.status).toBe(409);
    expect(fixture.customModels).toEqual(before);
    expect(persistCalls).toBe(0);
    expect(convergeCalls).toBe(0);
  });

  test("/api/models custom rows expose stored mode without opaque keys", async () => {
    const row = (await listManagementModelRows(fixture)).find(item => item.custom === true);
    expect(row?.codexToolMode).toBe("shell");
    expect((row as Record<string, unknown>)?.apiKey).toBeUndefined();
    expect((row as Record<string, unknown>)?.headers).toBeUndefined();
  });

  test("safe config and client export sources remain outside the tool-mode contract", () => {
    const safe = JSON.stringify(safeConfigDTO(fixture));
    expect(safe).not.toContain("customModels");
    expect(safe).not.toContain("must-not-leak");
    const managementRows = [{
      provider: "deepseek",
      id: "deepseek-v4",
      namespaced: "deepseek/deepseek-v4",
      disabled: false,
      custom: true,
      customId: "existing-uuid",
      codexToolMode: "shell",
      ...SECRET_KEYS,
    }];
    const exportModels = exportModelsFromProxyRows(managementRows as any, fixture);
    expect(JSON.stringify(exportModels)).not.toContain("codexToolMode");
    expect(JSON.stringify(exportModels)).not.toContain("must-not-leak");
    for (const client of [
      "opencode", "pi", "omp", "hermes", "openclaw", "kimi",
      "gajae", "dsh", "mcode", "zcode", "prime", "aside",
    ] as ExportClientId[]) {
      const emitted = JSON.stringify(buildClientConfig(client, {
        baseUrl: "http://127.0.0.1:10100/v1",
        models: exportModels,
      }));
      expect(emitted).not.toContain("codexToolMode");
      expect(emitted).not.toContain("must-not-leak");
    }
  });

  test("PUT null persists as omission while opaque internal keys survive a real reload", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-tool-mode-reload-"));
    const previous = process.env.OPENCODEX_HOME;
    try {
      process.env.OPENCODEX_HOME = home;
      writeFileSync(join(home, "config.json"), JSON.stringify(config()));
      fixture = loadConfig();
      const url = new URL("http://127.0.0.1:10199/api/custom-models/existing-uuid");
      const response = await handleModelRoutes({
        req: new Request(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codexToolMode: null }),
        }),
        url,
        config: fixture,
        deps: { saveConfigPreservingClaudeCode } as Parameters<typeof handleModelRoutes>[0]["deps"],
        convergeCodexCatalog: async () => ({
          status: "committed", changed: false, degraded: false, notices: [],
        }),
        syncClaudeAgentDefsBestEffort: async () => {},
      });
      expect(response?.status).toBe(200);
      const body = await response!.json() as Record<string, unknown>;
      expect(body.codexToolMode).toBeUndefined();
      expect(body.futureOpaque).toBeUndefined();

      const reloaded = loadConfig().customModels![0] as any;
      expect(Object.hasOwn(reloaded, "codexToolMode")).toBe(false);
      expect(reloaded.apiKey).toBe("must-not-leak");
      expect(reloaded.headers).toEqual({ authorization: "must-not-leak" });
      expect(reloaded.futureOpaque).toEqual({ keepInternally: true });
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("/api/client-config excludes stored tool mode and opaque custom metadata", async () => {
    const response = await call("GET", undefined, "/api/client-config?client=opencode");
    expect(response?.status).toBe(200);
    const emitted = JSON.stringify(await response!.json());
    expect(emitted).not.toContain("codexToolMode");
    expect(emitted).not.toContain("must-not-leak");
    expect(emitted).not.toContain("futureOpaque");
  });
});

describe("Fork custom model tool-mode CLI contract", () => {
  let home = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-fork-custom-model-tool-mode-"));
    process.env.OPENCODEX_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: 0,
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://example.invalid/v1",
          liveModels: false,
          models: [],
        },
      },
    }));
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function saved(): Record<string, any> {
    return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  }

  test("offline add stores tool mode and list-custom JSON/text expose only known fields", async () => {
    await handleModels(["add", "deepseek", "m1", "--tool-mode", "shell"]);
    await handleModels([
      "add", "deepseek", "m2",
      "--tool-mode", "inherit",
      "--reasoning-efforts", "max,low,low",
    ]);
    const persisted = saved();
    const row = persisted.customModels[0];
    expect(row.codexToolMode).toBe("shell");
    expect(persisted.customModels[1].codexToolMode).toBeUndefined();
    expect(persisted.customModels[1].reasoningEfforts).toEqual(["low", "max"]);
    row.apiKey = "must-not-leak";
    row.headers = { authorization: "must-not-leak" };
    row.futureOpaque = true;
    writeFileSync(join(home, "config.json"), JSON.stringify(persisted));

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      await handleModels(["list-custom", "--json"]);
      await handleModels(["list-custom"]);
    } finally {
      console.log = original;
    }
    const output = lines.join("\n");
    expect(output).toContain('"codexToolMode": "shell"');
    expect(output).toContain("TOOL MODE");
    expect(output).toContain("shell");
    expect(output).toContain("inherit");
    expect(output).not.toContain("must-not-leak");
    expect(output).not.toContain("futureOpaque");
  });

  test("models live --json carries the stored projected mode without opaque keys", async () => {
    const rows = await listManagementModelRows(config());
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      expect(await handleModelsRuntimeCommand("live", ["--json"], {
        baseUrl: "http://127.0.0.1:1",
        fetchImpl: async () => Response.json(rows),
      })).toBe(0);
    } finally {
      console.log = original;
    }
    const output = lines.join("\n");
    expect(output).toContain('"codexToolMode": "shell"');
    expect(output).not.toContain("must-not-leak");
    expect(output).not.toContain("futureOpaque");
  });

  test("live edit maps inherit to null and enums to stored strings", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    };
    expect(await handleModelsRuntimeCommand("edit", ["cm-1", "--tool-mode", "inherit"], {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl,
    })).toBe(0);
    expect(await handleModelsRuntimeCommand("edit", ["cm-1", "--tool-mode", "code_mode_only"], {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl,
    })).toBe(0);
    expect(bodies).toEqual([{ codexToolMode: null }, { codexToolMode: "code_mode_only" }]);
  });
});

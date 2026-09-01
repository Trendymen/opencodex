import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armClaudeCodeBaseline,
  getConfigPath,
  loadConfig,
  readConfigDiagnostics,
  saveConfigPreservingClaudeCode,
  validateConfigCandidate,
} from "../src/config";
import {
  customModelsCandidateError,
  knownCustomModelProjection,
  salvageCustomModelsForLoad,
} from "../src/config/custom-models";
import type { OcxConfig, OcxCustomModel } from "../src/types";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-fork-custom-model-config-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  home = "";
});

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "custom-1",
    provider: "test",
    modelId: "model-1",
    addedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function baseConfig(customModels: unknown): Record<string, unknown> {
  return {
    port: 10100,
    hostname: "0.0.0.0",
    unauthenticatedLoopbackListener: { enabled: true, port: 10200 },
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://provider.example/v1",
        apiKey: "upstream-secret",
      },
    },
    apiKeys: [{
      id: "key-1",
      name: "default",
      key: "ocx_persisted",
      createdAt: "2026-09-01T00:00:00.000Z",
    }],
    codexAccounts: [{ id: "account-1", email: "owner@example.test", isMain: true }],
    customModels,
  };
}

function writeConfig(value: unknown): string {
  const text = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(getConfigPath(), text, "utf8");
  return text;
}

function diskConfig(): Record<string, any> {
  return JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, any>;
}

describe("Fork customModels load salvage", () => {
  test("degrades a non-array field without affecting the rest of config", () => {
    const result = salvageCustomModelsForLoad("bad");
    expect(result).toMatchObject({ value: undefined, changed: true, droppedRows: 1 });
  });

  test("canonicalizes valid rows and omits invalid optional fields", () => {
    const result = salvageCustomModelsForLoad([model({
      id: " custom-1 ",
      provider: " test ",
      modelId: " model-1 ",
      displayName: "bad/name",
      contextWindow: 1.5,
      inputModalities: ["image", "bad", "image", "text"],
      reasoningEfforts: ["high", "low", "high", "bad"],
      defaultReasoningEffort: "high",
      codexToolMode: "bad",
      futureOpaque: { keep: true },
    })]);

    expect(result.value).toEqual([{
      id: "custom-1",
      provider: "test",
      modelId: "model-1",
      inputModalities: ["image", "text"],
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
      addedAt: "2026-09-01T00:00:00.000Z",
      futureOpaque: { keep: true },
    }]);
    expect(result.changed).toBe(true);
  });

  test("drops duplicate stable ids but preserves distinct routed-identity collisions", () => {
    const first = model();
    const duplicateId = model({ modelId: "other" });
    const duplicateSlug = model({ id: "custom-2" });
    const unique = model({ id: "custom-3", modelId: "model-3" });
    expect(salvageCustomModelsForLoad([first, duplicateId, duplicateSlug, unique]).value)
      .toEqual([first, duplicateSlug, unique]);
    expect(customModelsCandidateError([first, duplicateSlug])).toContain("duplicate");
  });

  test("preserves explicit empty reasoning and drops an invalid default", () => {
    expect(salvageCustomModelsForLoad([model({
      reasoningEfforts: [],
      defaultReasoningEffort: "high",
    })]).value?.[0]).toMatchObject({ reasoningEfforts: [] });
    expect(salvageCustomModelsForLoad([model({
      reasoningEfforts: [],
      defaultReasoningEffort: "high",
    })]).value?.[0]?.defaultReasoningEffort).toBeUndefined();
  });

  test("strict candidates reject malformed fields, null tool mode, and duplicates", () => {
    expect(customModelsCandidateError([model({ codexToolMode: null })])).toContain("codexToolMode");
    expect(customModelsCandidateError([model(), model({ id: "custom-2" })])).toContain("duplicate");
    expect(customModelsCandidateError([model({ reasoningEfforts: ["bad"] })])).toContain("reasoningEfforts");
  });

  test("public projection keeps only known custom-model fields", () => {
    const projected = knownCustomModelProjection(model({
      codexToolMode: "shell",
      apiKey: "must-not-leak",
      headers: { authorization: "must-not-leak" },
      futureOpaque: true,
    }) as unknown as OcxCustomModel);
    expect(projected).toEqual({
      id: "custom-1",
      provider: "test",
      modelId: "model-1",
      codexToolMode: "shell",
      addedAt: "2026-09-01T00:00:00.000Z",
    });
  });
});

describe("Fork customModels config integration", () => {
  test("load is write-free, salvages rows, warns once, and preserves unrelated state", () => {
    const original = writeConfig(baseConfig([
      "bad-row",
      model({ reasoningEfforts: ["high", "low", "high"] }),
      model({ id: "custom-2", modelId: "model-1" }),
    ]));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = loadConfig();
      expect(readFileSync(getConfigPath(), "utf8")).toBe(original);
      expect(loaded.customModels).toEqual([{
        id: "custom-1",
        provider: "test",
        modelId: "model-1",
        reasoningEfforts: ["low", "high"],
        addedAt: "2026-09-01T00:00:00.000Z",
      }, {
        id: "custom-2",
        provider: "test",
        modelId: "model-1",
        addedAt: "2026-09-01T00:00:00.000Z",
      }]);
      expect(loaded.providers.test?.baseUrl).toBe("https://provider.example/v1");
      expect(loaded.apiKeys?.[0]?.id).toBe("key-1");
      expect(loaded.codexAccounts?.[0]?.id).toBe("account-1");
      expect(loaded.port).toBe(10100);
      expect(loaded.hostname).toBe("0.0.0.0");
      expect(loaded.unauthenticatedLoopbackListener).toEqual({ enabled: true, port: 10200 });
      const customWarnings = warn.mock.calls.flat().filter(value => String(value).includes("customModels"));
      expect(customWarnings).toHaveLength(1);
      expect(customWarnings.join(" ")).not.toContain("custom-1");
      expect(customWarnings.join(" ")).not.toContain("model-1");
    } finally {
      warn.mockRestore();
    }
  });

  test("strict whole-config validation fails without mutating unrelated state", () => {
    const candidate = baseConfig([model({ codexToolMode: null })]);
    const before = structuredClone(candidate);
    const result = validateConfigCandidate(candidate);
    expect(result.ok).toBe(false);
    expect(candidate).toEqual(before);
    if (!result.ok) expect(result.error).toContain("customModels");
  });

  test("strict validation rejects invalid, missing, and encoded-colliding providers", () => {
    for (const customModels of [
      [model({ provider: "bad/name" })],
      [model({ provider: "missing" })],
    ]) {
      const result = validateConfigCandidate(baseConfig(customModels));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("customModels");
    }

    const collision = baseConfig([model({ modelId: "a/b" })]);
    (collision.providers as Record<string, any>).test.models = ["a-b"];
    const result = validateConfigCandidate(collision);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ambiguous");
  });

  test("strict validation never throws for malformed referenced provider rows", () => {
    for (const provider of [null, 1, [], { models: 1 }, { models: [1] }, { defaultModel: 1 }]) {
      const candidate = baseConfig([model()]);
      (candidate.providers as Record<string, unknown>).test = provider;
      expect(() => validateConfigCandidate(candidate)).not.toThrow();
      expect(validateConfigCandidate(candidate).ok).toBe(false);
    }
  });

  test("registry collision uses the same static ownership guard as routing", () => {
    const canonical = baseConfig([model({
      provider: "openrouter",
      modelId: "anthropic-claude-sonnet-5",
    })]);
    canonical.defaultProvider = "openrouter";
    canonical.providers = {
      openrouter: {
        adapter: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
      },
    };
    const collision = validateConfigCandidate(canonical);
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.error).toContain("ambiguous");

    const operatorOwned = baseConfig([model({
      provider: "mimo-free",
      modelId: "mimo/auto",
    })]);
    operatorOwned.defaultProvider = "mimo-free";
    operatorOwned.providers = {
      "mimo-free": {
        adapter: "openai-chat",
        baseUrl: "https://operator.example/v1",
      },
    };
    expect(validateConfigCandidate(operatorOwned).ok).toBe(true);
  });

  test("composite section salvage reports one custom-model warning in load and diagnostics", () => {
    const config = baseConfig(["bad", model()]);
    config.routingProfiles = {
      bad: { candidates: [{ provider: "missing", model: "m" }] },
    };
    writeConfig(config);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(loadConfig().customModels).toEqual([model()]);
      const warnings = warn.mock.calls.flat().map(String).filter(value => value.includes("customModels"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain("custom-1");
      expect(warnings[0]).not.toContain("model-1");

      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.config.customModels).toEqual([model()]);
      expect(diagnostics.warnings?.filter(value => value.includes("customModels"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test("guarded save preserves later disk edits and produces a stable reload", () => {
    writeConfig(baseConfig([model()]));
    const live = loadConfig();
    armClaudeCodeBaseline(live);

    const later = diskConfig();
    later.providers.test.baseUrl = "https://later.example/v1";
    later.codexAccounts[0].email = "later@example.test";
    later.unauthenticatedLoopbackListener = { enabled: true, port: 10300 };
    writeConfig(later);

    live.customModels![0]!.displayName = "Live model";
    saveConfigPreservingClaudeCode(live);

    const persisted = diskConfig();
    expect(persisted.providers.test.baseUrl).toBe("https://later.example/v1");
    expect(persisted.codexAccounts[0].email).toBe("later@example.test");
    expect(persisted.unauthenticatedLoopbackListener).toEqual({ enabled: true, port: 10300 });
    expect(persisted.customModels[0].displayName).toBe("Live model");
    expect(loadConfig().customModels).toEqual(persisted.customModels);
  });

  test("guarded unrelated save and reload preserve every historical routed collision member", () => {
    const slash = model({ id: "slash", modelId: "openai/gpt-5.5" });
    const hyphen = model({ id: "hyphen", modelId: "openai-gpt-5.5" });
    writeConfig(baseConfig([slash, hyphen]));
    const live = loadConfig();
    expect(live.customModels).toEqual([slash, hyphen]);
    armClaudeCodeBaseline(live);

    live.customModels![0]!.displayName = "Slash row";
    saveConfigPreservingClaudeCode(live);

    expect(diskConfig().customModels).toEqual([
      { ...slash, displayName: "Slash row" },
      hyphen,
    ]);
    expect(loadConfig().customModels).toEqual([
      { ...slash, displayName: "Slash row" },
      hyphen,
    ]);
  });

  test("diagnostics expose the same salvaged projection", () => {
    writeConfig(baseConfig(["bad", model()]));
    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.config.customModels).toEqual([model()]);
    expect(diagnostics.warnings?.filter(warning => warning.includes("customModels"))).toHaveLength(1);
  });
});

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { armClaudeCodeBaseline } from "../../src/config/live-reconcile";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test.each([
  { name: "provider toggle", body: { provider: "alpha", enabled: false } },
  { name: "global value", body: { value: 600_000, setAll: true } },
  { name: "all-provider toggle", body: { setAll: false } },
])("$name save failure restores live caps and does not leak into a later save", async ({ body }) => {
  const home = mkdtempSync(join(tmpdir(), "ocx-context-cap-rollback-"));
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    const live: OcxConfig = {
      port: 0,
      defaultProvider: "alpha",
      contextCapValue: 350_000,
      providers: { alpha: { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", liveModels: false } },
      providerContextCaps: { alpha: 128_000 },
    };
    saveConfig(live);
    const before = structuredClone(live);
    const configPath = join(home, "config.json");
    const bytes = readFileSync(configPath, "utf8");
    const url = new URL("http://localhost/api/provider-context-caps");
    await expect(handleManagementAPI(new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), url, live, {
      createManagementConvergeCodex: catalogConvergenceFactory(),
      saveConfigPreservingClaudeCode: () => { throw new Error("disk full"); },
    })).rejects.toThrow("disk full");
    expect(live).toEqual(before);
    expect(readFileSync(configPath, "utf8")).toBe(bytes);

    saveConfig(live);
    const persisted = loadConfig();
    expect(persisted.contextCapValue).toBe(350_000);
    expect(persisted.providerContextCaps).toEqual({ alpha: 128_000 });
    expect(persisted.providerContextCapValues).toBeUndefined();
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});

test("failed rebased save keeps the live cap map identity and values", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-context-cap-rebase-failure-"));
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    const live: OcxConfig = {
      port: 0,
      defaultProvider: "alpha",
      contextCapValue: 350_000,
      providers: { alpha: { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", liveModels: false } },
      providerContextCaps: { alpha: 128_000 },
    };
    saveConfig(live);
    armClaudeCodeBaseline(live);
    const external = loadConfig();
    external.providerContextCaps = { alpha: 256_000 };
    saveConfig(external);
    const bytes = readFileSync(join(home, "config.json"), "utf8");
    const originalCaps = live.providerContextCaps;
    Object.assign(live.providers.alpha!, { agentMessageFormat: "unsupported" });
    const url = new URL("http://localhost/api/provider-context-caps");
    await expect(handleManagementAPI(new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 600_000 }),
    }), url, live, { createManagementConvergeCodex: catalogConvergenceFactory() }))
      .rejects.toThrow("agentMessageFormat");
    expect(live.contextCapValue).toBe(350_000);
    expect(live.providerContextCaps).toBe(originalCaps);
    expect(live.providerContextCaps).toEqual({ alpha: 128_000 });
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(bytes);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});

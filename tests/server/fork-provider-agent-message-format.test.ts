import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig, saveConfig, validateConfigCandidate } from "../../src/config";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { providerEditorConfigDTO, providerManagementConfigError } from "../../src/server/auth-cors";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let directory: string;
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;

function fixture(): OcxConfig {
  return {
    ...getDefaultConfig(),
    defaultProvider: "alpha",
    providers: {
      alpha: { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", apiKey: "fixture-private-key" },
    },
  };
}

function context(config: OcxConfig, path: string, method: string, body?: unknown): ManagementContext {
  const url = new URL(`http://localhost${path}`);
  return {
    url,
    config,
    version: "fixture",
    req: new ManagementRequest(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    deps: { clearThreadAccountMap: () => {}, clearProviderQuotaCache: () => {} },
    convergeCodexCatalog: mock(async () => ({ status: "committed", changed: false, degraded: false, notices: [] } as const)),
    syncClaudeAgentDefsBestEffort: mock(async () => {}),
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  directory = mkdtempSync(join(tmpdir(), "ocx-agent-message-format-"));
  process.env.OPENCODEX_HOME = directory;
  codexHome = installIsolatedCodexHome("ocx-agent-message-format-codex-");
  saveConfig(fixture());
});

afterEach(() => {
  codexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(directory);
});

describe("provider agentMessageFormat config", () => {
  test("schema and direct writers preserve declared values and reject every other value", () => {
    const legal = fixture();
    Reflect.set(legal.providers.alpha!, "agentMessageFormat", "preserve");
    expect(validateConfigCandidate(legal)).toMatchObject({ ok: true });
    saveConfig(legal);
    expect(Reflect.get(loadConfig().providers.alpha!, "agentMessageFormat")).toBe("preserve");
    expect(Reflect.get(providerEditorConfigDTO(loadConfig()).providers.alpha!, "agentMessageFormat")).toBe("preserve");

    const invalid = loadConfig();
    Reflect.set(invalid.providers.alpha!, "agentMessageFormat", "rewrite");
    const diskBefore = readFileSync(getConfigPath(), "utf8");
    expect(validateConfigCandidate(invalid).ok).toBe(false);
    expect(() => saveConfig(invalid)).toThrow();
    expect(readFileSync(getConfigPath(), "utf8")).toBe(diskBefore);
    expect(providerManagementConfigError("alpha", {
      adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", agentMessageFormat: "rewrite",
    })).toBe("provider alpha agentMessageFormat must be preserve or user_message");
  });

  test("GET, POST and PATCH preserve the latest enum, override explicitly, and clear only through PATCH", async () => {
    const config = loadConfig();
    Reflect.set(config.providers.alpha!, "agentMessageFormat", "preserve");
    saveConfig(config);
    let releaseDns: (() => void) | undefined;
    let markDnsStarted: (() => void) | undefined;
    let dnsCalls = 0;
    const dnsStarted = new Promise<void>(resolve => { markDnsStarted = resolve; });
    const dns = spyOn(destinationPolicy, "providerDestinationResolvedError").mockImplementation(async () => {
      dnsCalls++;
      if (dnsCalls > 1) return null;
      markDnsStarted!();
      await new Promise<void>(resolve => { releaseDns = resolve; });
      return null;
    });
    try {
      const omittedPost = handleProviderRoutes(context(config, "/api/providers", "POST", {
        name: "alpha",
        provider: { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1" },
      }));
      await dnsStarted;
      const patch = await handleProviderRoutes(context(config, "/api/providers?name=alpha", "PATCH", {
        agentMessageFormat: "user_message",
      }));
      expect(patch?.status).toBe(200);
      releaseDns!();
      expect((await omittedPost)?.status).toBe(200);
      expect(Reflect.get(config.providers.alpha!, "agentMessageFormat")).toBe("user_message");

      const explicitPost = await handleProviderRoutes(context(config, "/api/providers", "POST", {
        name: "alpha",
        provider: {
          adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", agentMessageFormat: "preserve",
        },
      }));
      expect(explicitPost?.status).toBe(200);
      const get = await handleProviderRoutes(context(config, "/api/providers", "GET"));
      expect((await get!.json() as Array<{ name: string; agentMessageFormat?: string }>)
        .find(provider => provider.name === "alpha")?.agentMessageFormat).toBe("preserve");

      const clear = await handleProviderRoutes(context(config, "/api/providers?name=alpha", "PATCH", {
        agentMessageFormat: null,
      }));
      expect(clear?.status).toBe(200);
      expect(config.providers.alpha).not.toHaveProperty("agentMessageFormat");
      expect(loadConfig().providers.alpha).not.toHaveProperty("agentMessageFormat");

      const diskBeforeNullPost = readFileSync(getConfigPath(), "utf8");
      const nullPost = await handleProviderRoutes(context(config, "/api/providers", "POST", {
        name: "alpha",
        provider: { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", agentMessageFormat: null },
      }));
      expect(nullPost?.status).toBe(400);
      expect(config.providers.alpha).not.toHaveProperty("agentMessageFormat");
      expect(readFileSync(getConfigPath(), "utf8")).toBe(diskBeforeNullPost);
    } finally {
      dns.mockRestore();
    }
  });
});

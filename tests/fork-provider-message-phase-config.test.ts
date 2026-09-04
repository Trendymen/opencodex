import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { managementFetch as fetch, ManagementRequest as Request } from "./helpers/management-auth";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { getTrackedCodexWebSocketCountForAccount } from "../src/codex/websocket-registry";
import { clearAccountNeedsReauth, clearAccountQuota, getAccountQuota, isAccountNeedsReauth, markAccountNeedsReauth, updateAccountQuota } from "../src/codex/auth-api";
import {
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import { loadConfig, saveConfig } from "../src/config";
import { deriveProviderPresets } from "../src/providers/derive";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import {
  assertServerAuthConfig,
  corsHeaders,
  disableResponsesRequestTimeout,
  hasValidApiAuth,
  isApiAuthRequired,
  isLoopbackHostname,
  resolveGuiFilePath,
  rootFallbackPayload,
  safeConfigDTO,
  startServer,
} from "../src/server";
import { handleManagementAPI } from "../src/server/management-api";
import { providerManagementConfigError } from "../src/server/auth-cors";
import { providerServiceTierConfigError, withProviderServiceTierDTO } from "../src/server/management/provider-capability-config";
import { clearModelCache, markProviderDiscoveryFailed } from "../src/codex/model-cache";
import type { OcxConfig } from "../src/types";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import * as destinationPolicy from "../src/lib/destination-policy";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";
import { LOCAL_PROVIDER_RELOAD_NAME_HEADER, LOCAL_PROVIDER_RELOAD_PATH } from "../src/lib/local-provider-reload-contract";
import { getAccountSet, saveCredential } from "../src/oauth/store";
import { fastPolicyForModel } from "../src/providers/service-tier";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";

// Full-suite Windows load: startServer + multi-step provider PATCH/GET flows exceed the
// default 5s per-test budget (same flake class as 810fa115 / claude-management-api).
setDefaultTimeout(60_000);

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const originalGlobalFetch = globalThis.fetch;
// A per-run directory, not a fixed path. The 665b65643 split copied server-auth.test.ts's
// ".tmp-server-auth-test" literal verbatim, so both files deleted and recreated the same
// directory while pointing OPENCODEX_HOME at it. See the comment in server-auth.test.ts for
// the full failure mode; mkdtempSync also covers two concurrent runs of this file alone.
const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-fork-provider-message-phase-"));
let isolatedCodexHome: IsolatedCodexHome | null = null;

function config(hostname?: string): OcxConfig {
  return {
    port: 10100,
    hostname,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        headers: { "X-Custom": "provider-secret" },
        defaultModel: "gpt-test",
      },
    },
  };
}

const canonicalDirect = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  codexAccountMode: "direct",
} as const;

function poolProviders(): OcxConfig["providers"] {
  return {
    openai: { ...canonicalDirect, codexAccountMode: "pool" },
  };
}

function redirectCanonicalCodexTo(baseUrl: string): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const prefix = "/backend-api/codex";
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
      const target = new URL(`${url.pathname.slice(prefix.length)}${url.search}`, baseUrl);
      return originalGlobalFetch(target, init);
    }
    return originalGlobalFetch(input, init);
  }) as typeof fetch;
}

function stubModelDiscoveryFor(...origins: string[]): void {
  const allowed = new Set(origins);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (allowed.has(url.origin) && url.pathname.endsWith("/models")) {
      return Promise.resolve(Response.json({ data: [] }));
    }
    return originalGlobalFetch(input, init);
  }) as typeof fetch;
}

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-auth-codex-");
});

afterEach(() => {
  globalThis.fetch = originalGlobalFetch;
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("fork provider message phase config", () => {
  test("provider management validates message phase inference model ids", () => {
    const base = { adapter: "openai-responses", baseUrl: "https://api.example.test/v1" };
    expect(providerManagementConfigError("custom", {
      ...base,
      inferResponsesMessagePhaseModels: ["glm-5.3", "kimi-k3"],
    })).toBeNull();
    expect(providerManagementConfigError("custom", {
      ...base,
      inferResponsesMessagePhaseModels: ["   "],
    })).toContain("inferResponsesMessagePhaseModels");

    const dto = safeConfigDTO({
      port: 10100,
      defaultProvider: "custom",
      providers: {
        custom: { ...base, inferResponsesMessagePhaseModels: ["glm-5.3", "kimi-k3"] },
      },
    } as OcxConfig) as { providers: Record<string, { inferResponsesMessagePhaseModels?: string[] }> };
    expect(dto.providers.custom?.inferResponsesMessagePhaseModels).toEqual(["glm-5.3", "kimi-k3"]);
  });

  test("provider PATCH persists and clears message phase inference models", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      const createRes = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "phase-toggle",
          provider: {
            adapter: "openai-responses",
            baseUrl: "https://relay.example/v1",
            liveModels: false,
            models: ["glm-5.3", "kimi-k3"],
            inferResponsesMessagePhaseModels: [" glm-5.3 ", "glm-5.3", "kimi-k3"],
          },
        }),
      });
      expect(createRes.status).toBe(200);

      const afterCreate = await fetch(new URL("/api/providers", server.url)).then(response => response.json()) as Array<{
        name: string;
        inferResponsesMessagePhaseModels?: string[];
      }>;
      expect(afterCreate.find(provider => provider.name === "phase-toggle")?.inferResponsesMessagePhaseModels)
        .toEqual(["glm-5.3", "kimi-k3"]);

      const invalid = await fetch(new URL("/api/providers?name=phase-toggle", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inferResponsesMessagePhaseModels: [" "] }),
      });
      expect(invalid.status).toBe(400);

      const patchRes = await fetch(new URL("/api/providers?name=phase-toggle", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inferResponsesMessagePhaseModels: [" glm-5.3 ", "glm-5.3", "kimi-k3"] }),
      });
      expect(patchRes.status).toBe(200);

      const providers = await fetch(new URL("/api/providers", server.url)).then(response => response.json()) as Array<{
        name: string;
        inferResponsesMessagePhaseModels?: string[];
      }>;
      expect(providers.find(provider => provider.name === "phase-toggle")?.inferResponsesMessagePhaseModels)
        .toEqual(["glm-5.3", "kimi-k3"]);

      const clearRes = await fetch(new URL("/api/providers?name=phase-toggle", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inferResponsesMessagePhaseModels: null }),
      });
      expect(clearRes.status).toBe(200);

      const saved = await fetch(new URL("/api/config", server.url)).then(response => response.json()) as {
        providers: Record<string, { inferResponsesMessagePhaseModels?: string[] }>;
      };
      expect(saved.providers["phase-toggle"].inferResponsesMessagePhaseModels).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("provider POST preserves omitted message phase inference models during dashboard overwrite", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const seeded = config("127.0.0.1");
    seeded.providers["phase-preserve"] = {
      adapter: "openai-responses",
      baseUrl: "https://relay.example/v1",
      liveModels: false,
      models: ["glm-5.3", "kimi-k3"],
      inferResponsesMessagePhaseModels: ["glm-5.3", "kimi-k3"],
    };
    saveConfig(seeded);

    const server = startServer(0);
    try {
      const overwriteRes = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "phase-preserve",
          provider: {
            adapter: "openai-responses",
            baseUrl: "https://relay.example/v1",
            liveModels: false,
            models: ["glm-5.3", "kimi-k3"],
          },
        }),
      });
      expect(overwriteRes.status).toBe(200);

      const providers = await fetch(new URL("/api/providers", server.url)).then(response => response.json()) as Array<{
        name: string;
        inferResponsesMessagePhaseModels?: string[];
      }>;
      expect(providers.find(provider => provider.name === "phase-preserve")?.inferResponsesMessagePhaseModels)
        .toEqual(["glm-5.3", "kimi-k3"]);

      expect(loadConfig().providers["phase-preserve"]?.inferResponsesMessagePhaseModels)
        .toEqual(["glm-5.3", "kimi-k3"]);
    } finally {
      await server.stop(true);
    }
  });

  test("provider POST replay keeps a message phase inference clear committed during DNS validation", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const seeded = config("127.0.0.1");
    seeded.providers["phase-race"] = {
      adapter: "openai-responses",
      baseUrl: "https://relay.example/v1",
      liveModels: false,
      models: ["glm-5.3", "kimi-k3"],
      inferResponsesMessagePhaseModels: ["glm-5.3", "kimi-k3"],
    };
    saveConfig(seeded);

    let releaseDns!: () => void;
    const dnsResume = new Promise<void>(resolve => { releaseDns = resolve; });
    let markDnsEntered!: () => void;
    const dnsEntered = new Promise<void>(resolve => { markDnsEntered = resolve; });
    let pauseFirstPhaseRaceProbe = true;
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError")
      .mockImplementation(async name => {
        if (name === "phase-race" && pauseFirstPhaseRaceProbe) {
          pauseFirstPhaseRaceProbe = false;
          markDnsEntered();
          await dnsResume;
        }
        return null;
      });

    const managementDeps = { createManagementConvergeCodex: catalogConvergenceFactory() };
    try {
      const postUrl = new URL("http://127.0.0.1/api/providers");
      const pendingPost = handleManagementAPI(new Request(postUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "phase-race",
          provider: {
            adapter: "openai-responses",
            baseUrl: "https://relay.example/v1",
            liveModels: false,
            models: ["glm-5.3", "kimi-k3"],
          },
        }),
      }), postUrl, seeded, managementDeps);
      await dnsEntered;

      const patchUrl = new URL("http://127.0.0.1/api/providers?name=phase-race");
      const clear = await handleManagementAPI(new Request(patchUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inferResponsesMessagePhaseModels: null }),
      }), patchUrl, seeded, managementDeps);
      expect(clear?.status).toBe(200);
      expect(seeded.providers["phase-race"]?.inferResponsesMessagePhaseModels).toBeUndefined();
      expect(loadConfig().providers["phase-race"]?.inferResponsesMessagePhaseModels).toBeUndefined();

      releaseDns();
      expect((await pendingPost)?.status).toBe(200);
      expect(seeded.providers["phase-race"]?.inferResponsesMessagePhaseModels).toBeUndefined();
      const getUrl = new URL("http://127.0.0.1/api/providers");
      const providers = await (await handleManagementAPI(
        new Request(getUrl),
        getUrl,
        seeded,
        managementDeps,
      ))?.json() as Array<{ name: string; inferResponsesMessagePhaseModels?: string[] }>;
      expect(providers.find(provider => provider.name === "phase-race")?.inferResponsesMessagePhaseModels).toBeUndefined();
      expect(loadConfig().providers["phase-race"]?.inferResponsesMessagePhaseModels).toBeUndefined();
    } finally {
      resolvedError.mockRestore();
    }
  });
});

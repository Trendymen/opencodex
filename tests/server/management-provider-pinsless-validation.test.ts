/**
 * The pins-less provider POST validation case, held in a sibling file.
 *
 * Split out of management-provider-validation.test.ts for the reason recorded in
 * d3ca5522db and #4908: that file sits at its file-size ratchet cap and the cap only
 * ever moves downward, so a case added after it was set fails the ratchet for every
 * later pull request. The case is unchanged apart from its own temp directory.
 */
import { describe, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { config } from "../helpers/management-relative-send-paths";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
import type { ManagementContext } from "../../src/server/management/context";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { ManagementRequest } from "../helpers/management-auth";
import type { OcxConfig } from "../../src/types";

setDefaultTimeout(60_000);

const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-management-provider-pinsless-"));

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

function providerPostContext(liveConfig: OcxConfig, body: unknown): ManagementContext {
  const url = new URL("http://localhost/api/providers");
  return {
    url,
    config: liveConfig,
    version: "fixture",
    req: new ManagementRequest(url, { method: "POST", body: JSON.stringify(body) }),
    deps: { saveConfigPreservingClaudeCode: () => {} },
    convergeCodexCatalog: mock(async () => ({ status: "committed", changed: true, degraded: false, notices: [] } as const)),
    syncClaudeAgentDefsBestEffort: mock(async () => {}),
  };
}

describe("provider management validation", () => {
  test("provider POST validates a pins-less candidate before live adoption", async () => {
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({ ...config("127.0.0.1"), providers: poolProviders() });

    const server = startServer(0);
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      const response = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "relay",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://relay.example/v1",
            apiKeyPoolStrategy: "bogus",
          },
        }),
      });
      expect(response.status).toBe(400);
      expect(loadConfig().providers.relay).toBeUndefined();
    } finally {
      resolvedError.mockRestore();
      await server.stop(true);
    }
  });

  test("pins-less provider POST save failure restores its registration side effects", async () => {
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      const liveConfig: OcxConfig = {
        ...config("127.0.0.1"),
        providers: poolProviders(),
        disabledModels: ["relay/stale", "openai/keep"],
        modelDiscovery: {
          knownModels: { relay: { ids: ["stale"], removed: [], updatedAt: "2026-01-01T00:00:00Z" } },
          recentArrivals: { relay: [{ id: "stale", at: "2026-01-01T00:00:00Z" }] },
        },
      };
      const before = structuredClone(liveConfig);
      const ctx = providerPostContext(liveConfig, {
        name: "relay",
        setDefault: true,
        provider: { adapter: "openai-chat", baseUrl: "https://relay.example/v1" },
      });
      ctx.deps.saveConfigPreservingClaudeCode = candidate => {
        expect(candidate.defaultProvider).toBe("relay");
        expect(candidate.providers.relay).toHaveProperty("initialModelSelection");
        expect(candidate.disabledModels).toEqual(["openai/keep"]);
        expect(candidate.modelDiscovery!.knownModels).not.toHaveProperty("relay");
        expect(candidate.modelDiscovery!.recentArrivals).not.toHaveProperty("relay");
        throw new Error("fixture pins-less registration save failure");
      };

      await expect(handleProviderRoutes(ctx)).rejects.toThrow("fixture pins-less registration save failure");
      expect(liveConfig).toEqual(before);
    } finally {
      resolvedError.mockRestore();
    }
  });
});

// Holds INV-OPENAI-01 from structure/overview.md; keep the id here if this file is split or renamed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../../helpers/repo-root";
import {
  isCanonicalOpenAiForwardProvider as destinationIsCanonicalOpenAiForwardProvider,
  isThirdPartyNonGptResponsesRoute,
  OPENAI_CODEX_PROVIDER_ID as DESTINATION_OPENAI_CODEX_PROVIDER_ID,
} from "../../../src/providers/openai-tiers-destination";
import { getDefaultConfig } from "../../../src/config";
import { deriveInitProviders, deriveProviderPresets, listRegistryEntries, providerConfigSeed } from "../../../src/providers/derive";
import { getProviderRegistryEntry, providerCodexAccountMode } from "../../../src/providers/registry";
import {
  isCanonicalOpenAiForwardProvider,
  isOpenAiOperatedResponsesDestination,
  supportsNativeResponsesCompactEndpoint,
  LEGACY_CHATGPT_PROVIDER_ID,
  LEGACY_OPENAI_MULTI_PROVIDER_ID,
  OPENAI_API_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
} from "../../../src/providers/openai-tiers";
import { OPENAI_PROVIDER_TIER_VERSION } from "../../../src/types";
import { selectOpenAiImagesProvider } from "../../../src/providers/openai-sidecar";

describe("OpenAI single-provider option foundation", () => {
  test("locks exact ids, modes, and migration version", () => {
    expect(OPENAI_CODEX_PROVIDER_ID).toBe("openai");
    expect(LEGACY_OPENAI_MULTI_PROVIDER_ID).toBe("openai-multi");
    expect(OPENAI_API_PROVIDER_ID).toBe("openai-apikey");
    expect(LEGACY_CHATGPT_PROVIDER_ID).toBe("chatgpt");
    expect(OPENAI_PROVIDER_TIER_VERSION).toBe(2);
    expect(providerCodexAccountMode("openai")).toBe("pool");
    expect(providerCodexAccountMode("openai", { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: "direct" })).toBe("direct");
    expect(providerCodexAccountMode("openai-apikey")).toBeUndefined();
    expect(providerCodexAccountMode("openai-multi")).toBeUndefined();
  });

  test("accepts canonical transport with either account mode", () => {
    const canonical = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward" as const,
    };
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, codexAccountMode: "pool" })).toBe(true);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, codexAccountMode: "direct", baseUrl: `${canonical.baseUrl}/` })).toBe(true);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, adapter: "openai-chat" })).toBe(false);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, authMode: "key" })).toBe(false);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, baseUrl: `${canonical.baseUrl}?x=1` })).toBe(false);
    expect(isCanonicalOpenAiForwardProvider({})).toBe(false);
    expect(isCanonicalOpenAiForwardProvider({ adapter: "openai-responses" })).toBe(false);
    expect(isCanonicalOpenAiForwardProvider({ baseUrl: canonical.baseUrl })).toBe(false);
    expect(isCanonicalOpenAiForwardProvider({ adapter: "openai-responses", baseUrl: canonical.baseUrl })).toBe(false);
  });

  test("classifies only exact official OpenAI Responses destinations", () => {
    const responsesProvider = {
      adapter: "openai-responses",
      authMode: "key" as const,
      apiKey: "sk-test",
    };
    expect(isOpenAiOperatedResponsesDestination({
      ...responsesProvider,
      baseUrl: "https://api.openai.com/v1",
    })).toBe(true);
    expect(isOpenAiOperatedResponsesDestination({
      ...responsesProvider,
      baseUrl: "https://api.openai.com",
      responsesPath: "/v1/responses",
    })).toBe(true);
    expect(isOpenAiOperatedResponsesDestination({
      ...responsesProvider,
      baseUrl: "https://gateway.example.test/v1",
    })).toBe(false);
    expect(isOpenAiOperatedResponsesDestination({
      ...responsesProvider,
      baseUrl: "https://api.openai.com.evil.test/v1",
    })).toBe(false);
    expect(isOpenAiOperatedResponsesDestination({
      ...responsesProvider,
      adapter: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
    })).toBe(false);
    // The adapter sends key-auth traffic to `baseUrl + responsesPath`, so an official-looking base
    // pointed at a non-Responses path is not an OpenAI-operated Responses destination.
    expect(isOpenAiOperatedResponsesDestination({
      ...responsesProvider,
      baseUrl: "https://api.openai.com",
      responsesPath: "/other",
    })).toBe(false);
    expect(isOpenAiOperatedResponsesDestination({
      ...responsesProvider,
      baseUrl: "https://api.openai.com/v1",
      responsesPath: "/other",
    })).toBe(false);
    // The conventional defaults still classify: no `responsesPath` resolves to `/v1/responses`.
    expect(isOpenAiOperatedResponsesDestination({
      ...responsesProvider,
      baseUrl: "https://api.openai.com",
    })).toBe(true);
    expect(isOpenAiOperatedResponsesDestination({
      ...responsesProvider,
      baseUrl: "https://api.openai.com/v1",
      responsesPath: "/responses",
    })).toBe(true);
  });

  test("keeps compact normalization and Images raw-base matching separate", () => {
    const config = getDefaultConfig();
    config.providers["openai-apikey"] = {
      adapter: "openai-responses",
      authMode: "key",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      responsesPath: "/custom-responses",
    };
    const provider = config.providers["openai-apikey"]!;
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", provider)).toBe(true);
    expect(selectOpenAiImagesProvider(config).keyed?.providerName).toBe("openai-apikey");

    provider.baseUrl = "https://api.openai.com/v1/";
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", provider)).toBe(true);
    expect(selectOpenAiImagesProvider(config).keyed?.providerName).toBe("openai-apikey");

    provider.baseUrl = " https://api.openai.com/v1 ";
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", provider)).toBe(true);
    expect(selectOpenAiImagesProvider(config).keyed).toBeUndefined();

    provider.baseUrl = "https://API.OPENAI.COM/v1";
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", provider)).toBe(true);
    expect(selectOpenAiImagesProvider(config).keyed).toBeUndefined();
  });

  test("classifies third-party non-GPT Responses routes from destination and resolved model", () => {
    expect(isThirdPartyNonGptResponsesRoute({ adapter: "openai-responses", baseUrl: "https://gateway.example.test/v1" }, "glm-5.3")).toBe(true);
    expect(isThirdPartyNonGptResponsesRoute({ adapter: "openai-responses", baseUrl: "https://gateway.example.test/v1" }, "openai/gpt-oss-120b")).toBe(false);
    expect(isThirdPartyNonGptResponsesRoute({ adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" }, "glm-5.3")).toBe(false);
    expect(isThirdPartyNonGptResponsesRoute({ adapter: "openai-chat", baseUrl: "https://gateway.example.test/v1" }, "glm-5.3")).toBe(false);
  });

  test("publishes one Codex-login registry, preset, init, and default row", () => {
    for (const rows of [listRegistryEntries(), deriveProviderPresets(), deriveInitProviders()]) {
      expect(rows.some(entry => entry.id === LEGACY_OPENAI_MULTI_PROVIDER_ID)).toBe(false);
      expect(rows.filter(entry => entry.id === OPENAI_CODEX_PROVIDER_ID)).toHaveLength(1);
    }
    const registry = getProviderRegistryEntry(OPENAI_CODEX_PROVIDER_ID)!;
    expect(providerConfigSeed(registry)).toMatchObject({ codexAccountMode: "pool" });
    expect(getDefaultConfig().providers.openai).toMatchObject({ codexAccountMode: "pool" });
  });
});

test("destination leaf preserves facade bindings without importing the facade", () => {
  expect(destinationIsCanonicalOpenAiForwardProvider).toBe(isCanonicalOpenAiForwardProvider);
  expect(DESTINATION_OPENAI_CODEX_PROVIDER_ID).toBe(OPENAI_CODEX_PROVIDER_ID);
  const source = readFileSync(repoPath("src/providers/openai-tiers-destination.ts"), "utf8");
  expect(source).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?)["']\.\/openai-tiers(?:\.ts)?["']/);
});

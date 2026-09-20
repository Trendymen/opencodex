import { describe, expect, test } from "bun:test";
import { supportsNativeResponsesCompactEndpoint } from "../../src/providers/openai-tiers";
import type { OcxProviderConfig } from "../../src/types";

describe("supportsNativeResponsesCompactEndpoint (#422)", () => {
  const canonicalForward = {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward",
  } as OcxProviderConfig;
  const officialApi = {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authMode: "key",
  } as OcxProviderConfig;

  test("accepts the canonical ChatGPT backend and the official OpenAI API", () => {
    expect(supportsNativeResponsesCompactEndpoint("openai", canonicalForward)).toBe(true);
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", officialApi)).toBe(true);
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", {
      ...officialApi,
      baseUrl: "https://api.openai.com/v1/",
    })).toBe(true);
  });

  test("rejects any other Responses-shaped gateway", () => {
    expect(supportsNativeResponsesCompactEndpoint("gw", {
      adapter: "openai-responses",
      baseUrl: "https://gateway.example/v1",
      authMode: "key",
    } as OcxProviderConfig)).toBe(false);
    // Right provider id, wrong destination.
    expect(supportsNativeResponsesCompactEndpoint("openai-apikey", {
      ...officialApi,
      baseUrl: "https://gateway.example/v1",
    })).toBe(false);
  });
});

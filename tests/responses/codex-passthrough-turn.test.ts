import { describe, expect, test } from "bun:test";
import type { OcxProviderConfig, OcxConfig } from "../../src/types";
import { routeModel } from "../../src/router";
import { CODEX_PASSTHROUGH_DEFAULTS } from "../../src/fork/codex-passthrough-contract";
import {
  captureCodexPassthroughTurn, resolveCodexPassthroughAttempt,
  shouldRetainCodexRequestSource, codexPassthroughSourceRequired,
  markCodexPassthroughResponse, codexPassthroughResponsePermissions, carryCodexPassthroughResponse,
} from "../../src/fork/codex-passthrough-turn";

const canonical: OcxProviderConfig = {
  adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex/",
};

describe("Codex passthrough turn", () => {
  test("attempt_uses_frozen_overrides_after_effective_wire_change", () => {
    const provider: OcxProviderConfig = { ...canonical, adapter: "openai-chat",
      codexPassthrough: { bridgeLiteMetadata: false, localErrorPolicies: { accountSoftPrecheck: false } } };
    const turn = captureCodexPassthroughTurn({ renamed: provider }, "responses");
    provider.codexPassthrough!.bridgeLiteMetadata = true;
    provider.codexPassthrough!.localErrorPolicies!.accountSoftPrecheck = true;
    const destination = { providerName: "renamed", provider: { ...provider, adapter: "openai-responses" }, inboundWire: "responses" as const };
    const permissions = resolveCodexPassthroughAttempt(turn, destination)!;
    expect(permissions.bridgeLiteMetadata).toBe(false);
    expect(permissions.localErrorPolicies.accountSoftPrecheck).toBe(false);
    expect(Object.isFrozen(permissions)).toBe(true);
    expect(Object.isFrozen(permissions.localErrorPolicies)).toBe(true);
    expect(resolveCodexPassthroughAttempt(captureCodexPassthroughTurn({ renamed: provider }, "responses"), destination)?.bridgeLiteMetadata).toBe(true);
    expect(resolveCodexPassthroughAttempt(turn, { ...destination, provider: { ...destination.provider, authMode: "key" } })).toBeUndefined();
    expect(resolveCodexPassthroughAttempt(turn, { ...destination, inboundWire: "chat" })).toBeUndefined();
    for (const codexAccountMode of ["direct", "pool"] as const) {
      expect(resolveCodexPassthroughAttempt(turn, { ...destination, provider: { ...destination.provider, codexAccountMode, apiKey: "synthetic-private-token" } })?.bridgeLiteMetadata).toBe(false);
    }
  });

  test("source_precheck_ignores_third_party_override_values", () => {
    const key: OcxProviderConfig = { adapter: "openai-responses", authMode: "key", baseUrl: "https://third.example.test/v1" };
    for (const value of [undefined, {}, { bridgeLiteMetadata: false }, { bridgeLiteMetadata: true }, null, "broken"]) {
      const providers = { operatorOwned: { ...key, codexPassthrough: value } as OcxProviderConfig };
      expect(shouldRetainCodexRequestSource(providers, "responses")).toBe(false);
      expect(captureCodexPassthroughTurn(providers, "responses")).toBeUndefined();
    }
    expect(shouldRetainCodexRequestSource({ renamed: canonical }, "chat")).toBe(false);
    expect(shouldRetainCodexRequestSource({ renamed: canonical }, "anthropic")).toBe(false);
    expect(shouldRetainCodexRequestSource({}, "responses")).toBe(true);
    expect(shouldRetainCodexRequestSource({ incomplete: { adapter: "openai-chat" } }, "responses")).toBe(true);
    for (const authMode of ["forward", "local", "key"] as const) {
      expect(shouldRetainCodexRequestSource({ openai: { ...key, authMode } }, "responses")).toBe(true);
    }
    const mixed = { third: key, renamed: { ...canonical, adapter: "openai-chat", codexPassthrough: { normalizeRequestParameters: false } } };
    const turn = captureCodexPassthroughTurn(mixed, "responses");
    expect(codexPassthroughSourceRequired(turn)).toBe(true);
    expect(resolveCodexPassthroughAttempt(turn, { providerName: "third", provider: key, inboundWire: "responses" })).toBeUndefined();
    expect(resolveCodexPassthroughAttempt(turn, { providerName: "renamed", provider: canonical, inboundWire: "responses" })?.normalizeRequestParameters).toBe(false);
    expect(resolveCodexPassthroughAttempt(turn, { providerName: "renamed", provider: { ...canonical, baseUrl: "https://third.example.test/v1" }, inboundWire: "responses" })).toBeUndefined();
  });

  test("response_permissions_are_internal_and_carry_without_wire_fields", async () => {
    const original = new Response("payload", { headers: { "x-upstream": "kept" } });
    const before = [...original.headers];
    const response = markCodexPassthroughResponse(original, CODEX_PASSTHROUGH_DEFAULTS);
    expect([...response.headers]).toEqual(before);
    const replacement = carryCodexPassthroughResponse(response, new Response(response.body, { headers: response.headers }));
    expect(codexPassthroughResponsePermissions(replacement)).toBe(CODEX_PASSTHROUGH_DEFAULTS);
    expect(await replacement.text()).toBe("payload");
    expect(codexPassthroughResponsePermissions(new Response())).toBeUndefined();
  });

  test("registry resolution still decides the actual scope after conservative capture", () => {
    for (const codexPassthrough of [undefined, {}, { bridgeLiteMetadata: true }, { bridgeLiteMetadata: false }]) {
      const config: OcxConfig = { port: 10100, defaultProvider: "openai", providers: {
        openai: { adapter: "openai-chat", authMode: "local", baseUrl: "https://third.example.test/v1", codexPassthrough },
      } };
      const turn = captureCodexPassthroughTurn(config.providers, "responses");
      const route = routeModel(config, "openai/gpt-5.6-sol");
      expect(route.provider.authMode).toBe("forward");
      expect(route.provider.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
      expect(resolveCodexPassthroughAttempt(turn, { providerName: route.providerName, provider: route.provider, inboundWire: "responses" })?.bridgeLiteMetadata).toBe(codexPassthrough?.bridgeLiteMetadata ?? true);
    }
  });

  test("unknown post-capture provider names always receive the complete defaults", () => {
    const turn = captureCodexPassthroughTurn({}, "responses");
    for (const providerName of ["constructor", "toString", "__proto__"]) {
      expect(resolveCodexPassthroughAttempt(turn, { providerName, provider: canonical, inboundWire: "responses" })).toBe(CODEX_PASSTHROUGH_DEFAULTS);
    }
  });
});

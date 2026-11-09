import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses/passthrough";
import { providerForwardClientHeadersConfigError } from "../../src/config/provider-validation";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { providerManagementConfigError } from "../../src/server/auth-cors";
import type { OcxProviderConfig } from "../../src/types";
import { resolveCodexPassthroughPermissions } from "../../src/fork/codex-passthrough-contract";
import { prepareCodexHttpInit, prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";

function buildHeaders(provider: OcxProviderConfig, incoming: Record<string, string>): Record<string, string> {
  const budget = createTranslatorBudget();
  try {
    const request = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "test-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "test-model", input: "hello", stream: true },
    }, {
      headers: new Headers(incoming),
      translatorBudget: budget,
      providerName: "test",
    });
    request.releaseBodyObservation?.();
    return Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
  } finally {
    budget.dispose();
  }
}

describe("openai-responses forwardClientHeaders", () => {
  test("canonical routing hint permission preserves caller and static values when disabled", () => {
    const budget = createTranslatorBudget();
    try {
      for (const staticName of ["x-codex-routing-hint", "X-Codex-Routing-Hint"]) for (const caller of [undefined, "caller-hint"]) {
        const request = createResponsesPassthroughAdapter({ adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex",
          headers: { [staticName]: "static-hint" } }).buildRequest({ modelId: "gpt-5.6-sol", context: { messages: [] }, stream: true, options: {},
          _rawBody: { model: "gpt-5.6-sol", input: "hello", stream: true } }, { translatorBudget: budget,
          headers: new Headers(caller ? { "x-codex-routing-hint": caller } : {}),
          codexPassthroughPermissions: resolveCodexPassthroughPermissions({ synthesizeRoutingHint: false }) });
        const permissions = resolveCodexPassthroughPermissions({ synthesizeRoutingHint: false });
        expect(new Headers(request.headers).get("x-codex-routing-hint")).toBe("static-hint");
        const init = { method: "POST", headers: request.headers, body: request.body };
        expect(new Headers(prepareCodexHttpInit(request.url, init, permissions).headers).get("x-codex-routing-hint")).toBe("static-hint");
        expect(new Headers(prepareCodexWsRequest(request.url, init, permissions)!.headers).get("x-codex-routing-hint")).toBe("static-hint");
        request.releaseBodyObservation?.();
      }
    } finally { budget.dispose(); }
  });

  test("noncanonical adapters ignore official permissions even if incoming metadata supplies them", () => {
    const provider: OcxProviderConfig = { adapter: "openai-responses", authMode: "key", apiKey: "synthetic-key", baseUrl: "https://third.example.test/v1" };
    const rawBody = { model: "fixture-model", input: "hello", stream: true, metadata: { caller: "keep" }, max_output_tokens: 47 };
    const budget = createTranslatorBudget();
    try {
      const parsed = { modelId: rawBody.model, context: { messages: [] }, stream: true, options: {}, _rawBody: rawBody };
      const baseline = createResponsesPassthroughAdapter(provider).buildRequest(parsed, { headers: new Headers(), translatorBudget: budget });
      const supplied = createResponsesPassthroughAdapter({ ...provider, codexPassthrough: { normalizeRequestParameters: false } }).buildRequest(parsed, {
        headers: new Headers(), translatorBudget: budget,
        codexPassthroughPermissions: resolveCodexPassthroughPermissions({ normalizeRequestParameters: false, bridgeLiteMetadata: false, synthesizeRoutingHint: false }),
      });
      expect(supplied.body).toBe(baseline.body); expect(supplied.headers).toEqual(baseline.headers);
      baseline.releaseBodyObservation?.(); supplied.releaseBodyObservation?.();
    } finally { budget.dispose(); }
  });
  test("copies only selected caller metadata while provider headers remain authoritative", () => {
    const headers = buildHeaders({
      adapter: "openai-responses",
      baseUrl: "https://example.com/v1",
      authMode: "key",
      apiKey: "provider-key",
      headers: {
        "X-Client-Request-Id": "provider-owned",
        "User-Agent": "provider-agent",
      },
      forwardClientHeaders: [
        "originator",
        "x-client-request-id",
        "x-codex-app-version",
        "user-agent",
      ],
    }, {
      authorization: "Bearer caller-secret",
      originator: "codex_cli_rs",
      "user-agent": "caller-agent",
      "x-client-request-id": "caller-request",
      "x-codex-app-version": "0.159.3",
      "x-not-forwarded": "must-stay-local",
    });

    expect(headers.authorization).toBe("Bearer provider-key");
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers["x-client-request-id"]).toBe("provider-owned");
    expect(headers["x-codex-app-version"]).toBe("0.159.3");

    expect(headers["user-agent"]).toBe("provider-agent");
    expect(headers["x-not-forwarded"]).toBeUndefined();
  });

  test("runtime refuses credential and transport headers even if validation is bypassed", () => {
    const headers = buildHeaders({
      adapter: "openai-responses",
      baseUrl: "https://example.com/v1",
      authMode: "key",
      apiKey: "provider-key",
      forwardClientHeaders: ["authorization", "cookie", "content-type", "x-oai-attestation", "Api-Key", "originator"],
    }, {
      authorization: "Bearer caller-secret",
      cookie: "session=secret",
      "content-type": "text/plain",
      "x-oai-attestation": "attestation-secret",
      "api-key": "caller-azure-secret",
      "x-codex-app-version": "0.159.3",
      originator: "codex_cli_rs",
    });

    expect(headers.authorization).toBe("Bearer provider-key");
    expect(headers.cookie).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-oai-attestation"]).toBeUndefined();
    expect(headers["api-key"]).toBeUndefined();
    expect(headers.originator).toBe("codex_cli_rs");
  });

  test("runtime blocks mixed-case api-key in forward auth mode", () => {
    const headers = buildHeaders({
      adapter: "openai-responses",
      baseUrl: "https://example.com/v1",
      authMode: "forward",
      forwardClientHeaders: ["Api-Key", "originator", "x-codex-app-version"],
    }, {
      "api-key": "caller-azure-secret",
      "x-codex-app-version": "0.159.3",
      originator: "codex_cli_rs",
    });

    expect(headers["api-key"]).toBeUndefined();
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers["x-codex-app-version"]).toBe("0.159.3");
  });

  test("canonical OpenAI provider accepts forwardClientHeaders as an operator overlay", () => {
    const entry = getProviderRegistryEntry("openai");
    expect(entry).toBeDefined();
    const provider = providerConfigSeed(entry!);

    expect(providerManagementConfigError("openai", {
      ...provider,
      codexAccountMode: "direct",
      forwardClientHeaders: ["originator", "x-client-request-id"],
    })).toBeNull();
  });

  test("validation rejects malformed, duplicate, credential, and transport-owned names", () => {
    expect(providerForwardClientHeadersConfigError(["originator", "x-client-request-id"])).toBeNull();
    expect(providerForwardClientHeadersConfigError("originator")).toContain("array");
    expect(providerForwardClientHeadersConfigError(["bad header"])).toContain("valid HTTP header names");
    expect(providerForwardClientHeadersConfigError(["Originator", "originator"])).toContain("must not repeat");
    expect(providerForwardClientHeadersConfigError(["authorization"])).toContain("credential or transport-owned");
    expect(providerForwardClientHeadersConfigError(["Api-Key"])).toContain("credential or transport-owned");
    expect(providerForwardClientHeadersConfigError(["x-custom-client-meta"])).toContain("allowlist");
    expect(providerForwardClientHeadersConfigError(["content-length"])).toContain("credential or transport-owned");
  });
});


test("only supported metadata can cross even when unsafe names are explicitly configured", () => {
  const unsafe = ["X-OpenCodex-Api-Key", "X-Custom-Secret", "Proxy-Authorization", "Set-Cookie", "X-Auth-Token"];
  const headers = buildHeaders({ adapter: "openai-responses", baseUrl: "https://example.com/v1",
    forwardClientHeaders: unsafe,
  }, Object.fromEntries(unsafe.map(name => [name, "private-fixture"])));
  for (const name of unsafe) {
    expect(headers[name.toLowerCase()]).toBeUndefined();
    expect(providerForwardClientHeadersConfigError([name])).not.toBeNull();
  }
});

test("additional metadata forwarding is disabled by default", () => {
  const headers = buildHeaders({ adapter: "openai-responses", baseUrl: "https://example.com/v1" },
    { originator: "codex_cli_rs", "x-codex-app-version": "0.159.3" });
  expect(headers.originator).toBeUndefined();
  expect(headers["x-codex-app-version"]).toBeUndefined();
});

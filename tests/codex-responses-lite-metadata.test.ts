import { afterEach, describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const canonicalProvider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward" as const,
};

function buildCanonicalRequest(
  rawBody: Record<string, unknown>,
  headers: Headers = new Headers(),
): Record<string, unknown> {
  const request = createResponsesPassthroughAdapter(canonicalProvider).buildRequest({
    modelId: "gpt-5.6-sol",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: rawBody,
  }, { headers });
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("canonical forward responses-lite metadata", () => {
  test("copies a true HTTP responses-lite header into client metadata without mutating the caller body", () => {
    const rawBody = {
      model: "gpt-5.6-sol",
      input: "ping",
      client_metadata: { request_source: "codex-cli" },
    };

    const body = buildCanonicalRequest(rawBody, new Headers({
      "x-openai-internal-codex-responses-lite": "true",
    }));

    expect(body.client_metadata).toEqual({
      request_source: "codex-cli",
      ws_request_header_x_openai_internal_codex_responses_lite: "true",
    });
    expect(rawBody).toEqual({
      model: "gpt-5.6-sol",
      input: "ping",
      client_metadata: { request_source: "codex-cli" },
    });
  });

  test("forwards the true HTTP responses-lite header on canonical upstream requests", () => {
    const request = createResponsesPassthroughAdapter(canonicalProvider).buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.6-sol", input: "ping" },
    }, { headers: new Headers({ "x-openai-internal-codex-responses-lite": "true" }) });

    expect(request.headers["x-openai-internal-codex-responses-lite"]).toBe("true");
  });

  test("does not add responses-lite metadata without the HTTP header", () => {
    const body = buildCanonicalRequest({
      model: "gpt-5.6-sol",
      input: "ping",
      client_metadata: { request_source: "codex-cli" },
    });

    expect(body.client_metadata).toEqual({ request_source: "codex-cli" });
  });

  test("does not add responses-lite metadata for non-true HTTP header values", () => {
    for (const value of ["false", "TRUE", ""]) {
      const body = buildCanonicalRequest(
        { model: "gpt-5.6-sol", input: "ping" },
        new Headers({ "x-openai-internal-codex-responses-lite": value }),
      );

      expect(body).not.toHaveProperty("client_metadata");
    }
  });

  test("keeps the caller's existing responses-lite metadata value", () => {
    const body = buildCanonicalRequest({
      model: "gpt-5.6-sol",
      input: "ping",
      client_metadata: {
        ws_request_header_x_openai_internal_codex_responses_lite: "caller-value",
      },
    }, new Headers({ "x-openai-internal-codex-responses-lite": "true" }));

    expect(body.client_metadata).toEqual({
      ws_request_header_x_openai_internal_codex_responses_lite: "caller-value",
    });
  });

  test("does not add responses-lite metadata for noncanonical forward providers", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://forward-gateway.example.test/v1",
      authMode: "forward",
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.6-sol", input: "ping" },
    }, { headers: new Headers({ "x-openai-internal-codex-responses-lite": "true" }) });

    expect(JSON.parse(request.body)).not.toHaveProperty("client_metadata");
    expect(request.headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
  });

  test("does not add responses-lite metadata for public OpenAI API-key providers", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
      apiKey: "test-key",
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.6-sol", input: "ping" },
    }, { headers: new Headers({ "x-openai-internal-codex-responses-lite": "true" }) });

    expect(JSON.parse(request.body)).not.toHaveProperty("client_metadata");
    expect(request.headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
  });

  test("keeps malformed client metadata unchanged instead of coercing it", () => {
    for (const clientMetadata of ["not-an-object", ["not-an-object"], null]) {
      const body = buildCanonicalRequest({
        model: "gpt-5.6-sol",
        input: "ping",
        client_metadata: clientMetadata,
      }, new Headers({ "x-openai-internal-codex-responses-lite": "true" }));

      expect(body.client_metadata).toEqual(clientMetadata);
    }
  });
});

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static script: (ws: FakeWebSocket) => void = () => {};
  sent: string[] = [];
  listeners = new Map<string, Listener[]>();

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => FakeWebSocket.script(this));
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.emit("close", {});
  }
}

const realWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = realWebSocket;
  FakeWebSocket.instances = [];
  FakeWebSocket.script = () => {};
});

test("HTTP responses-lite header reaches the actual upstream WS create frame", async () => {
  FakeWebSocket.script = ws => {
    ws.emit("open", {});
    ws.emit("message", {
      data: JSON.stringify({ type: "response.completed", response: { id: "r-lite", status: "completed", output: [] } }),
    });
  };
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

  const config = {
    port: 0,
    defaultProvider: "openai",
    streamMode: "legacy-tee",
    providers: {
      openai: { ...canonicalProvider, codexAccountMode: "direct" },
    },
  } as OcxConfig;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test",
      "x-openai-internal-codex-responses-lite": "true",
    },
    body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true }),
  }), config, { model: "", provider: "" }, { codexWsRuntimeIdentity: "1.4.0" });
  await response.text();

  const frame = JSON.parse(FakeWebSocket.instances[0]!.sent[0]!) as Record<string, unknown>;
  expect(frame.client_metadata).toEqual({
    ws_request_header_x_openai_internal_codex_responses_lite: "true",
  });
});

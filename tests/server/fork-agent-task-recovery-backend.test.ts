import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearResponseStateForTests,
  expandPreviousResponseInput,
  rememberResponseState,
} from "../../src/responses/state";
import {
  CODEX_TEXT_GUARDED_BUDGET_POLICY,
  createRequestExecutionBudget,
} from "../../src/lib/request-execution-budget";
import type { TransientSendBudget } from "../../src/lib/upstream-retry";
import { resetAgentTaskRecoveryState } from "../../src/server/responses/agent-task-recovery";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig } from "../../src/types";
import {
  codexHeaders,
  encryptedInput,
  providerResponse,
  recoverySse,
  routedConfig,
} from "../helpers/agent-task-recovery";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
let releaseSpendHome: (() => void) | undefined;

/** Fork-only wrapper: extend the official helper request with arbitrary body fields. */
function post(
  config: OcxConfig,
  model: string,
  input: unknown[],
  headers: HeadersInit,
  abortSignal?: AbortSignal,
  extraBody: Record<string, unknown> = {},
  sendBudget?: TransientSendBudget,
): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify({ model, input, stream: false, ...extraBody }),
  }), config, { model: "", provider: "" }, { abortSignal, sendBudget });
}

describe("fork agent task recovery (strict backend ciphertext)", () => {
  beforeEach(() => {
    releaseSpendHome = acquireOwnedSpendHome();
    resetAgentTaskRecoveryState();
    clearResponseStateForTests();
  });

  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    resetAgentTaskRecoveryState();
    clearResponseStateForTests();
  });
  test("retries a strict backend-encrypted native child once after its transient 5xx retries are exhausted", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    const assignment = "Return only ok.";
    let nativeAttempts = 0;
    let recoveryAttempts = 0;
    const forwardedBodies: string[] = [];
    const sendBudget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        recoveryAttempts += 1;
        return new Response(recoverySse(assignment), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      nativeAttempts += 1;
      forwardedBodies.push(body);
      if (nativeAttempts <= 3) return new Response("temporarily unavailable", { status: 502 });
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
      undefined,
      {},
      sendBudget,
    );

    expect(response.status).toBe(200);
    expect(nativeAttempts).toBe(4);
    expect(recoveryAttempts).toBe(1);
    expect(forwardedBodies.slice(0, 3).every(body => body.includes(backendCiphertext))).toBe(true);
    expect(forwardedBodies[3]).toContain(assignment);
    expect(forwardedBodies[3]).not.toContain(backendCiphertext);
    expect(sendBudget.used).toBe(4);
    expect(sendBudget.reserveSpent).toBe(true);
  });

  test("cleans an older unknown slot while preserving the strict current task for bounded recovery", async () => {
    const backendCiphertext = `gAAAA${"D".repeat(128)}`;
    const olderUnknownSlot = "A".repeat(128);
    const assignment = "Return only the recovered current task.";
    const nativeBodies: string[] = [];
    let recoveryAttempts = 0;
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        recoveryAttempts += 1;
        return new Response(recoverySse(assignment), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      nativeBodies.push(body);
      return nativeBodies.length <= 3
        ? new Response("temporarily unavailable", { status: 502 })
        : providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      [
        {
          type: "message",
          role: "user",
          content: [{ type: "encrypted_content", encrypted_content: olderUnknownSlot }],
        },
        ...encryptedInput({ ciphertext: backendCiphertext }),
      ],
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(recoveryAttempts).toBe(1);
    expect(nativeBodies).toHaveLength(4);
    for (const body of nativeBodies.slice(0, 3)) {
      const sent = JSON.parse(body) as { input: Array<Record<string, unknown>> };
      expect(sent.input[0]).toEqual({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: olderUnknownSlot }],
      });
      expect(sent.input[1]).toMatchObject({
        type: "agent_message",
        content: [
          { type: "input_text" },
          { type: "encrypted_content", encrypted_content: backendCiphertext },
        ],
      });
    }
    expect(nativeBodies[3]).toContain(assignment);
    expect(nativeBodies[3]).not.toContain(backendCiphertext);
  });

  test("保留共享预算耗尽时的原始 transient 响应，且 oneShot 不再发送", async () => {
    const backendCiphertext = `gAAAA${"B".repeat(128)}`;
    const sendBudget = createRequestExecutionBudget({
      ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
      finalRecoveryAllowance: 0,
    });
    let nativeAttempts = 0;
    let recoveryAttempts = 0;
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        recoveryAttempts += 1;
        return new Response(recoverySse("Return only ok."), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      nativeAttempts += 1;
      return new Response("original native failure", { status: 502 });
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
      undefined,
      {},
      sendBudget,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("original native failure");
    expect(nativeAttempts).toBe(3);
    expect(recoveryAttempts).toBe(1);
    expect(sendBudget.used).toBe(3);
    expect(sendBudget.reserveSpent).toBe(false);
  });

  test.each([
    ["502", () => new Response("replayed native failure", { status: 502 })],
    ["connection reset", () => Promise.reject(Object.assign(new TypeError("socket hang up"), { code: "ECONNRESET" }))],
  ])("oneShot 遇到 %s 时只发送一次", async (_name, fourthNativeResponse) => {
    const backendCiphertext = `gAAAA${"C".repeat(128)}`;
    let nativeAttempts = 0;
    globalThis.fetch = ((_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        return Promise.resolve(new Response(recoverySse("Return only ok."), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }));
      }
      nativeAttempts += 1;
      if (nativeAttempts <= 3) return Promise.resolve(new Response("original native failure", { status: 502 }));
      return Promise.resolve(fourthNativeResponse());
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
    );

    expect(response.status).toBe(_name === "502" ? 502 : 429);
    expect(nativeAttempts).toBe(4);
    if (_name === "connection reset") {
      const body = await response.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe("upstream_reset_replay_refused");
    }
  });

  test("does not call recovery for a backend-encrypted native child when the opt-in is disabled", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    let nativeAttempts = 0;
    let recoveryAttempts = 0;
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) recoveryAttempts += 1;
      nativeAttempts += 1;
      return new Response("temporarily unavailable", { status: 502 });
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: false }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
    );

    expect(response.status).toBe(502);
    expect(nativeAttempts).toBe(3);
    expect(recoveryAttempts).toBe(0);
  });

  test("does not recover after a slow transient 5xx returns before retry exhaustion", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    let now = 1_000;
    Date.now = () => now;
    let nativeAttempts = 0;
    let recoveryAttempts = 0;
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        recoveryAttempts += 1;
        return new Response(recoverySse("Return only ok."), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      nativeAttempts += 1;
      now += 15_001;
      return new Response("slow transient failure", { status: 502 });
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("slow transient failure");
    expect(nativeAttempts).toBe(1);
    expect(recoveryAttempts).toBe(0);
  });

  test("does not pre-recover a backend-encrypted native child that succeeds directly", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    let nativeAttempts = 0;
    let recoveryAttempts = 0;
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) recoveryAttempts += 1;
      else nativeAttempts += 1;
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(nativeAttempts).toBe(1);
    expect(recoveryAttempts).toBe(0);
  });

  test("does not retain a directly successful backend ciphertext in continuation state", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    const responseId = "resp_backend_ciphertext_direct_success_no_state";
    globalThis.fetch = (async () => Response.json({
      id: responseId,
      object: "response",
      status: "completed",
      model: "gpt-5.5",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    const replay = expandPreviousResponseInput({ previous_response_id: responseId }) as {
      input?: unknown;
    };
    expect(replay.input).toBeUndefined();
    expect(JSON.stringify(replay)).not.toContain(backendCiphertext);
  });

  test("does not retain a directly successful strict backend ciphertext from a trusted direct Responses route", async () => {
    const backendCiphertext = `gAAAA${"C".repeat(128)}`;
    const responseId = "resp_trusted_direct_backend_ciphertext_no_state";
    const config = routedConfig({ enabled: true });
    config.providers.relay = {
      adapter: "openai-responses",
      baseUrl: "https://relay.example.test/v1",
      authMode: "key",
      apiKey: "test-relay-key",
      allowEncryptedV2AgentTasks: true,
    };
    let forwardedBody = "";
    globalThis.fetch = (async (_input, init) => {
      forwardedBody = typeof init?.body === "string" ? init.body : "";
      return Response.json({
        id: responseId,
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const response = await post(
      config,
      "relay/gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(forwardedBody).toContain(backendCiphertext);
    const replay = expandPreviousResponseInput({ previous_response_id: responseId }) as {
      input?: unknown;
    };
    expect(replay.input).toBeUndefined();
    expect(JSON.stringify(replay)).not.toContain(backendCiphertext);
  });

  test("does not retain strict backend ciphertext on trusted routes when recovery is absent or disabled", async () => {
    const recoveryModes: Array<{ name: string; value: OcxConfig["agentTaskRecovery"] | null }> = [
      { name: "absent", value: null },
      { name: "disabled", value: { enabled: false } },
    ];
    const routes = [
      { name: "trusted direct Responses", model: "relay/gpt-5.5", trusted: true },
      { name: "canonical ChatGPT", model: "gpt-5.5", trusted: false },
    ];

    for (const [routeIndex, route] of routes.entries()) {
      for (const [modeIndex, recovery] of recoveryModes.entries()) {
        const backendCiphertext = `gAAAA${String.fromCharCode(68 + routeIndex * 2 + modeIndex).repeat(128)}`;
        const responseId = `resp_${route.name.replaceAll(" ", "_")}_${recovery.name}_strict_ciphertext`;
        const config = routedConfig(recovery.value);
        if (route.trusted) {
          config.providers.relay = {
            adapter: "openai-responses",
            baseUrl: "https://relay.example.test/v1",
            authMode: "key",
            apiKey: "test-relay-key",
            allowEncryptedV2AgentTasks: true,
          };
        }
        let forwardedBody = "";
        globalThis.fetch = (async (_input, init) => {
          forwardedBody = typeof init?.body === "string" ? init.body : "";
          return Response.json({
            id: responseId,
            object: "response",
            status: "completed",
            model: "gpt-5.5",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          });
        }) as typeof fetch;

        const response = await post(
          config,
          route.model,
          encryptedInput({ ciphertext: backendCiphertext }),
          codexHeaders(),
        );

        expect(response.status).toBe(200);
        expect(forwardedBody).toContain(backendCiphertext);
        const replay = expandPreviousResponseInput({ previous_response_id: responseId }) as {
          input?: unknown;
        };
        expect(replay.input).toBeUndefined();
        expect(JSON.stringify(replay)).not.toContain(backendCiphertext);
      }
    }
  });

  test("does not retain strict backend ciphertext restored by previous_response_id", async () => {
    const backendCiphertext = `gAAAA${"H".repeat(128)}`;
    const priorResponseId = "resp_prior_strict_backend_ciphertext";
    const responseId = "resp_expanded_strict_backend_ciphertext_no_state";
    const config = routedConfig(null);
    config.providers.relay = {
      adapter: "openai-responses",
      baseUrl: "https://relay.example.test/v1",
      authMode: "key",
      apiKey: "test-relay-key",
      allowEncryptedV2AgentTasks: true,
    };
    rememberResponseState(
      { model: "relay/gpt-5.5", input: encryptedInput({ ciphertext: backendCiphertext }) },
      { id: priorResponseId, status: "completed", output: [] },
    );
    let forwardedBody = "";
    globalThis.fetch = (async (_input, init) => {
      forwardedBody = typeof init?.body === "string" ? init.body : "";
      return Response.json({
        id: responseId,
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const response = await post(
      config,
      "relay/gpt-5.5",
      [],
      codexHeaders(),
      undefined,
      { previous_response_id: priorResponseId },
    );

    expect(response.status).toBe(200);
    expect(forwardedBody).toContain(backendCiphertext);
    const replay = expandPreviousResponseInput({ previous_response_id: responseId }) as {
      input?: unknown;
    };
    expect(replay.input).toBeUndefined();
    expect(JSON.stringify(replay)).not.toContain(backendCiphertext);
  });

  test("preserves the terminal native response when backend task recovery fails", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    let nativeAttempts = 0;
    let recoveryAttempts = 0;
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        recoveryAttempts += 1;
        return new Response("data: {\"type\":\"response.failed\"}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      nativeAttempts += 1;
      return new Response("original native failure", { status: 502 });
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("original native failure");
    expect(nativeAttempts).toBe(3);
    expect(recoveryAttempts).toBe(1);
  });

  test("preserves a signal-bound native failure when the plaintext retry transport fails", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    let nativeAttempts = 0;
    let originalBodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        return new Response(recoverySse("Return only ok."), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      nativeAttempts += 1;
      if (nativeAttempts < 3) return new Response("discarded native failure", { status: 502 });
      if (nativeAttempts === 3) {
        const signal = init?.signal;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            originalBodyController = controller;
            signal?.addEventListener("abort", () => controller.error(
              signal.reason ?? new DOMException("aborted", "AbortError"),
            ), { once: true });
          },
        }), { status: 502 });
      }
      try {
        originalBodyController?.enqueue(new TextEncoder().encode("original native failure"));
        originalBodyController?.close();
      } catch { /* A premature abort is the regression this assertion detects. */ }
      throw new TypeError("plaintext retry transport failed");
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("original native failure");
    expect(nativeAttempts).toBe(4);
  });

  test("rejects recovered assignments that still contain backend ciphertext", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    let nativeAttempts = 0;
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        return new Response(recoverySse(`prefix ${backendCiphertext} suffix`), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      nativeAttempts += 1;
      return new Response("original native failure", { status: 502 });
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("original native failure");
    expect(nativeAttempts).toBe(3);
  });

  test("returns 499 when the client cancels canonical backend-task recovery", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    const controller = new AbortController();
    let startRecovery: (() => void) | undefined;
    const recoveryStarted = new Promise<void>(resolve => { startRecovery = resolve; });
    let nativeAttempts = 0;
    globalThis.fetch = ((input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        startRecovery?.();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
          if (signal?.aborted) rejectAbort();
          else signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      nativeAttempts += 1;
      return Promise.resolve(new Response("original native failure", { status: 502 }));
    }) as typeof fetch;

    const pending = post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
      controller.signal,
    );
    await recoveryStarted;
    controller.abort(new DOMException("client disconnected", "AbortError"));
    const response = await pending;

    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error: { code: "client_cancelled" } });
    expect(nativeAttempts).toBe(3);
  });

  test("returns 499 when the client cancels the canonical plaintext replay", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    const controller = new AbortController();
    let startReplay: (() => void) | undefined;
    const replayStarted = new Promise<void>(resolve => { startReplay = resolve; });
    let nativeAttempts = 0;
    globalThis.fetch = ((input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        return Promise.resolve(new Response(recoverySse("Return only ok."), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }));
      }
      nativeAttempts += 1;
      if (nativeAttempts <= 3) return Promise.resolve(new Response("original native failure", { status: 502 }));
      startReplay?.();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    }) as typeof fetch;

    const pending = post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
      controller.signal,
    );
    await replayStarted;
    controller.abort(new DOMException("client disconnected", "AbortError"));
    const response = await pending;

    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error: { code: "client_cancelled" } });
    expect(nativeAttempts).toBe(4);
  });

  test("treats the plaintext replay response as terminal", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    const replayBlob = `gAAAA${"B".repeat(128)}`;
    let nativeAttempts = 0;
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        return new Response(recoverySse("Return only ok."), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      nativeAttempts += 1;
      if (nativeAttempts <= 3) return new Response("original native failure", { status: 502 });
      return Response.json({
        error: {
          type: "invalid_request_error",
          code: "invalid_encrypted_content",
          message: "The encrypted content could not be verified.",
        },
      }, { status: 400 });
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      [
        { type: "reasoning", summary: [], encrypted_content: replayBlob },
        ...encryptedInput({ ciphertext: backendCiphertext }),
      ],
      codexHeaders(),
    );

    expect(response.status).toBe(400);
    expect(nativeAttempts).toBe(4);
  });

  test("keeps settled request options on the canonical plaintext replay", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    const forwardedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      if (body.includes("capture_assignment")) {
        return new Response(recoverySse("Return only ok."), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      forwardedBodies.push(JSON.parse(body) as Record<string, unknown>);
      if (forwardedBodies.length <= 3) return new Response("original native failure", { status: 502 });
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
      undefined,
      { service_tier: "priority" },
    );

    expect(response.status).toBe(200);
    expect(forwardedBodies).toHaveLength(4);
    expect(forwardedBodies.every(body => body.model === "gpt-5.5")).toBe(true);
    expect(forwardedBodies.every(body => body.service_tier === "priority")).toBe(true);
  });

});

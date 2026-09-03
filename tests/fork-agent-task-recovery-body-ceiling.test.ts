import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAgentTaskRecoveryState } from "../src/server/responses/agent-task-recovery";
import {
  codexHeaders,
  encryptedInput,
  originalFetch,
  post,
  recoverySse,
  routedConfig,
} from "./helpers/agent-task-recovery";

describe("fork agent task recovery body ceiling", () => {
  beforeEach(() => {
    resetAgentTaskRecoveryState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAgentTaskRecoveryState();
  });

  test("keeps the original native failure intact when the recovered plaintext replay exceeds the body ceiling", async () => {
    const backendCiphertext = `gAAAA${"A".repeat(128)}`;
    const plaintextAssignment = "x".repeat(2_048);
    const forwardedCiphertexts: string[] = [];
    let recoveryAttempts = 0;
    let originalResponseSignalAborted = false;

    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        recoveryAttempts += 1;
        return new Response(recoverySse(plaintextAssignment), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      forwardedCiphertexts.push(body);
      if (forwardedCiphertexts.length < 3) {
        return new Response("discarded native failure", { status: 502 });
      }
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const failOnAbort = () => {
            originalResponseSignalAborted = true;
            controller.error(signal?.reason ?? new DOMException("aborted", "AbortError"));
          };
          if (signal?.aborted) failOnAbort();
          else signal?.addEventListener("abort", failOnAbort, { once: true });
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("original native failure"));
            controller.close();
          }, 20);
        },
      }), { status: 502 });
    }) as typeof fetch;

    const config = routedConfig({ enabled: true });
    config.maxUpstreamBodyBytes = 1_024;
    const response = await post(
      config,
      "gpt-5.5",
      encryptedInput({ ciphertext: backendCiphertext }),
      codexHeaders(),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("original native failure");
    expect(forwardedCiphertexts).toHaveLength(3);
    expect(forwardedCiphertexts.every(body => body.includes(backendCiphertext))).toBe(true);
    expect(recoveryAttempts).toBe(1);
    expect(originalResponseSignalAborted).toBe(false);
  });
});

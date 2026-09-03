import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAgentTaskRecoveryState } from "../src/server/responses/agent-task-recovery";
import {
  codexHeaders,
  encryptedInput,
  originalFetch,
  post,
  providerResponse,
  recoverySse,
  routedConfig,
} from "./helpers/agent-task-recovery";

const BACKEND_CIPHERTEXT = `gAAAA${"A".repeat(128)}`;

describe("routed strict backend task recovery", () => {
  beforeEach(() => resetAgentTaskRecoveryState());

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAgentTaskRecoveryState();
  });

  test("recovers plaintext before dispatching a strict backend task to a third-party provider", async () => {
    const assignment = "Return only routed-ok.";
    let recoveryAttempts = 0;
    const routedBodies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        recoveryAttempts += 1;
        return new Response(recoverySse(assignment), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      routedBodies.push(body);
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "xai/grok-4.5",
      encryptedInput({ ciphertext: BACKEND_CIPHERTEXT }),
      codexHeaders(),
    );

    expect(response.status).toBe(200);
    expect(recoveryAttempts).toBe(1);
    expect(routedBodies).toHaveLength(1);
    expect(routedBodies[0]).toContain(assignment);
    expect(routedBodies[0]).not.toContain(BACKEND_CIPHERTEXT);
  });

  test("keeps strict backend tasks fail-closed when plaintext recovery fails", async () => {
    let recoveryAttempts = 0;
    let routedAttempts = 0;
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        recoveryAttempts += 1;
        return new Response("data: {\"type\":\"response.failed\"}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      routedAttempts += 1;
      return providerResponse();
    }) as typeof fetch;

    const response = await post(
      routedConfig({ enabled: true }),
      "xai/grok-4.5",
      encryptedInput({ ciphertext: BACKEND_CIPHERTEXT }),
      codexHeaders(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "unreadable_encrypted_agent_task" },
    });
    expect(recoveryAttempts).toBe(1);
    expect(routedAttempts).toBe(0);
  });
});

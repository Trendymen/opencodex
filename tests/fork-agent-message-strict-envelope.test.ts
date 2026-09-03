import { afterEach, describe, expect, test } from "bun:test";
import {
  handleResponses,
  hasUnreadableEncryptedAgentTask,
} from "../src/server/responses";
import {
  backendTaskCiphertextRuns,
  hasStrictBackendEncryptedAgentTask,
  structurallyValidFernetTokens,
} from "../src/server/responses/encrypted-payload";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

/**
 * Structurally faithful Fernet fixture: version + timestamp + IV + one AES-CBC
 * block + HMAC. Bytes are synthetic, so this validates wire shape without
 * publishing a real captured task or claiming the HMAC is authentic.
 */
function fernetFixture(ciphertextBytes = 16, version = 0x80): string {
  const raw = Buffer.alloc(57 + ciphertextBytes, 0x5a);
  raw[0] = version;
  raw.writeBigUInt64BE(1_720_000_000n, 1);
  const unpadded = raw.toString("base64url");
  return `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
}

const FERNET_TASK = fernetFixture();
const TOO_SHORT_FERNET = `gAAAA${"A".repeat(60)}`;
const INVALID_BLOCK_FERNET = fernetFixture(17);
const INVALID_VERSION_FERNET = fernetFixture(16, 0x81);
const BACKEND_TASK = `gAAAA${"A".repeat(128)}`;
const ROUTING_ENVELOPE = [
  "Message Type: NEW_TASK",
  "Task name: /root/worker",
  "Sender: /root",
  "Payload:",
  "",
].join("\n");

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function agentMessage(content: Array<Record<string, unknown>>): unknown[] {
  return [{
    type: "agent_message",
    author: "/root",
    recipient: "/root/worker",
    content,
  }];
}

function routedConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "test-xai-key",
      },
    },
  } as OcxConfig;
}

function nativeConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

function mixedComboConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "test-xai-key",
      },
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
    combos: {
      mixed: {
        strategy: "failover",
        targets: [
          { provider: "xai", model: "grok-4.5" },
          { provider: "openai", model: "gpt-5.5" },
        ],
      },
    },
  } as OcxConfig;
}

async function post(
  config: OcxConfig,
  model: string,
  input: unknown[],
  headers: HeadersInit = {},
): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
    body: JSON.stringify({ model, input, stream: false }),
  }), config, { model: "", provider: "" });
}

describe("fork V2 strict backend ciphertext envelope guard", () => {
  test("classifies a backend ciphertext only inside one strict current NEW_TASK envelope", () => {
    const strict = agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      { type: "encrypted_content", encrypted_content: BACKEND_TASK },
    ]);

    expect(structurallyValidFernetTokens(BACKEND_TASK)).toEqual([]);
    expect(backendTaskCiphertextRuns(`prefix ${BACKEND_TASK} suffix`)).toEqual([BACKEND_TASK]);
    expect(hasStrictBackendEncryptedAgentTask(strict)).toBe(true);
    expect(hasStrictBackendEncryptedAgentTask([
      { type: "reasoning", encrypted_content: BACKEND_TASK, summary: [] },
      { type: "compaction", encrypted_content: BACKEND_TASK },
    ])).toBe(false);
    expect(hasStrictBackendEncryptedAgentTask(agentMessage([
      { type: "input_text", text: `${ROUTING_ENVELOPE}plaintext payload` },
      { type: "encrypted_content", encrypted_content: BACKEND_TASK },
    ]))).toBe(false);
  });

  test("fails closed for backend ciphertext envelopes with mismatched routing or extra parts", () => {
    const wrongRecipient = agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      { type: "encrypted_content", encrypted_content: BACKEND_TASK },
    ]) as Array<{ recipient: string; content: Array<Record<string, unknown>> }>;
    wrongRecipient[0]!.recipient = "/root/other";
    const extraPart = agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      { type: "encrypted_content", encrypted_content: BACKEND_TASK },
      { type: "input_text", text: "not part of the header" },
    ]);

    expect(hasStrictBackendEncryptedAgentTask(wrongRecipient)).toBe(false);
    expect(hasStrictBackendEncryptedAgentTask(extraPart)).toBe(false);
  });

  test("rejects multiline whitespace inside the strict NEW_TASK header", () => {
    const malformedHeaders = [
      ROUTING_ENVELOPE.replace("Message Type: NEW_TASK", "Message Type:\nNEW_TASK"),
      ROUTING_ENVELOPE.replace("Task name: /root/worker", "\nTask name: /root/worker"),
      ROUTING_ENVELOPE.replace("Sender: /root", "Sender:\n/root"),
      ROUTING_ENVELOPE.replace("Payload:", "Payload:\n"),
    ];

    for (const text of malformedHeaders) {
      expect(hasStrictBackendEncryptedAgentTask(agentMessage([
        { type: "input_text", text },
        { type: "encrypted_content", encrypted_content: BACKEND_TASK },
      ]))).toBe(false);
    }
  });

  test("fails closed before dispatching backend ciphertext to a noncanonical route", async () => {
    const config = routedConfig();
    config.agentTaskRecovery = { enabled: true };
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("provider dispatch must not happen");
    }) as typeof fetch;

    const response = await post(config, "xai/grok-4.5", agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      { type: "encrypted_content", encrypted_content: BACKEND_TASK },
    ]));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "unreadable_encrypted_agent_task",
      },
    });
    expect(fetchCalls).toBe(0);
  });

  test("filters backend ciphertext combos to a canonical native target", async () => {
    const config = mixedComboConfig();
    config.agentTaskRecovery = { enabled: true };
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async input => {
      fetchedUrls.push(String(input));
      return Response.json({
        id: "resp_combo_backend_native",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const response = await post(config, "combo/mixed", agentMessage([
      { type: "input_text", text: ROUTING_ENVELOPE },
      { type: "encrypted_content", encrypted_content: BACKEND_TASK },
    ]), { authorization: "Bearer caller-codex-token" });

    expect(response.status).toBe(200);
    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain("chatgpt.com/backend-api/codex");
    expect(fetchedUrls[0]).not.toContain("api.x.ai");
  });

});

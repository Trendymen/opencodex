import { describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { originalFetch, FERNET_TASK, codexHeaders } from "../helpers/agent-task-recovery";

describe("pre-dispatch function-call ciphertext egress", () => {
  test("a poisoned replayed spawn call reaches the third-party Responses provider without ciphertext", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        id: "resp-fork-egress",
        object: "response",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const config = {
      defaultProvider: "third",
      providers: {
        third: {
          adapter: "openai-responses",
          baseUrl: "https://third.example.test/v1",
          authMode: "key",
          apiKey: "third-test-key",
        },
      },
    } as OcxConfig;

    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "run the review" }] },
      {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call-poisoned",
        arguments: JSON.stringify({ task_name: "v257_spec_review3", message: FERNET_TASK }),
      },
      { type: "function_call_output", call_id: "call-poisoned", output: "done" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ];
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...Object.fromEntries(codexHeaders().entries()),
        },
        body: JSON.stringify({ model: "third/model-a", input, stream: false, store: false }),
      }), config, logCtx);
      expect(response.status).toBe(200);
      expect(outbound).toHaveLength(1);
      const sent = outbound[0]?.input as Array<Record<string, unknown>>;
      const call = sent?.find(item => item.type === "function_call");
      const args = JSON.parse(String(call?.arguments)) as { message?: string; task_name?: string };
      expect(args.task_name).toBe("v257_spec_review3");
      expect(args.message).toBe("[encrypted content omitted]");
      expect(JSON.stringify(sent)).not.toContain(FERNET_TASK);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


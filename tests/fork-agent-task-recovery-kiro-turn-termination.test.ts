import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIRO_COMPLETION_TOOL_NAME } from "../src/adapters/kiro-constants";
import { saveConfig } from "../src/config";
import { encodeMessage } from "../src/lib/eventstream-decoder";
import { startServer } from "../src/server";
import { resetAgentTaskRecoveryState } from "../src/server/responses/agent-task-recovery";
import { clearRequestLogsForTests, getRequestLogEntries } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import {
  codexHeaders,
  encryptedInput,
  originalFetch,
  recoverySse,
} from "./helpers/agent-task-recovery";

const BACKEND_CIPHERTEXT = `gAAAA${"A".repeat(128)}`;
const THREAD_ID = "ben2-recovery-kiro-thread";
const ASSIGNMENT = "Return the recovered Kiro answer.";
const ANSWER = "Recovered Kiro answer complete.";
const TOOLS = [{
  type: "function",
  name: "bash",
  description: "Run a command",
  parameters: { type: "object" },
}];

const enc = new TextEncoder();
let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-ben2-recovery-kiro-"));
  process.env.OPENCODEX_HOME = testDir;
  clearRequestLogsForTests();
  resetAgentTaskRecoveryState();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAgentTaskRecoveryState();
  clearRequestLogsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(testDir, { recursive: true, force: true });
});

function eventFrame(eventType: string, payload: Record<string, unknown>): Uint8Array {
  return encodeMessage(
    { ":message-type": "event", ":event-type": eventType },
    enc.encode(JSON.stringify(payload)),
  );
}

function completionFrames(answer: string): Uint8Array[] {
  const input = JSON.stringify({ answer });
  return [
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "completion-1" }),
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "completion-1", input }),
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "completion-1", stop: true }),
  ];
}

function streamOf(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < frames.length) controller.enqueue(frames[index++]);
      else controller.close();
    },
  });
}

function scriptedKiroUpstream() {
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push(await req.json() as Record<string, unknown>);
      if (requests.length > 1) return new Response("unexpected extra Kiro attempt", { status: 500 });
      return new Response(streamOf(completionFrames(ANSWER)), {
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      });
    },
  });
  return { server, requests };
}

function kiroRecoveryConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "kiro-test",
    agentTaskRecovery: { enabled: true },
    providers: {
      "kiro-test": {
        adapter: "kiro",
        baseUrl,
        authMode: "key",
        apiKey: "synthetic-token",
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["gpt-5.6-sol"],
      },
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

async function postResponses(
  baseUrl: string,
  input: unknown[],
  headers: Headers,
): Promise<Response> {
  return originalFetch(new URL("/v1/responses", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(headers) },
    body: JSON.stringify({ model: "kiro-test/gpt-5.6-sol", input, stream: false, tools: TOOLS }),
  });
}

describe("recovered Kiro turn termination scope", () => {
  test("records a recovered final answer so a phase-less replay does not send Kiro again", async () => {
    const kiro = scriptedKiroUpstream();
    let proxy: ReturnType<typeof startServer> | undefined;

    try {
      saveConfig(kiroRecoveryConfig(kiro.server.url.toString()));
      globalThis.fetch = (async (input, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (body.includes("capture_assignment")) {
          return new Response(recoverySse(ASSIGNMENT), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      proxy = startServer(0);

      const first = await postResponses(
        proxy.url.toString(),
        encryptedInput({ ciphertext: BACKEND_CIPHERTEXT }),
        codexHeaders("acct-caller", { "thread-id": THREAD_ID }),
      );
      expect(first.status).toBe(200);
      const firstJson = await first.json() as {
        output?: Array<{ type?: string; role?: string; phase?: string; content?: Array<{ text?: string }> }>;
      };
      const final = firstJson.output?.find(item => item.type === "message"
        && item.role === "assistant" && item.phase === "final_answer");
      expect(final?.content?.map(part => part.text).join("")).toBe(ANSWER);

      const replay = await postResponses(
        proxy.url.toString(),
        [
          { type: "message", role: "user", content: [{ type: "input_text", text: ASSIGNMENT }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: ANSWER }] },
        ],
        codexHeaders("acct-caller", { "thread-id": THREAD_ID }),
      );
      expect(replay.status).toBe(200);
      await replay.text();

      expect(kiro.requests).toHaveLength(1);
      const entry = getRequestLogEntries().filter(row => row.provider === "kiro-test").at(-1);
      expect(entry).toBeDefined();
      expect(entry!.localTerminalReason).toBe("kiro_final_answer_already_delivered");
      expect(entry!.usageStatus).toBe("reported");
      expect(entry!.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      expect(entry!.usage?.estimated).toBeUndefined();
      expect(entry!.attempts).toHaveLength(1);
      expect(entry!.attempts![0]!.sendCount).toBe(0);
    } finally {
      try {
        if (proxy) await proxy.stop(true);
      } finally {
        kiro.server.stop(true);
      }
    }
  });

  test("routes every post-bind parsed replacement through the local adoption helper", () => {
    const source = readFileSync(new URL("../src/server/responses/core.ts", import.meta.url), "utf8");
    const postBindSource = source.slice(source.indexOf("bindTurnTerminationScope(parsed, resolvedConversationId);"));

    expect(postBindSource).not.toContain("parsed = reparsed;");
    expect(postBindSource).not.toContain("parsed = { ...parsed, context: reparsed.context");
    expect((postBindSource.match(/const\s+adoptParsedRequest\s*=\s*\(/g) ?? []).length).toBe(1);
    expect((postBindSource.match(/adoptParsedRequest\(/g) ?? []).length).toBe(2);
  });
});

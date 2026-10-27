import { describe, expect, test } from "bun:test";
import { createCodexPassthroughFixture, disabledCodexPassthrough } from "../helpers/codex-passthrough-fixture";
import { relaySseWithFailedTail, createSseInspector } from "../../src/server/relay";
import { relaySseEagerBounded } from "../../src/server/relay-eager";
import { item as hostedImage } from "../fixtures/hosted-image-display";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { markCodexPassthroughResponse, codexPassthroughResponsePermissions } from "../../src/fork/codex-passthrough-turn";
import { resolveCodexPassthroughPermissions } from "../../src/fork/codex-passthrough-contract";
import { repoRoot } from "../helpers/repo-root";
import { relayUnmodifiedCodexSse } from "../../src/fork/codex-passthrough-response";
import { handleResponses } from "../../src/server/responses/core";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { OcxConfig } from "../../src/types";
import { PROXY_KEY } from "../helpers/reserve-ingress-fixture";

const input = { model: "gpt-5.6-sol", stream: false, input: "synthetic request" };
const sparse = '{ "id": "resp_sparse", "status":"completed", "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}], "future":{"ordered":[3,1,2]} }';

test("raw relay releases its reader without waiting for producer cleanup", async () => {
  for (const ending of ["cancel", "terminal", "read-error"] as const) {
    let finishCancel!: () => void; const cleanup = new Promise<void>(resolve => { finishCancel = resolve; });
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({ start(controller) {
      if (ending === "terminal") controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'));
      if (ending === "read-error") controller.error(new Error("fixture read failure"));
    }, cancel() { cancelled++; return cleanup; } });
    const output = relayUnmodifiedCodexSse(source, new AbortController(), createSseInspector({}));
    try {
      if (ending === "cancel") await output.cancel();
      else if (ending === "terminal") await new Response(output).text();
      else await expect(new Response(output).text()).rejects.toThrow("fixture read failure");
      await Promise.resolve(); await Promise.resolve();
      expect(source.locked).toBe(false); expect(cancelled).toBe(ending === "read-error" ? 0 : 1);
    } finally { finishCancel(); }
  }
});

describe("official response permissions", () => {
  for (const mode of ["direct", "pool"] as const) for (const failure of ["input", "continuation"] as const) test(`prepared ${failure} refusals keep disabled response headers (${mode})`, async () => {
    const fixture = await createCodexPassthroughFixture({ mode, configure(config) {
      config.providers.openai!.contextWindow = 4096;
      config.providers.openai!.codexPassthrough = { addResponseRequestId: false, addResponseBrowserHeaders: false };
    }, upstream: async () => { throw new Error("local refusal must not send"); } });
    try {
      const request = failure === "input" ? { ...input, input: "x".repeat(100_000) }
        : { ...input, previous_response_id: "resp_missing_header_policy" };
      const response = await fixture.request(request); await response.text();
      expect(response.status).toBe(failure === "input" ? 413 : 400);
      expect(response.headers.get("x-opencodex-request-id")).toBeNull();
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(fixture.seen).toHaveLength(0);
    } finally { await fixture.close(); }
  });

  for (const mode of ["direct", "pool"] as const) test(`all off keeps sparse JSON and business headers (${mode})`, async () => {
    const fixture = await createCodexPassthroughFixture({ mode, configure(config) { config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); },
      upstream: async () => new Response(sparse, { headers: { "content-type": "application/json", "x-fixture": "retained", "access-control-allow-origin": "https://upstream.example.test" } }) });
    try {
      const response = await fixture.request(input);
      expect(await response.text()).toBe(sparse); expect(response.status).toBe(200);
      expect(response.headers.get("x-fixture")).toBe("retained");
      expect(response.headers.get("access-control-allow-origin")).toBe("https://upstream.example.test");
      expect(response.headers.get("x-opencodex-request-id")).toBeNull();
      expect(response.headers.get("access-control-expose-headers")).toBeNull();
    } finally { await fixture.close(); }
  });

  for (const status of [400, 429, 413, 500]) test(`${status}: all_off_keeps_413_wire_error_and_headers`, async () => {
    const text = '{ "error":{"type":"fixture_error","code":"fixture_code","message":"original details","api_key":"business value"}, "future":[1,3] }';
    const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) { config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); },
      upstream: async () => new Response(text, { status, headers: { "content-type": "application/json", "x-fixture": "retained" } }) });
    try {
      const response = await fixture.request(input);
      expect(response.status).toBe(status); expect(await response.text()).toBe(text);
      expect(response.headers.get("x-fixture")).toBe("retained");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("x-opencodex-request-id")).toBeNull();
    } finally { await fixture.close(); }
  });

  test("backfill alone restores its missing fields", async () => {
    const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
      config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), backfillResponseFields: true };
    }, upstream: async () => new Response(sparse, { headers: { "content-type": "application/json" } }) });
    try {
      const result = await (await fixture.request(input)).json() as any;
      expect(result.output[0].id).toBeString(); expect(result.output[0].status).toBe("completed");
      expect(result.output[0].content[0].annotations).toEqual([]); expect(result.future).toEqual({ ordered: [3, 1, 2] });
    } finally { await fixture.close(); }
  });

  test("tool repair alone keeps the canonical empty schema guard", async () => {
    const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "wait", namespace: "wait", arguments: '{"value":3}', status: "completed" };
    const payload = { id: "resp_tool_fixture", status: "completed", output: [call], future: [3, 1] };
    for (const enabled of [false, true]) {
      const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
        config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), repairResponseToolCalls: enabled };
      }, upstream: async () => Response.json(payload) });
      try {
        const result = await (await fixture.request({ ...input, tools: [{ type: "function", name: "wait", parameters: { type: "object", properties: { value: { type: "string" } } } }] })).json() as any;
        expect(result.output[0].namespace).toBe(enabled ? undefined : "wait"); expect(result.output[0].arguments).toBe('{"value":3}');
        expect(result.future).toEqual([3, 1]);
      } finally { await fixture.close(); }
    }
  });

  for (const id of [false, true]) for (const browser of [false, true]) test(`response header switches stay independent (${id}/${browser})`, async () => {
    const text = 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';
    const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
      config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), addResponseRequestId: id, addResponseBrowserHeaders: browser };
    }, upstream: async () => new Response(text, { headers: { "content-type": "text/event-stream", "x-fixture": "retained" } }) });
    try {
      const response = await fixture.request({ ...input, stream: true }); expect(await response.text()).toBe(text);
      expect(response.headers.has("x-opencodex-request-id")).toBe(id); expect(response.headers.has("access-control-allow-origin")).toBe(browser);
      expect((response.headers.get("access-control-expose-headers") ?? "").includes("x-opencodex-request-id")).toBe(id);
      expect(response.headers.get("x-fixture")).toBe("retained");
    } finally { await fixture.close(); }
  });

  test("all off keeps SSE missing fields and missing terminal without adding a tail", async () => {
    const text = 'event: response.output_item.done\r\ndata: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}}\r\n\r\nevent: future.fixture\ndata: {"type":"future.fixture","future":[3,1]}\n\n';
    const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) { config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); },
      upstream: async () => new Response(text, { headers: { "content-type": "text/event-stream" } }) });
    try { expect(await (await fixture.request({ ...input, stream: true })).text()).toBe(text); }
    finally { await fixture.close(); }
  });

  test("generic redaction is independent of fields and terminal synthesis", async () => {
    const payload = { type: "response.failed", response: { status: "failed", error: { code: "fixture_error", message: "token=caller_owned_fixture" }, future: [3, 1] } };
    for (const enabled of [false, true]) {
      const text = `event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`;
      const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
        config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), redactUpstreamErrors: enabled };
      }, upstream: async () => new Response(text, { headers: { "content-type": "text/event-stream" } }) });
      try {
        const output = await (await fixture.request({ ...input, stream: true })).text();
        if (enabled) expect(output).not.toContain("caller_owned_fixture"); else expect(output).toBe(text);
        expect(output).toContain("fixture_error"); expect(output).not.toContain("[DONE]");
      } finally { await fixture.close(); }
    }
  });

  for (const stream of [false, true]) test(`413 synthesis alone restores the old ${stream ? "SSE" : "JSON"} conversion`, async () => {
    const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
      config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), synthesizeTerminalFailure: true };
    }, upstream: async () => Response.json({ error: { code: "original_413" } }, { status: 413 }) });
    try {
      const response = await fixture.request({ ...input, stream });
      expect(response.status).toBe(stream ? 200 : 413);
      expect(await response.text()).toContain("context_length_exceeded");
    } finally { await fixture.close(); }
  });

  test("image display alone preserves its client guard and all-off keeps image items", async () => {
    for (const [enabled, client] of [[false, true], [true, true], [true, false]]) {
      const payload = { id: "resp_image_fixture", status: "completed", output: [hostedImage] };
      const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
        config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), normalizeHostedImages: enabled };
      }, upstream: async () => Response.json(payload) });
      try {
        const response = await fixture.request(input, client ? { originator: "codex_cli_rs", "user-agent": "codex_cli_rs/0.147.0" } : {});
        const output = await response.json() as any;
        expect(output.output[0].type).toBe(enabled && client ? "message" : "image_generation_call");
      } finally { await fixture.close(); }
    }
  });
});

describe("terminal synthesis permission", () => {
  for (const mode of ["legacy-tee", "eager-relay"] as const) test(`continuation caches the repaired client items (${mode})`, async () => {
    const completed = { id: `resp_cache_${mode}`, model: "gpt-5.6-sol", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "delivered fixture" }] }] };
    const text = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`;
    const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
      config.streamMode = mode; config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), backfillResponseFields: true, expandRequestHistory: true };
    }, upstream: async () => new Response(text, { headers: { "content-type": "text/event-stream" } }) });
    try {
      const headers = { session_id: "client-cache-fixture" };
      const first = await (await fixture.request({ ...input, stream: true }, headers)).text();
      const payload = first.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
        .find(event => event.type === "response.completed").response;
      expect(payload.output[0].id).toBeString(); expect(payload.output[0].content[0].annotations).toEqual([]);
      await (await fixture.request({ ...input, stream: true, input: "follow-up", previous_response_id: completed.id }, headers)).text();
      const replayed = (fixture.seen[1]!.body as { input: unknown[] }).input;
      expect(replayed).toContainEqual(payload.output[0]);
    } finally { await fixture.close(); }
  });

  test("relay can initialize as the first runtime module", () => {
    const cwd = repoRoot();
    const result = Bun.spawnSync([process.execPath, "--eval", 'import {createSseInspector} from "./src/server/relay.ts";console.log(typeof createSseInspector);'], { cwd, env: process.env });
    expect(result.exitCode).toBe(0); expect(new TextDecoder().decode(result.stdout).trim()).toBe("function");
  });
  test("combo failure keeps the selected official response policy and wire body", async () => {
    const policy = resolveCodexPassthroughPermissions(disabledCodexPassthrough());
    const text = '{ "error":{"code":"fixture_code","message":"original"},"future":[3,1] }';
    const source = markCodexPassthroughResponse(new Response(text, { status: 400, headers: { "content-type": "application/json", "x-fixture": "retained" } }), policy);
    const failure = await consumeComboFailure(source);
    expect(await failure.response.text()).toBe(text); expect(failure.upstreamCode).toBe("fixture_code");
    expect(failure.response.headers.get("x-fixture")).toBe("retained"); expect(codexPassthroughResponsePermissions(failure.response)).toBe(policy);
  });
  for (const eager of [false, true]) test(`${eager ? "eager" : "pull"}: raw EOF and reader errors keep their delivery failure`, async () => {
    for (const readerError of [false, true]) {
      const bytes = new TextEncoder().encode('data: {"type":"future.fixture","value":"partial"}\n\n');
      let read = false;
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        if (!read) { read = true; controller.enqueue(bytes); }
        else if (readerError) controller.error(new Error("synthetic upstream reset")); else controller.close();
      } });
      const inspector = createSseInspector({}); const upstream = new AbortController();
      const stream = eager ? relaySseEagerBounded(body, upstream, {
        inspectChunk: chunk => inspector.feed(chunk), finishInspection: () => inspector.finish(), disposeInspection: () => inspector.dispose(),
        sawTerminal: () => inspector.terminalSeen(), onSynthetic() {}, onClientCancel() {}, onDone() {},
      }, { synthesizeTerminalFailure: false }) : relaySseWithFailedTail(body, upstream, undefined, { synthesizeTerminalFailure: false });
      const reader = stream.getReader(); let received = ""; let failed = false;
      try { for (;;) { const next = await reader.read(); if (next.done) break; received += new TextDecoder().decode(next.value); } }
      catch { failed = true; } finally { await reader.cancel().catch(() => {}); inspector.dispose(); }
      expect(received).toBe(new TextDecoder().decode(bytes)); expect(failed).toBe(readerError);
    }
  });
});

for (const summary of ["retained progress", ""] as const) test(
  `pipeline compaction ${summary ? "delivery" : "invalid summary"} preserves selected response permissions`, async () => {
    let config!: OcxConfig;
    const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(current) {
      config = current;
      current.reasoningRetention = { enabled: true };
      current.providers.openai!.codexPassthrough = disabledCodexPassthrough();
    }, upstream: async () => new Response([
      { type: "response.output_text.delta", delta: summary },
      { type: "response.completed", response: { id: "resp_pipeline_retention", status: "completed", output: [] } },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }) });
    const budget = createTranslatorBudget();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { authorization: `Bearer ${PROXY_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ ...input, model: "openai/gpt-5.6-sol", input: [
          { type: "message", role: "user", content: "compact this conversation" },
          { type: "reasoning", summary: [{ type: "summary_text", text: "retained private reasoning" }] },
          { type: "compaction_trigger" },
        ] }),
      }), config, { model: "", provider: "" }, { translatorBudget: budget,
        compactionRoutingOverride: { sourceModel: "keyed/some-model" },
      });
      const payload = await response.json() as any;
      expect(response.status).toBe(summary ? 200 : 502);
      expect(fixture.seen).toHaveLength(1);
      if (summary) {
        expect(payload.output[0].type).toBe("compaction");
        expect(payload.output[0].encrypted_content).toStartWith("ocx2:");
      } else {
        expect(payload.error.type).toBe("server_error");
        expect(payload.error.code).toBe("upstream_server_error");
        expect(payload.error.message).toBe("Compaction returned an empty summary");
      }
      expect(codexPassthroughResponsePermissions(response)?.addResponseRequestId).toBe(false);
      expect(codexPassthroughResponsePermissions(response)?.addResponseBrowserHeaders).toBe(false);
    } finally { budget.dispose(); await fixture.close(); }
  });

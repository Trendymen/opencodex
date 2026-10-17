import { expect, test } from "bun:test";
import { normalizeResponsesWsRelayEvent } from "../../src/server/responses/codex-ws-wire";
import { sendResponseToWebSocket } from "../../src/server/ws-bridge";
import { markCodexPassthroughResponse, codexPassthroughResponsePermissions } from "../../src/fork/codex-passthrough-turn";
import { resolveCodexPassthroughPermissions } from "../../src/fork/codex-passthrough-contract";
import { createCodexPassthroughFixture, disabledCodexPassthrough } from "../helpers/codex-passthrough-fixture";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import { createCodexPrivateCredentialGuard, protectCodexPrivateSse } from "../../src/fork/codex-passthrough-secrets";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { handleResponses } from "../../src/server/responses/core";
import { PROXY_KEY } from "../helpers/reserve-ingress-fixture";
import type { OcxConfig } from "../../src/types";

const off = resolveCodexPassthroughPermissions(disabledCodexPassthrough());
for (const terminal of ["response.done", "response.failed"] as const) test(`combo preflight retains selected child permissions through final WS: ${terminal}`, async () => {
  let config!: OcxConfig;
  const error = { type: "server_error", code: "upstream_server_error", message: "fixture preflight failure" };
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  const payload = { type: terminal, response: { id: "resp_combo_raw", status: terminal === "response.done" ? "completed" : "failed",
    output: [], usage, ...(terminal === "response.failed" ? { error } : {}) } };
  const text = JSON.stringify(payload);
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(current) {
    config = current;
    current.providers.openai!.codexPassthrough = disabledCodexPassthrough();
    current.combos = { raw: { strategy: "failover", targets: [{ provider: "openai", model: "gpt-5.6-sol" }] } };
  }, upstream: async () => new Response(`event: ${terminal}\ndata: ${text}\n\n`, { headers: { "content-type": "text/event-stream" } }) });
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { authorization: `Bearer ${PROXY_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/raw", stream: true, input: "fixture combo input" }),
    }), config, { model: "", provider: "" }, { inboundTransport: "websocket" });
    const sent: string[] = []; const terminals: string[] = [];
    const socket = { data: {}, readyState: 1, send(value: string) { sent.push(value); return value.length; }, getBufferedAmount: () => 0 } as any;
    await sendResponseToWebSocket(socket, response, () => true, { onTerminal: value => terminals.push(value) });
    expect(fixture.seen).toHaveLength(1);
    if (terminal === "response.done") {
      expect(response.status).toBe(200); expect(sent).toEqual([text]); expect(terminals).toEqual(["completed"]);
    } else {
      expect(response.status).toBe(502); expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]!)).toMatchObject({ type: "error", status: 502, error, response: { error, response: { error, usage } } });
    }
    expect(codexPassthroughResponsePermissions(response)?.backfillResponseFields).toBe(false);
    expect(codexPassthroughResponsePermissions(response)?.synthesizeTerminalFailure).toBe(false);
  } finally { await fixture.close(); }
});

for (const mode of ["oversized", "stall", "cancel"] as const) test(`raw WS errors retain bounded read and cancellation (${mode})`, async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>; let cancelled = 0; let current = true;
  const source = new ReadableStream<Uint8Array>({ start(value) {
    controller = value;
    if (mode === "oversized") value.enqueue(new TextEncoder().encode("x".repeat(131_072)));
  }, cancel() { cancelled++; } });
  const response = markCodexPassthroughResponse(new Response(source, { status: 400 }), off);
  const sent: string[] = []; const closed: number[] = []; const terminals: string[] = [];
  const socket = { data: {}, readyState: 1, send(text: string) { sent.push(text); return text.length; },
    getBufferedAmount: () => 0, close(code: number) { closed.push(code); } } as any;
  const pending = sendResponseToWebSocket(socket, response, () => current, { onTerminal: value => terminals.push(value) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (mode === "cancel") socket.data.cancel?.();
    const settled = await Promise.race([pending.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), mode === "stall" ? 6500 : 250); })]);
    expect(settled).toBe(true); expect(cancelled).toBe(1); expect(sent).toEqual([]);
    expect(closed).toEqual(mode === "cancel" ? [] : [1011]);
    expect(terminals).toEqual(mode === "cancel" ? [] : ["failed"]);
    expect(source.locked).toBe(false); expect(socket.data.cancel).toBeUndefined();
  } finally {
    clearTimeout(timer); current = false;
    try { controller.close(); } catch {}
    await pending;
  }
}, 10_000);

for (const status of ["completed", "failed", "incomplete", "cancelled", "future_status", undefined]) {
  test(`raw_response_done_settles_without_extra_protocol_error: ${status ?? "missing"}`, async () => {
    const payload = { type: "response.done", response: { id: "resp_ws_fixture", ...(status === undefined ? {} : { status }), output: [], future: [3, 1] } };
    const text = JSON.stringify(payload);
    const normalized = normalizeResponsesWsRelayEvent(text, off)!;
    expect(normalized.text).toBe(text); expect(normalized.payload).toEqual(payload);
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`event: response.done\ndata: ${text}\n\n`)); }, cancel() { cancelled++; } });
    const response = markCodexPassthroughResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), off);
    const sent: string[] = []; const terminals: string[] = [];
    const socket = { data: {}, readyState: 1, send(value: string) { sent.push(value); return value.length; }, getBufferedAmount: () => 0 } as any;
    await sendResponseToWebSocket(socket, response, () => true, { onTerminal: value => terminals.push(value) });
    expect(sent).toEqual([text]); expect(terminals).toEqual([status === "completed" ? "completed" : status === "incomplete" || status === "cancelled" ? "incomplete" : "failed"]);
    expect(cancelled).toBe(1);
  });
}

test("raw upstream WS exchange keeps payload while settling its socket", async () => {
  const previous = globalThis.WebSocket;
  const source = JSON.stringify({ type: "response.done", response: { id: "resp_ws_exchange", status: "future_status", output: [], future: "retained" } });
  let closed = 0;
  class Socket extends EventTarget {
    static OPEN = 1; readyState = 0;
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
    send() { queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: source }))); }
    close() { if (this.readyState === 3) return; this.readyState = 3; closed++; this.dispatchEvent(new Event("close")); }
  }
  globalThis.WebSocket = Socket as any;
  let session: CodexWsSession | undefined;
  try {
    const url = "https://chatgpt.com/backend-api/codex/responses";
    const init = { method: "POST", body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: "synthetic" }) };
    session = new CodexWsSession("wss://fixture.example.test", {}); expect(session.reserve()).toBe(true);
    const response = await codexWsExchange({ session, url, init, prepared: prepareCodexWsRequest(url, init, off)!, permissions: off,
      sseFallback: (() => { throw new Error("unexpected HTTP fallback"); }) as typeof fetch });
    expect(await response.text()).toBe(`event: response.done\ndata: ${source}\n\n`);
    expect(session.closed).toBe(true); expect(closed).toBe(1);
    expect(normalizeResponsesWsRelayEvent(source)!.type).toBe("response.failed");
  } finally { session?.dispose(); globalThis.WebSocket = previous; }
});

test("WS private protection aborts delivery without an invented error event", async () => {
  for (const synthesizeTerminalFailure of [false, true]) {
    const budget = createTranslatorBudget(); const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
      sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget })!;
    const payload = '{"type":"future.fixture","value":"safe"}'; let next = 0; let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new TextEncoder().encode(next++ === 0 ? `data: ${payload}\n\n` : 'data: {"message":"synthetic-private\n\n')); }, cancel() { cancelled++; } });
    const response = markCodexPassthroughResponse(new Response(await protectCodexPrivateSse(source, guard, budget), { headers: { "content-type": "text/event-stream" } }), { ...off, synthesizeTerminalFailure });
    const sent: string[] = []; const closed: number[] = [];
    const socket = { data: {}, readyState: 1, send(value: string) { sent.push(value); return value.length; }, getBufferedAmount: () => 0, close(code: number) { closed.push(code); } } as any;
    try { await sendResponseToWebSocket(socket, response, () => true); expect(sent).toEqual([payload]); expect(closed).toEqual([1011]); expect(cancelled).toBe(1); expect(source.locked).toBe(false); }
    finally { budget.dispose(); }
  }
});

test("raw JSON WS framing does not backfill or succeed for missing and unknown status", async () => {
  for (const status of [undefined, "future_status"]) {
    const payload = { id: "resp_fixture", ...(status ? { status } : {}), output: [], future: [3, 1] };
    const response = markCodexPassthroughResponse(Response.json(payload), resolveCodexPassthroughPermissions(disabledCodexPassthrough()));
    const sent: string[] = []; const terminals: string[] = [];
    const socket = { data: {}, readyState: 1, send(text: string) { sent.push(text); return text.length; }, getBufferedAmount: () => 0 } as any;
    await sendResponseToWebSocket(socket, response, () => true, { onTerminal: status => terminals.push(status) });
    expect(terminals).toEqual(["failed"]); expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0]!).response).toEqual(payload);
  }
});

test("raw HTTP error WS framing retains unknown root fields and the complete body", async () => {
  const payload = { error: { code: "vendor_future", type: "vendor_quota", message: "vendor retained", future: [3, 1] }, future: { sequence: [3, 1, 2] } };
  for (const permissions of [off, resolveCodexPassthroughPermissions({ redactUpstreamErrors: false }), undefined]) {
    const response = markCodexPassthroughResponse(Response.json(payload, { status: 429 }), permissions);
    const sent: string[] = [];
    const socket = { data: {}, readyState: 1, send(text: string) { sent.push(text); return text.length; }, getBufferedAmount: () => 0 } as any;
    await sendResponseToWebSocket(socket, response, () => true);
    expect(sent.length).toBe(1); const frame = JSON.parse(sent[0]!);
    expect(frame.status).toBe(429); expect(frame.error).toEqual(payload.error);
    if (permissions) expect(frame.response).toEqual(payload);
    else expect(frame).not.toHaveProperty("response");
  }
});

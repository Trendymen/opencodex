import { expect, test } from "bun:test";
import { createCodexPassthroughFixture, disabledCodexPassthrough } from "../helpers/codex-passthrough-fixture";
import { ACCESS, PROXY_KEY, reserveIngressFixture } from "../helpers/reserve-ingress-fixture";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { createCodexPrivateCredentialGuard, protectCodexPrivateSse, readCodexPrivateErrorText } from "../../src/fork/codex-passthrough-secrets";
import { observeRequestLogsForTests, type RequestLogEntry } from "../../src/server/request-log";
import { sendResponseToWebSocket } from "../../src/server/ws-bridge";

const event = `data: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[],"message":"${ACCESS}"}}\n\n`;

test("disabled private deadline accepts a slow first event and still masks credentials", async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); config.stallTimeoutSec = 15;
  }, upstream: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode(event)); controller.close(); }, 5_150);
  }, cancel() { clearTimeout(timer); } }), { headers: { "content-type": "text/event-stream", "x-echo": ACCESS } }) });
  try { const response = await fixture.request({ model: "gpt-5.6-sol", stream: true, input: "synthetic" });
    expect(response.status).toBe(200); expect(response.headers.get("x-echo")).toBe("[REDACTED]");
    const text = await response.text(); expect(text).toContain("[REDACTED]"); expect(text).not.toContain(ACCESS);
    expect(fixture.seen).toHaveLength(1);
  } finally { clearTimeout(timer); await fixture.close(); }
}, 12_000);

test("enabled private deadline keeps the five second refusal and original upstream HTTP status", async () => {
  const entries: RequestLogEntry[] = []; const unobserve = observeRequestLogsForTests(entry => entries.push(entry));
  let cancelled = false;
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), privateSseReadDeadline: true };
    config.stallTimeoutSec = 15;
  }, upstream: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }) });
  try { const response = await fixture.request({ model: "gpt-5.6-sol", stream: true, input: "synthetic" }); await response.text();
    expect(response.status).toBe(502); expect(cancelled).toBe(true);
    expect(entries.at(-1)).toMatchObject({ upstreamHttpStatus: 200, errorCode: "private-sse-read-timeout", failureCause: "local-refusal",
      terminalSource: "synthetic", upstreamError: "Private SSE read deadline exceeded (5 seconds)." });
    expect(fixture.seen).toHaveLength(1);
  } finally { unobserve(); await fixture.close(); }
}, 12_000);

test("disabled private deadline holds a slow later partial event until its credentials are masked", async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prefix = 'data: {"type":"response.output_text.delta","delta":"safe"}\n\n';
  const secretEvent = `data: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[],"message":"${ACCESS}"}}\n\n`;
  const split = secretEvent.indexOf(ACCESS) + 7;
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); config.stallTimeoutSec = 15;
  }, upstream: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(prefix)); controller.enqueue(new TextEncoder().encode(secretEvent.slice(0, split)));
    timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode(secretEvent.slice(split))); controller.close(); }, 5_150);
  }, cancel() { clearTimeout(timer); } }), { headers: { "content-type": "text/event-stream" } }) });
  try { const response = await fixture.request({ model: "gpt-5.6-sol", stream: true, input: "synthetic" }); const reader = response.body!.getReader();
    let text = "";
    for (;;) { const next = await reader.read(); if (next.done) break; const chunk = new TextDecoder().decode(next.value);
      expect(chunk).not.toContain(ACCESS); text += chunk; }
    expect(text).toContain("safe"); expect(text).toContain("[REDACTED]"); expect(text).not.toContain(ACCESS); expect(fixture.seen).toHaveLength(1);
  } finally { clearTimeout(timer); await fixture.close(); }
}, 12_000);

test("private JSON refusal retains the original HTTP status and local failure attribution", async () => {
  const entries: RequestLogEntry[] = []; const unobserve = observeRequestLogsForTests(entry => entries.push(entry));
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
  }, upstream: async () => new Response('{"error":"unterminated', { status: 400, headers: { "content-type": "application/json" } }) });
  try { const response = await fixture.request({ model: "gpt-5.6-sol", stream: false, input: "synthetic" }); await response.text();
    expect(response.status).toBe(502); expect(entries.at(-1)).toMatchObject({ status: 502, upstreamHttpStatus: 400,
      errorCode: "private-invalid-json", failureCause: "local-refusal", terminalSource: "synthetic" });
    expect(entries.at(-1)?.attempts?.at(-1)).toMatchObject({ upstreamHttpStatus: 400, errorCode: "private-invalid-json" });
    expect(fixture.seen).toHaveLength(1);
  } finally { unobserve(); await fixture.close(); }
});

function privateStream() {
  const budget = createTranslatorBudget(); const guard = createCodexPrivateCredentialGuard({
    outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
    sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget })!;
  return { budget, guard };
}

test("disabled private deadline uses normal stall timeout without awaiting producer cancellation", async () => {
  const { budget, guard } = privateStream(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise(() => {}); } });
  try { await expect(protectCodexPrivateSse(body, guard, budget, { privateSseReadDeadline: false, stallTimeoutMs: 30 }))
    .rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancelled).toBe(true); expect(body.locked).toBe(false); expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});

test("private normal stall timeout pauses while the downstream consumer is paused", async () => {
  const { budget, guard } = privateStream(); let reads = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    controller.enqueue(new TextEncoder().encode(': safe\n\n')); if (++reads === 2) controller.close();
  } }, { highWaterMark: 0 });
  try { const protectedBody = await protectCodexPrivateSse(body, guard, budget, { privateSseReadDeadline: false, stallTimeoutMs: 30 });
    await Bun.sleep(60); expect(await new Response(protectedBody).text()).toBe(': safe\n\n: safe\n\n');
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});

test("empty chunks cannot evade normal stall when the private deadline is disabled", async () => {
  const { budget, guard } = privateStream(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(0)); }, cancel() { cancelled = true; } });
  try { await expect(protectCodexPrivateSse(body, guard, budget, { privateSseReadDeadline: false, stallTimeoutMs: 30 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  } finally { budget.dispose(); }
});

test("zero normal stall remains disabled and request abort still releases priming", async () => {
  const { budget, guard } = privateStream(); const abort = new AbortController(); const reason = new Error("synthetic cancellation");
  const body = new ReadableStream<Uint8Array>({}); const timer = setTimeout(() => abort.abort(reason), 40);
  try { await expect(protectCodexPrivateSse(body, guard, budget, { privateSseReadDeadline: false, stallTimeoutMs: 0, signal: abort.signal })).rejects.toBe(reason);
    expect(body.locked).toBe(false); expect(budget.snapshot().currentBytes).toBe(0);
  } finally { clearTimeout(timer); budget.dispose(); }
});

test("request abort during private priming preserves its reason", async () => {
  const { budget, guard } = privateStream(); const abort = new AbortController(); const reason = new Error("synthetic cancellation");
  const body = new ReadableStream<Uint8Array>({ cancel() { return new Promise(() => {}); } });
  const pending = protectCodexPrivateSse(body, guard, budget, { privateSseReadDeadline: false, stallTimeoutMs: 60_000, signal: abort.signal });
  abort.abort(reason);
  try { await expect(pending).rejects.toBe(reason); expect(body.locked).toBe(false); expect(budget.snapshot().currentBytes).toBe(0); }
  finally { budget.dispose(); }
});

test("upstream reset with a partial private block keeps the upstream error identity", async () => {
  const { budget, guard } = privateStream(); const reason = Object.assign(new Error("synthetic upstream reset"), { name: "SyntheticReset", code: "ECONNRESET" }); let offset = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset++ === 0) controller.enqueue(new TextEncoder().encode('data: {"message":"synthetic-')); else controller.error(reason);
  } });
  try { await expect(protectCodexPrivateSse(body, guard, budget)).rejects.toBe(reason); expect(budget.snapshot().currentBytes).toBe(0); }
  finally { budget.dispose(); }
});

test("upstream reader errors mask private credentials without becoming local protection failures", async () => {
  const { budget, guard } = privateStream();
  try { for (const sse of [false, true]) {
    const reason = new Error("synthetic upstream reset: synthetic-private");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(reason); } });
    const pending = sse ? protectCodexPrivateSse(body, guard, budget) : readCodexPrivateErrorText(new Response(body), guard);
    await expect(pending).rejects.toMatchObject({ message: "synthetic upstream reset: [REDACTED]" });
    try { await pending; } catch (error) { expect(error).not.toHaveProperty("code"); }
  } } finally { budget.dispose(); }
});

test("WS upstream read errors mask private codes after a complete event and partial data", async () => {
  for (const objectError of [false, true]) {
    const { budget, guard } = privateStream(); let next = 0;
    const reason = objectError ? { code: "synthetic-private", toString: () => "synthetic reset" }
      : Object.assign(new Error("synthetic reset"), { code: "synthetic-private" });
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (next++ === 0) controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"safe"}\n\n'));
      else if (next === 2) controller.enqueue(new TextEncoder().encode('data: {"message":"partial'));
      else controller.error(reason);
    } }, { highWaterMark: 0 });
    const frames: string[] = [];
    const socket = { data: {}, readyState: 1, send(text: string) { frames.push(text); return text.length; }, getBufferedAmount: () => 0 } as any;
    try { const protectedBody = await protectCodexPrivateSse(body, guard, budget);
      await sendResponseToWebSocket(socket, new Response(protectedBody, { headers: { "content-type": "text/event-stream" } }), () => true);
      expect(frames.join("\n")).not.toContain("synthetic-private");
      expect(JSON.parse(frames.at(-1)!)).toMatchObject({ type: "error", status: 502, error: { code: "[REDACTED]", message: "synthetic reset" } });
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { budget.dispose(); }
  }
});

test("private read error masking preserves safe names and codes and masks sensitive names", async () => {
  for (const field of ["message", "name", "code"] as const) {
    const { budget, guard } = privateStream();
    const reason = Object.assign(new Error("synthetic reset"), { name: "SyntheticReset", code: "ECONNRESET" }); reason[field] = "synthetic-private";
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(reason); } });
    try { const pending = protectCodexPrivateSse(body, guard, budget);
      await expect(pending).rejects.toMatchObject({ message: field === "message" ? "[REDACTED]" : "synthetic reset",
        name: field === "name" ? "[REDACTED]" : "SyntheticReset", code: field === "code" ? "[REDACTED]" : "ECONNRESET" });
    } finally { budget.dispose(); }
  }
});

test("private read errors mask a non-Error object's serialized message and keep its safe code", async () => {
  const { budget, guard } = privateStream();
  const reason = { name: "SyntheticReset", code: "ECONNRESET", toString: () => "synthetic reset: synthetic-private" };
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(reason); } });
  try { await expect(protectCodexPrivateSse(body, guard, budget)).rejects.toMatchObject({ name: "SyntheticReset", code: "ECONNRESET", message: "synthetic reset: [REDACTED]" }); }
  finally { budget.dispose(); }
});

test("private protection failure after HTTP commit is logged locally for direct and Combo requests", async () => {
  for (const combo of [false, true]) {
    const entries: RequestLogEntry[] = []; const unobserve = observeRequestLogsForTests(entry => entries.push(entry));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
      config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
      if (combo) config.combos = { fixture: { strategy: "failover", targets: [{ provider: "openai", model: "gpt-5.6-sol" }] } };
    }, upstream: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_fixture","status":"in_progress"}}\n\ndata: {"type":"response.output_text.delta","delta":"safe output"}\n\n'));
      timer = setTimeout(() => controller.enqueue(new TextEncoder().encode('data: {"message":"unterminated\n\n')), 100);
    }, cancel() { clearTimeout(timer); } }), { headers: { "content-type": "text/event-stream" } }) });
    try { const response = await fixture.request({ model: combo ? "combo/fixture" : "gpt-5.6-sol", stream: true, input: "synthetic" });
      expect(response.status).toBe(200); await expect(response.text()).rejects.toThrow();
      for (let i = 0; i < 50 && entries.length === 0; i++) await Bun.sleep(10);
      expect(entries.at(-1)).toMatchObject({ status: 502, upstreamHttpStatus: 200,
        errorCode: "private-invalid-json", failureCause: "local-refusal", terminalSource: "synthetic" });
      expect(fixture.seen).toHaveLength(1);
    } finally { clearTimeout(timer); unobserve(); await fixture.close(); }
  }
});

test("WS delivery logs a post-commit private refusal and closes without an invented error frame", async () => {
  const entries: RequestLogEntry[] = []; const unobserve = observeRequestLogsForTests(entry => entries.push(entry));
  let timer: ReturnType<typeof setTimeout> | undefined; let socket: WebSocket | undefined;
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
  }, upstream: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_ws_fixture","status":"in_progress"}}\n\n'));
    timer = setTimeout(() => controller.enqueue(new TextEncoder().encode('data: {"message":"unterminated\n\n')), 100);
  }, cancel() { clearTimeout(timer); } }), { headers: { "content-type": "text/event-stream" } }) });
  const frames: string[] = [];
  try {
    const closed = await new Promise<number>((resolve, reject) => {
      socket = new WebSocket(`${fixture.publicBase.replace("http:", "ws:")}/v1/responses`, { headers: { authorization: `Bearer ${PROXY_KEY}` } } as unknown as string[]);
      socket.addEventListener("open", () => socket!.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-sol", input: "synthetic", stream: true })));
      socket.addEventListener("message", event => frames.push(String(event.data)));
      socket.addEventListener("close", event => resolve(event.code));
      socket.addEventListener("error", () => reject(new Error("Fixture WS transport failed")));
    });
    expect(closed).toBe(1011); expect(frames.join("\n")).toContain("response.created");
    expect(frames.join("\n")).not.toContain("response.failed"); expect(frames.join("\n")).not.toContain(ACCESS);
    for (let i = 0; i < 50 && entries.length === 0; i++) await Bun.sleep(10);
    expect(entries.at(-1)).toMatchObject({ status: 502, upstreamHttpStatus: 200, errorCode: "private-invalid-json",
      failureCause: "local-refusal", terminalSource: "synthetic" });
    expect(fixture.seen).toHaveLength(1);
  } finally { socket?.close(); clearTimeout(timer); unobserve(); await fixture.close(); }
});

test("Direct stored-main private credentials remain protected with the read deadline disabled", async () => {
  const fixture = await reserveIngressFixture({ configure(config) {
    config.codexDesktopAuthless = false; config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
  } });
  const fixtureFetch = globalThis.fetch; let sends = 0;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== "https://chatgpt.com/backend-api/codex/responses") return fixtureFetch(input, init);
    sends++; expect(request.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
    return new Response(event, { headers: { "content-type": "text/event-stream" } });
  }, { preconnect() {} });
  try { const response = await fixture.request("public", "responses", "gpt-5.6-sol", { authorization: `Bearer ${PROXY_KEY}` }, { stream: true });
    expect(response.status).toBe(200); expect(response.text).toContain("[REDACTED]"); expect(response.text).not.toContain(ACCESS); expect(sends).toBe(1);
  } finally { await fixture.close(); }
});

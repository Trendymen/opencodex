import { readCodexPrivateErrorText } from "../../src/fork/codex-passthrough-secrets";
import { expect, test, spyOn } from "bun:test";
import { createCodexPassthroughFixture, disabledCodexPassthrough } from "../helpers/codex-passthrough-fixture";
import { ACCESS } from "../helpers/reserve-ingress-fixture";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { createCodexPrivateCredentialGuard, protectCodexPrivateSse, CodexPrivateCredentialProtectionError } from "../../src/fork/codex-passthrough-secrets";

const input = { model: "gpt-5.6-sol", stream: false, input: "synthetic" };
const escaped = (value: string) => [...value].map(letter => `\\u${letter.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");

test("pool private authentication echoes are protected in HTTP errors and headers", async () => {
  const text = `{"error":{"type":"fixture_error","code":"fixture_code","message":"${escaped(ACCESS)}","api_key":"business value"},"future":[3,1]}`;
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) { config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); },
    upstream: async () => new Response(text, { status: 400, headers: { "content-type": "application/json", "x-fixture-echo": ACCESS } }) });
  try {
    const response = await fixture.request(input); const result = await response.json() as any;
    expect(response.status).toBe(400); expect(response.headers.get("x-fixture-echo")).toBe("[REDACTED]");
    expect(result.error).toEqual({ type: "fixture_error", code: "fixture_code", message: "[REDACTED]", api_key: "business value" });
    expect(result.future).toEqual([3, 1]);
  } finally { await fixture.close(); }
});

test("pool_secret_is_masked_before_any_error_chunk_is_delivered", async () => {
  const logs: string[] = [];
  const spies = (["log", "warn", "error"] as const).map(method => spyOn(console, method).mockImplementation((...args) => { logs.push(args.map(String).join(" ")); }));
  const text = `: credential ${escaped(ACCESS)}\r\nevent: response.failed\r\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"fixture_code","message":"${escaped(ACCESS)}"}},"future":[3,1]}\r\n\r\n`;
  const fragments = [text.slice(0, 37), text.slice(37, 94), text.slice(94)];
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) { config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); },
    upstream: async () => { let next = 0; return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (next < fragments.length) controller.enqueue(new TextEncoder().encode(fragments[next++]!)); else controller.close();
    } }), { headers: { "content-type": "text/event-stream" } }); } });
  try {
    const response = await fixture.request({ ...input, stream: true }); const reader = response.body!.getReader(); let delivered = "";
    for (;;) { const next = await reader.read(); if (next.done) break; const chunk = new TextDecoder().decode(next.value);
      expect(chunk).not.toContain(ACCESS); expect(chunk).not.toContain(escaped(ACCESS)); delivered += chunk; }
    expect(delivered).not.toContain(ACCESS); expect(delivered).not.toContain(escaped(ACCESS));
    expect(delivered).toContain("[REDACTED]"); expect(delivered).toContain("fixture_code"); expect(delivered).not.toContain("[DONE]");
    expect(logs.join("\n")).not.toContain(ACCESS); expect(logs.join("\n")).not.toContain(escaped(ACCESS));
  } finally { await fixture.close(); for (const spy of spies) spy.mockRestore(); }
});

test("explicit sensitive configuration echoes are protected while caller-owned echoes stay raw", async () => {
  for (const privateValue of [false, true]) {
    const value = privateValue ? "synthetic-config-secret" : ACCESS;
    const text = JSON.stringify({ error: { code: "fixture_error", message: value } });
    const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
      config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
      if (privateValue) config.providers.openai!.headers = { "session-token": value };
    }, upstream: async () => new Response(text, { status: 500, headers: { "content-type": "application/json" } }) });
    try { expect(await (await fixture.request(input)).text()).toBe(privateValue ? JSON.stringify({ error: { code: "fixture_error", message: "[REDACTED]" } }) : text); }
    finally { await fixture.close(); }
  }
});

test("mixed-case configured headers protect each private value", async () => {
  const secret = "synthetic-private-one";
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
    config.providers.openai!.headers = { "session-token": secret, "Session-Token": "synthetic-private-two" };
  }, upstream: async request => {
    expect(request.headers.get("session-token")).toContain(secret); expect(request.headers.get("session-token")).toContain("synthetic-private-two");
    return Response.json({ error: { code: "retained", message: secret } }, { status: 400 });
  } });
  try { const response = await fixture.request(input); expect(await response.text()).not.toContain(secret); }
  finally { await fixture.close(); }
});

test("complete caller-owned mixed-case header groups do not start private protection", () => {
  const budget = createTranslatorBudget(); const outbound = { "session-token": "synthetic-private-one", "Session-Token": "synthetic-private-two" };
  try { expect(createCodexPrivateCredentialGuard({ outboundHeaders: outbound, callerHeaders: new Headers(outbound),
    sources: new Map([["session-token", "configuration"]] as const), translatorBudget: budget })).toBeUndefined(); }
  finally { budget.dispose(); }
});

test("partial caller ownership leaves only the other actual header value private", () => {
  const budget = createTranslatorBudget(); const outbound = { "session-token": "synthetic-private-one", "Session-Token": "  synthetic-private-two  " };
  try { const guard = createCodexPrivateCredentialGuard({ outboundHeaders: outbound, callerHeaders: new Headers({ "session-token": "synthetic-private-one" }),
    sources: new Map([["session-token", "configuration"]] as const), translatorBudget: budget })!;
    expect(guard.mask("synthetic-private-one, synthetic-private-two")).toBe("synthetic-private-one, [REDACTED]"); }
  finally { budget.dispose(); }
});

test("configured header protection matches the actual whitespace-normalized wire value", async () => {
  const secret = "synthetic-private";
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); config.providers.openai!.headers = { "session-token": `  ${secret}  ` };
  }, upstream: async request => { expect(request.headers.get("session-token")).toBe(secret);
    return Response.json({ error: { code: "retained", message: secret } }, { status: 400 }); } });
  try { const response = await fixture.request(input); expect(response.status).toBe(400); expect(await response.text()).not.toContain(secret); }
  finally { await fixture.close(); }
});

test("private SSE with no match preserves original chunk boundaries and releases its budget", async () => {
  const budget = createTranslatorBudget(); const chunks = ['data: {"type":"future.fixture",', '"future":[3,1]}\r\n\r\n', ': safe comment\n\n'].map(text => new TextEncoder().encode(text));
  const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
    sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget })!;
  let offset = 0; const body = new ReadableStream<Uint8Array>({ pull(controller) { if (offset < chunks.length) controller.enqueue(chunks[offset++]!); else controller.close(); } });
  const reader = (await protectCodexPrivateSse(body, guard, budget)).getReader(); const received: Uint8Array[] = [];
  try { for (;;) { const next = await reader.read(); if (next.done) break; received.push(next.value); }
    expect(received).toEqual(chunks); expect(budget.snapshot().currentBytes).toBe(0); expect(body.locked).toBe(false); }
  finally { await reader.cancel().catch(() => {}); budget.dispose(); }
});

test("private SSE refuses unsafe first blocks and budget overflow without emitting the secret", async () => {
  for (const text of ['data: {"type":"response.failed","error":"synthetic-private\n\n', 'data: {"type":"response.failed","message":"'+"x".repeat(1024)+'"}\n\n']) {
    const budget = createTranslatorBudget({ maxTurnBytes: 128 });
    const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
      sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget })!;
    let cancelled = 0; const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); }, cancel() { cancelled++; } });
    try { await expect(protectCodexPrivateSse(body, guard, budget)).rejects.toBeInstanceOf(CodexPrivateCredentialProtectionError);
      await Promise.resolve(); expect(cancelled).toBe(1); expect(budget.snapshot().currentBytes).toBe(0); expect(body.locked).toBe(false); }
    finally { budget.dispose(); }
  }
});

test("private SSE aborts an unsafe later block without a synthetic terminal", async () => {
  const budget = createTranslatorBudget(); const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
    sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget })!;
  const first = 'data: {"type":"future.fixture","value":"safe"}\n\n'; let offset = 0; let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new TextEncoder().encode(offset++ === 0 ? first : 'data: {"message":"synthetic-private\n\n')); }, cancel() { cancelled++; } });
  const reader = (await protectCodexPrivateSse(body, guard, budget)).getReader(); let output = ""; let failed: unknown;
  try { for (;;) { const next = await reader.read(); if (next.done) break; output += new TextDecoder().decode(next.value); } } catch (error) { failed = error; }
  finally { await reader.cancel().catch(() => {}); }
  expect(failed).toBeInstanceOf(CodexPrivateCredentialProtectionError); expect(output).toBe(first);
  expect(output).not.toContain("synthetic-private"); expect(output).not.toContain("response.failed"); expect(cancelled).toBe(1);
  expect(budget.snapshot().currentBytes).toBe(0); expect(body.locked).toBe(false); budget.dispose();
});

test("private SSE cancellation releases reader and retained chunks", async () => {
  const budget = createTranslatorBudget(); const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
    sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget })!;
  let cancelled = 0; const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(': safe\n\n')); }, cancel() { cancelled++; } });
  const protectedBody = await protectCodexPrivateSse(body, guard, budget); await protectedBody.cancel(); await Promise.resolve(); await Promise.resolve();
  expect(cancelled).toBe(1); expect(budget.snapshot().currentBytes).toBe(0); expect(body.locked).toBe(false); budget.dispose();
});

test("private SSE first-block deadline cancels a stalled reader", async () => {
  const budget = createTranslatorBudget(); const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
    sources: new Map([["authorization", "stored-main"]] as const), translatorBudget: budget })!;
  let cancelled = 0; const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"message":"synthetic-')); }, cancel() { cancelled++; } });
  try { await expect(protectCodexPrivateSse(body, guard, budget)).rejects.toBeInstanceOf(CodexPrivateCredentialProtectionError);
    await Promise.resolve(); expect(cancelled).toBe(1); expect(budget.snapshot().currentBytes).toBe(0); expect(body.locked).toBe(false); }
  finally { budget.dispose(); }
}, 12_000);

test("private guard preserves no-hit text and does not classify matching caller credentials as private", async () => {
  const { createCodexPrivateCredentialGuard } = await import("../../src/fork/codex-passthrough-secrets");
  const budget = createTranslatorBudget();
  try {
    const args = { outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
      sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget };
    const guard = createCodexPrivateCredentialGuard(args)!;
    const text = '{ "error": {"message":"ordinary","api_key":"business value"} }';
    expect(guard.protectJson(text)).toEqual({ changed: false, text });
    expect(guard.protectJson('{"error":{"message":"synthetic-\\u0070rivate","code":"fixture_code"}}').text)
      .toBe('{"error":{"message":"[REDACTED]","code":"fixture_code"}}');
    expect(createCodexPrivateCredentialGuard({ ...args, callerHeaders: new Headers({ authorization: "Bearer synthetic-private" }) })).toBeUndefined();
  } finally { budget.dispose(); }
});

test("private non-JSON error protection preserves unrelated escapes and line breaks", async () => {
  const original = 'code: fixture\nmessage: synthetic-\\u0070rivate\nquoted: "retained"\\path\\u0061\n';
  const header = 'quoted "retained" synthetic-\\u0070rivate\\path\\u0061';
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); config.providers.openai!.headers = { "session-token": "synthetic-private" };
  }, upstream: async () => new Response(original, { status: 400, headers: { "content-type": "text/plain", "x-fixture-echo": header } }) });
  try { const response = await fixture.request(input); expect(response.status).toBe(400);
    expect(await response.text()).toBe(original.replace('synthetic-\\u0070rivate', "[REDACTED]"));
    expect(response.headers.get("x-fixture-echo")).toBe(header.replace('synthetic-\\u0070rivate', "[REDACTED]"));
  } finally { await fixture.close(); }
});

test("continuous empty chunks retain the monotonic private deadline", async () => {
  const budget = createTranslatorBudget(); const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
    sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget })!;
  let time = 0; let reads = 0; const clock = spyOn(performance, "now").mockImplementation(() => time += 1000);
  const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(0)); } });
  try { await expect(protectCodexPrivateSse(body, guard, budget)).rejects.toBeInstanceOf(CodexPrivateCredentialProtectionError);
    expect(reads).toBeGreaterThan(1); expect(body.locked).toBe(false); expect(budget.snapshot().currentBytes).toBe(0); }
  finally { clock.mockRestore(); budget.dispose(); }
});

test("unsafe or oversized private HTTP errors fail safely before delivery", async () => {
  for (const text of ['{"error":"unterminated', JSON.stringify({ error: { message: "x".repeat(65_536) } }), new Uint8Array([0xc3, 0x28])]) {
    const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) { config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); },
      upstream: async () => new Response(text, { status: 400, headers: { "content-type": "application/json" } }) });
    try { const response = await fixture.request(input); expect(response.status).toBe(502); expect(await response.text()).toContain("upstream_error_protection_failed"); }
    finally { await fixture.close(); }
  }
});


test("duplicate JSON keys cannot hide an earlier private credential", () => {
  const budget = createTranslatorBudget(); const secret = "synthetic-private";
  const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: `Bearer ${secret}` }), callerHeaders: new Headers(),
    sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget })!;
  try { for (const earlier of [secret, "synthetic-\\u0070rivate"]) {
    const text = `{"error":{"message":"${earlier}","message":"ordinary","code":"retained"},"future":[3,1]}`;
    const result = guard.protectJson(text); expect(result.changed).toBe(true);
    expect(result.text).toBe('{"error":{"message":"[REDACTED]","message":"ordinary","code":"retained"},"future":[3,1]}');
  } } finally { budget.dispose(); }
});

test("invalid private error UTF-8 produces the safety error class", async () => {
  const budget = createTranslatorBudget(); const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
    sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget })!;
  try { await expect(readCodexPrivateErrorText(new Response(new Uint8Array([0xc3, 0x28]), { status: 400 }), guard)).rejects.toBeInstanceOf(CodexPrivateCredentialProtectionError); }
  finally { budget.dispose(); }
});

test("private cancel releases its lock before the producer settles", async () => {
  const budget = createTranslatorBudget(); const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
    sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget })!;
  let finishCancel!: () => void; const cancelled = new Promise<void>(resolve => { finishCancel = resolve; });
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(': safe\n\n')); }, cancel() { return cancelled; } });
  const protectedBody = await protectCodexPrivateSse(body, guard, budget);
  try { void protectedBody.cancel(); await Promise.resolve(); await Promise.resolve(); expect(body.locked).toBe(false); expect(budget.snapshot().currentBytes).toBe(0); }
  finally { finishCancel(); budget.dispose(); }
});

test("escaped private matching preserves ordinary text line structure", () => {
  const budget = createTranslatorBudget(); const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
    sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget })!;
  const text = 'code: fixture\nmessage: synthetic-\\u0070rivate\nquoted: "retained"\\path\n';
  try { expect(guard.mask(text)).toBe('code: fixture\nmessage: [REDACTED]\nquoted: "retained"\\path\n'); }
  finally { budget.dispose(); }
});



test("redirect body cannot expose the selected private credential", async () => {
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) { config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); },
    upstream: async () => new Response(JSON.stringify({ error: { code: "retained", message: ACCESS } }), { status: 302, headers: { "content-type": "application/json", "x-fixture": "retained" } }) });
  try { const response = await fixture.request({ model: "gpt-5.6-sol", stream: false, input: "synthetic" });
    expect(response.status).toBe(302); const text = await response.text(); expect(text).not.toContain(ACCESS); expect(text).toContain("[REDACTED]");
    expect(response.headers.get("x-fixture")).toBe("retained");
  } finally { await fixture.close(); }
});

test("default Combo failure cannot expose a private configured credential", async () => {
  const secret = "synthetic-private";
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.headers = { "session-token": secret };
    config.combos = { fixture: { strategy: "failover", targets: [{ provider: "openai", model: "gpt-5.6-sol" }] } };
  }, upstream: async () => Response.json({ error: { code: "retained", message: secret } }, { status: 400 }) });
  try { const response = await fixture.request({ model: "combo/fixture", stream: false, input: "synthetic" });
    expect(response.status).toBe(400); const text = await response.text(); expect(text).not.toContain(secret); expect(text).toContain("[REDACTED]");
  } finally { await fixture.close(); }
});

test("Combo consumes protected Retry-After headers before rebuilding a failure", async () => {
  for (const rawErrors of [false, true]) {
    const secret = "12345";
    const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
      config.providers.openai!.headers = { "session-token": secret };
      if (rawErrors) config.providers.openai!.codexPassthrough = { redactUpstreamErrors: false };
      config.combos = { fixture: { strategy: "failover", targets: [{ provider: "openai", model: "gpt-5.6-sol" }] } };
    }, upstream: async () => Response.json({ error: { code: "retained", message: "quota reached" } }, { status: 429, headers: { "retry-after": secret } }) });
    try { const response = await fixture.request({ ...input, model: "combo/fixture" });
      expect(response.status).toBe(429); expect(response.headers.get("retry-after")).not.toBe(secret);
      expect(await response.text()).not.toContain(secret); }
    finally { await fixture.close(); }
  }
});

test("private header names fail safely and cancel the original body", async () => {
  const secret = "synthetic-private"; let cancelled = 0;
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); config.providers.openai!.headers = { "session-token": secret };
  }, upstream: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{}')); }, cancel() { cancelled++; } }), {
    headers: { "content-type": "application/json", [`x-${secret}-credential`]: "retained" } }) });
  try { const response = await fixture.request(input); expect(response.status).toBe(502); expect(await response.text()).toContain("upstream_error_protection_failed");
    expect([...response.headers.keys()].join(" ")).not.toContain(secret); expect(cancelled).toBe(1); expect(fixture.seen.length).toBe(1); }
  finally { await fixture.close(); }
});

test("empty first chunks cannot disable the private prime deadline", async () => {
  const budget = createTranslatorBudget(); const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }), callerHeaders: new Headers(),
    sources: new Map([["authorization", "pool"]] as const), translatorBudget: budget })!;
  let cancelled = 0; let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; controller.enqueue(new Uint8Array(0)); }, cancel() { cancelled++; } });
  const timeout = setTimeout(() => source.error(new Error("fixture cleanup deadline")), 8_000); const started = performance.now();
  try { await expect(protectCodexPrivateSse(body, guard, budget)).rejects.toBeInstanceOf(CodexPrivateCredentialProtectionError);
    expect(performance.now() - started).toBeLessThan(7_000); expect(cancelled).toBe(1); expect(body.locked).toBe(false); expect(budget.snapshot().currentBytes).toBe(0); }
  finally { clearTimeout(timeout); budget.dispose(); }
}, 12_000);

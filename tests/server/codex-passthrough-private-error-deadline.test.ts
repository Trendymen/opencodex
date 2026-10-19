import { expect, jest, test } from "bun:test";
import * as comboFailure from "../../src/server/responses/core-combo-failure";
import { createCodexPassthroughFixture, disabledCodexPassthrough } from "../helpers/codex-passthrough-fixture";
import { ACCESS, PROXY_KEY, reserveIngressFixture } from "../helpers/reserve-ingress-fixture";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { updateAccountQuota } from "../../src/codex/quota";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { createCodexPrivateCredentialGuard, readCodexPrivateErrorText, codexPrivateErrorBodyReadDeadlines,
  CodexPrivateCredentialProtectionError } from "../../src/fork/codex-passthrough-secrets";
import { markCodexPassthroughResponse } from "../../src/fork/codex-passthrough-turn";
import { resolveCodexPassthroughPermissions } from "../../src/fork/codex-passthrough-contract";

function privateError() {
  const budget = createTranslatorBudget();
  const guard = createCodexPrivateCredentialGuard({ outboundHeaders: new Headers({ authorization: "Bearer synthetic-private" }),
    callerHeaders: new Headers(), sources: new Map([["authorization", "pool"]]), translatorBudget: budget })!;
  return { budget, guard };
}

test("Pool Combo uses normal stall when only the private error deadline is disabled", async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ingressFetch = globalThis.fetch;
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.codexPassthrough = { privateErrorBodyReadDeadline: false };
    config.stallTimeoutSec = 15;
    config.combos = { fixture: { strategy: "failover", targets: [{ provider: "openai", model: "gpt-5.6-sol" }] } };
  }, upstream: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: ACCESS } }))); controller.close(); }, 22_000);
  }, cancel() { clearTimeout(timer); } }), { status: 400, headers: { "content-type": "application/json", "x-echo": ACCESS } }) });
  try {
    const response = await ingressFetch(`${fixture.publicBase}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${PROXY_KEY}` },
      body: JSON.stringify({ model: "combo/fixture", input: "synthetic", stream: false }), signal: AbortSignal.timeout(35_000) });
    expect(response.status).toBe(400); const text = await response.text();
    expect(text).toContain("[REDACTED]"); expect(text).not.toContain(ACCESS);
    expect(response.headers.get("x-echo") ?? "").not.toContain(ACCESS); expect(fixture.seen).toHaveLength(1);
    expect(fixture.seen[0]!.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
  } finally { clearTimeout(timer); await fixture.close(); }
}, 35_000);

test.each([undefined, true])("private Combo deadline %s preserves the five second bounded read", async enabled => {
  jest.useFakeTimers(); const { budget, guard } = privateError(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  try {
    const pending = comboFailure.consumeComboFailure(new Response(body, { status: 400 }), undefined, undefined,
      (text, safe) => { if (!safe) throw new CodexPrivateCredentialProtectionError("private-body-unreadable"); return guard.mask(text); },
      undefined, codexPrivateErrorBodyReadDeadlines({ privateErrorBodyReadDeadline: enabled, stallTimeoutMs: 300_000 }));
    void pending.catch(() => {}); jest.advanceTimersByTime(5_000);
    await expect(pending).rejects.toMatchObject({ code: "private-body-unreadable" });
    expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  } finally { jest.useRealTimers(); budget.dispose(); }
});

test("disabled private Combo deadline retains the resolved first-byte stall", async () => {
  const { budget, guard } = privateError(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  try {
    await expect(comboFailure.consumeComboFailure(new Response(body, { status: 400 }), undefined, undefined,
      (text, safe) => { if (!safe) throw new CodexPrivateCredentialProtectionError("private-body-unreadable"); return guard.mask(text); },
      undefined, codexPrivateErrorBodyReadDeadlines({ privateErrorBodyReadDeadline: false, stallTimeoutMs: 25 })))
      .rejects.toMatchObject({ code: "private-body-unreadable" });
    expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  } finally { budget.dispose(); }
});

test("disabled private Combo deadline and zero stall still preserve caller abort identity", async () => {
  jest.useFakeTimers(); const { budget, guard } = privateError(); const abort = new AbortController();
  const reason = new Error("synthetic Combo caller abort"); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise(() => {}); } });
  try {
    const pending = comboFailure.consumeComboFailure(new Response(body, { status: 400 }), abort.signal, undefined,
      (text, safe) => { if (!safe) throw new CodexPrivateCredentialProtectionError("private-body-unreadable"); return guard.mask(text); },
      undefined, codexPrivateErrorBodyReadDeadlines({ privateErrorBodyReadDeadline: false, stallTimeoutMs: 0 }));
    void pending.catch(() => {}); jest.advanceTimersByTime(360_000); abort.abort(reason);
    await expect(pending).rejects.toBe(reason); expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  } finally { jest.useRealTimers(); budget.dispose(); }
});

test("Combo without a private guard keeps the shared read deadline despite a disabled permission", async () => {
  jest.useFakeTimers(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const response = markCodexPassthroughResponse(new Response(body, { status: 400 }),
    resolveCodexPassthroughPermissions({ privateErrorBodyReadDeadline: false }));
  try {
    const pending = comboFailure.consumeComboFailure(response);
    jest.advanceTimersByTime(5_000); const failure = await pending;
    expect(failure.response.status).toBe(400); expect(await failure.response.text()).toContain("Provider error 400");
    expect(failure.nonReplayable).toBeUndefined(); expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  } finally { jest.useRealTimers(); }
});

test.each([undefined, true])("private error deadline %s retains the five second limit", async enabled => {
  jest.useFakeTimers(); const { budget, guard } = privateError(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  try {
    const pending = readCodexPrivateErrorText(new Response(body), guard, undefined, { privateErrorBodyReadDeadline: enabled, stallTimeoutMs: 300_000 });
    void pending.catch(() => {});
    jest.advanceTimersByTime(5_000); await expect(pending).rejects.toMatchObject({ code: "private-body-timeout" });
    expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  } finally { jest.useRealTimers(); budget.dispose(); }
});

test("disabled private error deadline waits beyond five seconds and masks the completed JSON", async () => {
  jest.useFakeTimers(); const { budget, guard } = privateError(); let output!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
  try {
    const pending = readCodexPrivateErrorText(new Response(body, { headers: { "content-type": "application/json" } }), guard, undefined,
      { privateErrorBodyReadDeadline: false, stallTimeoutMs: 300_000 });
    output.enqueue(new TextEncoder().encode('{"error":"synthetic-')); await Promise.resolve();
    jest.advanceTimersByTime(6_000);
    output.enqueue(new TextEncoder().encode('private"}')); output.close();
    expect(await pending).toBe('{"error":"[REDACTED]"}'); expect(body.locked).toBe(false);
  } finally { jest.useRealTimers(); budget.dispose(); }
});

test.each([false, true])("disabled private error deadline enforces normal stall after first chunk=%s", async first => {
  const { budget, guard } = privateError(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { if (first) controller.enqueue(new TextEncoder().encode("prefix")); },
    cancel() { cancelled = true; } });
  try {
    await expect(readCodexPrivateErrorText(new Response(body), guard, undefined,
      { privateErrorBodyReadDeadline: false, stallTimeoutMs: 25 })).rejects.toMatchObject({ code: "private-body-timeout" });
    expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  } finally { budget.dispose(); }
});

test("zero normal stall leaves private error waiting until caller abort", async () => {
  jest.useFakeTimers(); const { budget, guard } = privateError(); const abort = new AbortController();
  const reason = new Error("synthetic caller abort"); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise(() => {}); } });
  try {
    const pending = readCodexPrivateErrorText(new Response(body), guard, abort.signal,
      { privateErrorBodyReadDeadline: false, stallTimeoutMs: 0 });
    void pending.catch(() => {});
    jest.advanceTimersByTime(360_000); abort.abort(reason); await expect(pending).rejects.toBe(reason);
    expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  } finally { jest.useRealTimers(); budget.dispose(); }
});

test.each(["size", "utf8", "json"])("disabled private error deadline preserves %s protection", async kind => {
  const { budget, guard } = privateError();
  const bytes = kind === "size" ? new Uint8Array(65_537) : kind === "utf8" ? new Uint8Array([0xff]) : new TextEncoder().encode('{"error":');
  try {
    await expect(readCodexPrivateErrorText(new Response(bytes, { headers: { "content-type": "application/json" } }), guard, undefined,
      { privateErrorBodyReadDeadline: false, stallTimeoutMs: 0 })).rejects.toMatchObject({
      code: kind === "size" ? "private-oversized" : kind === "utf8" ? "private-invalid-utf8" : "private-invalid-json",
    });
  } finally { budget.dispose(); }
});

test.each(["main-pool", "stored-pool"])("%s credentials deliver a slow HTTP error with its upstream status", async mode => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poolToken = mode === "stored-pool" ? fakeChatGptJwt({ exp: 4_000_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-pool-account" } }) : ACCESS;
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.codexDesktopAuthless = false;
    config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), privateErrorBodyReadDeadline: false };
    config.stallTimeoutSec = 15;
    if (mode === "stored-pool") {
      config.activeCodexAccountId = "synthetic-timeout-pool"; config.pausedCodexAccountIds = ["__main__"];
      config.codexAccounts = [{ id: "synthetic-timeout-pool", plan: "pro", isMain: false, chatgptAccountId: "synthetic-pool-account" }];
      saveCodexAccountCredential("synthetic-timeout-pool", { accessToken: poolToken, refreshToken: "synthetic-refresh",
        expiresAt: 4_000_000_000_000, chatgptAccountId: "synthetic-pool-account" });
      updateAccountQuota("synthetic-timeout-pool", 10);
    }
  }, upstream: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: poolToken } }))); controller.close(); }, 5_150);
  }, cancel() { clearTimeout(timer); } }), { status: 400, headers: { "content-type": "application/json", "x-echo": poolToken } }) });
  try {
    const response = await fixture.request({ model: "gpt-5.6-sol", input: "synthetic", stream: false }, { authorization: `Bearer ${PROXY_KEY}` });
    expect(response.status).toBe(400); expect(response.headers.get("x-echo")).toBe("[REDACTED]");
    expect(await response.text()).toBe('{"error":{"message":"[REDACTED]"}}'); expect(fixture.seen).toHaveLength(1);
    expect(fixture.seen[0]!.headers.get("authorization")).toBe(`Bearer ${poolToken}`);
  } finally { clearTimeout(timer); await fixture.close(); }
}, 12_000);

test("Direct stored-main credentials deliver a slow HTTP error without the fixed deadline", async () => {
  const fixture = await reserveIngressFixture({ configure(config) {
    config.codexDesktopAuthless = false; config.stallTimeoutSec = 15;
    config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), privateErrorBodyReadDeadline: false };
  } });
  const fixtureFetch = globalThis.fetch; let timer: ReturnType<typeof setTimeout> | undefined; let sends = 0;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== "https://chatgpt.com/backend-api/codex/responses") return fixtureFetch(input, init);
    sends++; expect(request.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: ACCESS } }))); controller.close(); }, 5_150);
    }, cancel() { clearTimeout(timer); } }), { status: 400, headers: { "content-type": "application/json" } });
  }, { preconnect() {} });
  try {
    const response = await fixture.request("public", "responses", "gpt-5.6-sol", { authorization: `Bearer ${PROXY_KEY}` });
    expect(response.status).toBe(400); expect(response.text).toBe('{"error":{"message":"[REDACTED]"}}'); expect(sends).toBe(1);
  } finally { clearTimeout(timer); await fixture.close(); }
}, 12_000);

import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { codexWsUpstreamFetch, CODEX_WS_LIVENESS_PING_INTERVAL_MS, CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS,
  MAX_CODEX_WS_FRAME_BYTES } from "../../src/server/responses/ws-upstream";
import { providerFetch, fetchWithHeaderTimeout } from "../../src/server/responses/fetch-helpers";
import { captureCodexPassthroughTurn, resolveCodexPassthroughAttempt } from "../../src/fork/codex-passthrough-turn";
import { resolveCodexPassthroughPermissions } from "../../src/fork/codex-passthrough-contract";
import { streamingInit, BOUNDED_WS_RUNTIME } from "../helpers/ws-upstream-fixtures";
import type { OcxProviderConfig } from "../../src/types";

const URL = "https://chatgpt.com/backend-api/codex/responses";
class SilentSocket extends EventTarget {
  static current: SilentSocket;
  readyState = 0; sent = 0; pings = 0; pong = false;
  constructor() { super(); SilentSocket.current = this; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
  send() { this.sent++; }
  ping() { this.pings++; if (this.pong) this.dispatchEvent(new Event("pong")); }
  message(value: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data: typeof value === "string" ? value : JSON.stringify(value) })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 })); }
}
const realSocket = globalThis.WebSocket;
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let proxyEnv: Record<string, string | undefined>;
let http = 0;
const fallback = Object.assign(async () => { http++; return new Response("HTTP fallback"); }, { preconnect() {} }) as typeof fetch;
beforeEach(() => {
  proxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  globalThis.WebSocket = SilentSocket as unknown as typeof WebSocket; http = 0; jest.useFakeTimers();
});
afterEach(() => {
  SilentSocket.current?.close(); globalThis.WebSocket = realSocket; jest.useRealTimers();
  for (const key of proxyKeys) { if (proxyEnv[key] === undefined) delete process.env[key]; else process.env[key] = proxyEnv[key]; }
});
function start(enabled?: boolean, signal?: AbortSignal) {
  return codexWsUpstreamFetch(URL, { ...streamingInit(), signal }, fallback, BOUNDED_WS_RUNTIME,
    undefined, undefined, undefined, undefined, undefined, undefined,
    resolveCodexPassthroughPermissions({ upstreamWsSilenceDeadline: enabled }));
}
async function opened() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); return SilentSocket.current; }
function silence(ms: number) { for (let elapsed = 0; elapsed < ms; elapsed += CODEX_WS_LIVENESS_PING_INTERVAL_MS) jest.advanceTimersByTime(CODEX_WS_LIVENESS_PING_INTERVAL_MS); }
function complete(ws: SilentSocket) { ws.message({ type: "response.completed", response: { id: "r1", status: "completed", output: [] } }); }

test.each([undefined, true])("WS silence setting %s keeps the local 504 without resending", async enabled => {
  const pending = start(enabled); const ws = await opened(); silence(CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS);
  const response = await pending;
  expect(response.status).toBe(504); expect(await response.text()).toContain("prelude timed out");
  expect(ws.sent).toBe(1); expect(http).toBe(0); expect(ws.readyState).toBe(3);
});
test("disabled WS silence deadline waits beyond ninety seconds while retaining pings", async () => {
  const pending = start(false); const ws = await opened(); silence(105_000); complete(ws);
  const response = await pending;
  expect(response.status).toBe(200); expect(await response.text()).toContain("response.completed");
  expect(ws.pings).toBe(7); expect(ws.sent).toBe(1); expect(http).toBe(0);
});
test("pong keeps the default silence deadline waiting", async () => {
  const pending = start(); const ws = await opened(); ws.pong = true; silence(105_000); complete(ws);
  expect((await pending).status).toBe(200); expect(ws.sent).toBe(1); expect(http).toBe(0);
});
test("disabled WS silence deadline still cancels on caller abort", async () => {
  const abort = new AbortController(); const reason = new Error("synthetic caller abort");
  const pending = start(false, abort.signal); void pending.catch(() => {});
  const ws = await opened(); silence(105_000); abort.abort(reason); await expect(pending).rejects.toBe(reason);
  expect(ws.readyState).toBe(3); expect(ws.sent).toBe(1); expect(http).toBe(0);
});
test("disabled WS silence deadline still obeys the real fetch header connect timer", async () => {
  const provider: OcxProviderConfig = { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", fetch: fallback };
  const executor = providerFetch(provider, BOUNDED_WS_RUNTIME, { codexPassthroughPermissions: resolveCodexPassthroughPermissions({ upstreamWsSilenceDeadline: false }) });
  const pending = fetchWithHeaderTimeout(URL, streamingInit(), new AbortController().signal, 120_000, false, executor);
  const ws = await opened(); silence(105_000); jest.advanceTimersByTime(15_000);
  const response = await pending;
  expect(response.status).toBe(504); expect(await response.text()).toContain("connect deadline");
  expect(ws.sent).toBe(1); expect(http).toBe(0); expect(ws.readyState).toBe(3);
});
test("disabled WS silence deadline preserves oversized frame refusal", async () => {
  const pending = start(false); const ws = await opened(); ws.message("x".repeat(MAX_CODEX_WS_FRAME_BYTES + 1));
  expect((await pending).status).toBe(502); expect(ws.readyState).toBe(3); expect(http).toBe(0);
});
test.each(["direct", "pool"] as const)("%s resolves timeout overrides only on canonical native forward destinations", mode => {
  const provider: OcxProviderConfig = { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex",
    codexAccountMode: mode, codexPassthrough: { upstreamWsSilenceDeadline: false, privateErrorBodyReadDeadline: false } };
  const turn = captureCodexPassthroughTurn({ official: provider }, "responses");
  const destination = { providerName: "official", provider, inboundWire: "responses" as const };
  expect(resolveCodexPassthroughAttempt(turn, destination)).toMatchObject({ upstreamWsSilenceDeadline: false, privateErrorBodyReadDeadline: false });
  for (const outside of [{ ...provider, authMode: "key" as const }, { ...provider, baseUrl: "https://gateway.example.test/v1" }, { ...provider, adapter: "openai-chat" }]) {
    expect(resolveCodexPassthroughAttempt(turn, { ...destination, provider: outside })).toBeUndefined();
  }
  expect(resolveCodexPassthroughAttempt(turn, { ...destination, inboundWire: "chat" })).toBeUndefined();
});

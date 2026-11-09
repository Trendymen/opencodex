import { expect, test } from "bun:test";
import { createCodexPassthroughFixture, disabledCodexPassthrough } from "../helpers/codex-passthrough-fixture";
import { resolveCodexPassthroughPermissions } from "../../src/fork/codex-passthrough-contract";
import { fetchWithResetRetry, isNonReplayableResponse, isReplayRefusalResponse, SendBudgetExhaustedError, UpstreamRetryEvidenceError, preserveCodexReplacementFailure } from "../../src/lib/upstream-retry";
import { waitForProviderRequestSlot, setProviderRequestPacingLimitsForTest, resetProviderRequestPacingForTest, providerRequestPacingStatus } from "../../src/providers/request-pacing";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { decideCodexLocalError, codexLocalGatewayResponse, codexLocalFailure } from "../../src/fork/codex-passthrough-local-errors";
import { codexWsPreResponseFailure } from "../../src/server/responses/codex-ws-wire";
import { sendResponseToWebSocket } from "../../src/server/ws-bridge";
import { markCodexPassthroughResponse, captureCodexPassthroughTurn } from "../../src/fork/codex-passthrough-turn";
import { routedCodexPassthroughPermissions } from "../../src/fork/codex-passthrough-routing";
import { updateAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { PROXY_KEY } from "../helpers/reserve-ingress-fixture";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { handleResponses } from "../../src/server/responses";
import { BOUNDED_WS_RUNTIME } from "../helpers/ws-upstream-fixtures";

const input = { model: "gpt-5.6-sol", input: "synthetic request", store: false, stream: false };
const reset = () => Object.assign(new Error("fixture socket reset"), { code: "ECONNRESET" });

test("classified protection exclusions and reset priority use explicit origins", () => {
  const off = resolveCodexPassthroughPermissions(disabledCodexPassthrough());
  for (const reason of ["real-upstream", "agent-task-recovery", "hard-budget", "auth", "identity", "account-policy"] as const) {
    expect(decideCodexLocalError(off, { kind: "protected", reason })).toEqual({ kind: "legacy" });
  }
  const permission = resolveCodexPassthroughPermissions({ localErrorPolicies: { resetReplayRefusal: false, transportErrorMapping: true } });
  expect(decideCodexLocalError(permission, { kind: "reset-refusal", reason: "reset", sentAmbiguously: true }))
    .toEqual({ kind: "gateway", status: 502, addCodexExplanation: true, source: "local-transport" });
  expect(decideCodexLocalError(undefined, { kind: "pacing" })).toEqual({ kind: "legacy" });
});

test("WS pre-response transport mapping off preserves a gateway without a Codex explanation", async () => {
  const permissions = resolveCodexPassthroughPermissions({ localErrorPolicies: { transportErrorMapping: false } });
  const response = codexWsPreResponseFailure(504, "old Codex explanation", new Headers(), permissions);
  expect(response.status).toBe(504); expect(isNonReplayableResponse(response)).toBe(true);
  expect(await response.text()).toBe("Gateway Timeout");
});

test("local gateway with transport mapping off closes native WS without a generated error frame", async () => {
  const permissions = resolveCodexPassthroughPermissions({ localErrorPolicies: { transportErrorMapping: false } });
  const failure = { kind: "transport", reason: "connection" } as const;
  const decision = decideCodexLocalError(permissions, failure); expect(decision.kind).toBe("gateway");
  if (decision.kind !== "gateway") throw new Error("fixture gateway decision absent");
  const response = markCodexPassthroughResponse(codexLocalGatewayResponse(decision, failure), permissions);
  const sent: string[] = []; const closed: number[] = [];
  const socket = { data: {}, readyState: 1, send(text: string) { sent.push(text); return text.length; }, close(code: number) { closed.push(code); }, getBufferedAmount: () => 0 } as any;
  await sendResponseToWebSocket(socket, response, () => true);
  expect(sent).toEqual([]); expect(closed).toEqual([1011]);
});

for (const refusal of [false, true]) for (const mapping of [false, true]) test(`reset refusal and mapping stay independent (${refusal}/${mapping})`, async () => {
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    config.providers.openai!.codexPassthrough = { localErrorPolicies: { resetReplayRefusal: refusal, transportErrorMapping: mapping } };
  }, upstream: async () => { throw reset(); } });
  try { const response = await fixture.request(input); expect(response.status).toBe(refusal ? 429 : 502);
    expect(response.headers.get("x-should-retry")).toBe(refusal ? "false" : null);
    const text = await response.text(); expect(text.includes("upstream_reset_replay_refused")).toBe(refusal);
    if (!refusal && !mapping) expect(text).toBe("Bad Gateway");
    expect(fixture.seen.length).toBe(1);
  } finally { await fixture.close(); }
});

test("reset_false_transport_true_never_restores_local_429 after an authorized timeout replacement", async () => {
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    config.providers.openai!.retryOnReset = {};
    config.providers.openai!.codexPassthrough = { localErrorPolicies: { resetReplayRefusal: false, transportErrorMapping: true } };
  }, upstream: async () => { if (sent++ === 0) throw reset(); throw new DOMException("fixture timeout", "TimeoutError"); } });
  let sent = 0;
  try { const response = await fixture.request(input); expect(response.status).toBe(504);
    expect(response.headers.get("x-should-retry")).toBeNull(); expect(await response.text()).not.toContain("upstream_reset_replay_refused");
    expect(fixture.seen.length).toBe(2);
  } finally { await fixture.close(); }
});

test("a real replacement 429 keeps its wire response with all optional processing off", async () => {
  let sent = 0; const text = '{ "error": { "code": "fixture_quota", "message": "real upstream quota" }, "future": [3,1] }';
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    config.providers.openai!.retryOnReset = {}; config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
  }, upstream: async () => { if (sent++ === 0) throw reset(); return new Response(text, { status: 429,
    headers: { "content-type": "application/json", "retry-after": "60", "x-fixture": "retained" } }); } });
  try { const response = await fixture.request(input); expect(response.status).toBe(429); expect(await response.text()).toBe(text);
    expect(response.headers.get("retry-after")).toBe("60"); expect(response.headers.get("x-should-retry")).toBeNull(); expect(fixture.seen.length).toBe(2);
  } finally { await fixture.close(); }
});

test("Combo keeps a local transport gateway without adding its Codex error explanation", async () => {
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    config.providers.openai!.codexPassthrough = { localErrorPolicies: { transportErrorMapping: false } };
    config.combos = { fixture: { strategy: "failover", targets: [{ provider: "openai", model: input.model }] } };
  }, upstream: async () => { throw Object.assign(new Error("fixture refused"), { code: "ECONNREFUSED" }); } });
  try { const response = await fixture.request({ ...input, model: "combo/fixture" }); expect(response.status).toBe(502);
    expect(await response.text()).toBe("Bad Gateway"); expect(fixture.seen.length).toBe(1);
  } finally { await fixture.close(); }
});

test("reset delivery keeps internal nonReplayable evidence and the same send budget", async () => {
  let sends = 0; const permissions = resolveCodexPassthroughPermissions({ localErrorPolicies: { resetReplayRefusal: false, transportErrorMapping: false } });
  const response = await fetchWithResetRetry(async () => { sends++; throw reset(); }, { attempts: 3, codexPassthroughPermissions: permissions });
  expect(response.status).toBe(502); expect(isNonReplayableResponse(response)).toBe(true); expect(isReplayRefusalResponse(response)).toBe(true);
  expect(sends).toBe(1); expect(response.headers.get("x-should-retry")).toBeNull();
  await expect(fetchWithResetRetry(async () => { sends++; return new Response("unused"); }, { attempts: 0, codexPassthroughPermissions: permissions })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
  expect(sends).toBe(1);
});

for (const timeout of [false, true]) test(`disabled transport mapping uses only the necessary gateway failure (${timeout})`, async () => {
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    config.providers.openai!.codexPassthrough = { localErrorPolicies: { transportErrorMapping: false } };
  }, upstream: async () => { throw timeout ? new DOMException("fixture timeout", "TimeoutError") : Object.assign(new Error("fixture refused"), { code: "ECONNREFUSED" }); } });
  try { const response = await fixture.request(input); expect(response.status).toBe(timeout ? 504 : 502);
    expect(await response.text()).toBe(timeout ? "Gateway Timeout" : "Bad Gateway"); expect(fixture.seen.length).toBe(1);
  } finally { await fixture.close(); }
});

test("real upstream 429 with the same replay code keeps its own wire provenance", async () => {
  const text = '{"error":{"code":"upstream_reset_replay_refused","message":"real upstream response"}}';
  const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream: async () => new Response(text, {
    status: 429, headers: { "content-type": "application/json", "retry-after": "60", "x-fixture": "retained" },
  }) });
  try { const response = await fixture.request(input); expect(response.status).toBe(429); expect(await response.text()).toBe(text);
    expect(response.headers.get("retry-after")).toBe("60"); expect(response.headers.get("x-should-retry")).toBeNull(); expect(fixture.seen.length).toBe(1);
  } finally { await fixture.close(); }
});

for (const precheck of [false, true]) test(`input estimate admission is optional (${precheck})`, async () => {
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    config.providers.openai!.contextWindow = 4_096;
    config.providers.openai!.codexPassthrough = { localErrorPolicies: { inputAdmissionPrecheck: precheck } };
  }, upstream: async () => Response.json({ id: "resp_input", status: "completed", output: [] }) });
  try { const response = await fixture.request({ ...input, input: "x".repeat(100_000) }); expect(response.status).toBe(precheck ? 413 : 200);
    await response.text(); expect(fixture.seen.length).toBe(precheck ? 0 : 1);
  } finally { await fixture.close(); }
});

test("input permission follows a renamed provider's actual model wire override", async () => {
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    config.providers.renamed = { ...config.providers.openai!, adapter: "openai-chat", contextWindow: 4_096,
      modelAdapters: { [input.model]: "openai-responses" }, codexPassthrough: { localErrorPolicies: { inputAdmissionPrecheck: false } } };
    delete config.providers.renamed.codexAccountMode;
  }, upstream: async () => Response.json({ id: "resp_wire", status: "completed", output: [] }) });
  try { const response = await fixture.request({ ...input, model: `renamed/${input.model}`, input: "x".repeat(100_000) });
    expect(response.status).toBe(200); await response.text(); expect(fixture.seen.length).toBe(1);
  } finally { await fixture.close(); }
});

test("canonical parent permission cannot bypass a noncanonical effective adapter or translated inbound", () => {
  const provider: OcxProviderConfig = { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex",
    codexPassthrough: disabledCodexPassthrough() };
  const turn = captureCodexPassthroughTurn({ openai: provider }, "responses");
  const route = { providerName: "openai", provider, modelId: input.model, staticPolicy: { model: { adapter: "openai-chat" } } as any };
  expect(routedCodexPassthroughPermissions(turn, route, "responses")).toBeUndefined();
  expect(routedCodexPassthroughPermissions(turn, { ...route, staticPolicy: undefined }, "anthropic")).toBeUndefined();
});

for (const pacing of [false, true]) test(`pacing permission bypasses the provider queue before admission (${pacing})`, async () => {
  let provider!: OcxProviderConfig;
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    provider = config.providers.openai!; provider.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
    provider.codexPassthrough = { localErrorPolicies: { requestPacingAdmission: pacing } };
  }, upstream: async () => Response.json({ id: "resp_pacing", status: "completed", output: [] }) });
  let held: Awaited<ReturnType<typeof waitForProviderRequestSlot>>;
  try { held = await waitForProviderRequestSlot("openai", provider, input.model);
    setProviderRequestPacingLimitsForTest({ maxQueueDepth: 0 });
    const response = await fixture.request(input); expect(response.status).toBe(pacing ? 429 : 200); await response.text();
    expect(fixture.seen.length).toBe(pacing ? 0 : 1); expect(providerRequestPacingStatus("openai", provider).queued).toBe(0);
  } finally { held?.release(); resetProviderRequestPacingForTest(); await fixture.close(); }
});

test("a key provider ignores official local permissions and keeps its pacing admission", async () => {
  let provider!: OcxProviderConfig;
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    provider = config.providers.keyed!; provider.requestPacing = { enabled: true, maxConcurrentRequests: 1 }; provider.codexPassthrough = disabledCodexPassthrough();
  }, upstream: async () => Response.json({ status: "completed", output: [] }) });
  let held: Awaited<ReturnType<typeof waitForProviderRequestSlot>>;
  try { held = await waitForProviderRequestSlot("keyed", provider, input.model); setProviderRequestPacingLimitsForTest({ maxQueueDepth: 0 });
    const response = await fixture.request({ ...input, model: `keyed/${input.model}` }); expect(response.status).toBe(429);
    expect(await response.text()).toContain("request pacing queue for provider 'keyed' is full"); expect(providerRequestPacingStatus("keyed", provider).queued).toBe(0);
  } finally { held?.release(); resetProviderRequestPacingForTest(); await fixture.close(); }
});

test("default permission does not activate a disabled pacing feature", async () => {
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    config.providers.openai!.requestPacing = { enabled: false, maxConcurrentRequests: 1, minIntervalMs: 60_000 };
  }, upstream: async () => Response.json({ id: "resp_unpaced", status: "completed", output: [] }) });
  try { for (let i = 0; i < 2; i++) { const response = await fixture.request(input); expect(response.status).toBe(200); await response.text(); }
    expect(fixture.seen.length).toBe(2);
  } finally { resetProviderRequestPacingForTest(); await fixture.close(); }
});

test("all local policies off still preserves outbound byte admission", async () => {
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); config.maxUpstreamBodyBytes = 128;
  }, upstream: async () => Response.json({ status: "completed", output: [] }) });
  try { const response = await fixture.request({ ...input, input: "x".repeat(2_000) }); expect(response.status).toBe(413);
    expect(await response.text()).toContain("outbound_body_too_large"); expect(fixture.seen.length).toBe(0);
  } finally { await fixture.close(); }
});

test("a replacement hard-budget rejection retains its actual error", async () => {
  const error = new SendBudgetExhaustedError("synthetic-budget"); let calls = 0; let claims = 0; let caught: unknown;
  try { await fetchWithResetRetry(async () => { if (calls++ === 0) throw reset(); throw error; }, {
    attempts: 3, codexPassthroughPermissions: resolveCodexPassthroughPermissions(disabledCodexPassthrough()),
    claimAmbiguousResend: () => { claims++; return true; },
  }); } catch (failure) { caught = failure; }
  expect(caught instanceof Error && (caught.cause ?? caught)).toBe(error); expect(calls).toBe(2); expect(claims).toBe(1);
});

test("a replacement refused by beforeSend retains reset evidence without another physical send", async () => {
  const permissions = resolveCodexPassthroughPermissions(disabledCodexPassthrough());
  let calls = 0; let admissions = 0; let claims = 0; let reported = 0; let closed = 0; let caught: unknown;
  const report = Object.assign((count: number) => { reported += count; }, {
    beforeSend: () => admissions++ === 0, close: () => { closed++; },
  });
  try { await fetchWithResetRetry(async () => { calls++; throw reset(); }, {
    attempts: 3, codexPassthroughPermissions: permissions, onSendsConsumed: report,
    claimAmbiguousResend: () => { claims++; return true; },
  }); } catch (error) { caught = error; }
  const original = caught instanceof UpstreamRetryEvidenceError ? caught.cause : caught;
  expect(original).toBeInstanceOf(SendBudgetExhaustedError);
  const response = preserveCodexReplacementFailure(caught, Response.json({ error: {
    code: (original as SendBudgetExhaustedError).code,
  } }, { status: 429 }), "hard-budget", permissions);
  expect(isNonReplayableResponse(response)).toBe(true); expect(isReplayRefusalResponse(response)).toBe(false);
  expect(codexLocalFailure(response)).toEqual({ kind: "protected", reason: "hard-budget" });
  expect(await response.json()).toEqual({ error: { code: "request_send_budget_exhausted" } });
  expect(calls).toBe(1); expect(admissions).toBe(2); expect(claims).toBe(1); expect(reported).toBe(1); expect(closed).toBe(1);
});

test("HTTP replacement keeps a structured hard-budget failure with all permissions off", async () => {
  let sends = 0;
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    config.providers.openai!.retryOnReset = {}; config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
  }, upstream: async () => { if (sends++ === 0) throw reset(); throw new SendBudgetExhaustedError("synthetic-budget"); } });
  try {
    const response = await fixture.request(input); expect(response.status).toBe(429);
    expect(await response.text()).toContain("request_send_budget_exhausted"); expect(fixture.seen.length).toBe(2);
  } finally { await fixture.close(); }
});

const protectedPoolId = "replacement-protected-pool";
function configureProtectedPool(config: OcxConfig) {
  config.activeCodexAccountId = protectedPoolId; config.pausedCodexAccountIds = [MAIN_CODEX_ACCOUNT_ID]; config.creditCodexAccountIds = [];
  config.codexAccounts = [{ id: protectedPoolId, plan: "pro", isMain: false, chatgptAccountId: "replacement-protected-account" }];
  saveCodexAccountCredential(protectedPoolId, { accessToken: fakeChatGptJwt({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "replacement-protected-account" } }),
    refreshToken: "synthetic-protected-refresh", expiresAt: 4_000_000_000_000, chatgptAccountId: "replacement-protected-account" });
  updateAccountQuota(protectedPoolId, 10);
}
function holdPoolCredits() {
  updateAccountQuota(protectedPoolId, 100, Date.now() + 3_600_000);
  setAccountQuotaFromParsed(protectedPoolId, { credits: { hasCredits: true, balance: 42.5, observedAt: Date.now() } });
}

test("an HTTP replacement refused by the real credits guard preserves account policy", async () => {
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    configureProtectedPool(config); config.providers.openai!.retryOnReset = {};
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
  }, upstream: async () => { holdPoolCredits(); throw reset(); } });
  try {
    const response = await fixture.request(input); const text = await response.text();
    expect(text).toContain("credits"); expect(response.status).toBe(429); expect(fixture.seen.length).toBe(1);
  } finally { await fixture.close(); }
});

test("a dead WS replacement preserves the real credits guard before HTTP dispatch", async () => {
  const previous = globalThis.WebSocket; let frames = 0; let config!: OcxConfig;
  class Socket extends EventTarget {
    static OPEN = 1; readyState = 0;
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
    send() { frames++; holdPoolCredits(); queueMicrotask(() => { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code: 1006 })); }); }
    close() { this.readyState = 3; }
  }
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(value) {
    config = value; configureProtectedPool(config); config.providers.openai!.retryOnReset = {};
    config.providers.openai!.upstreamWebsocket = true;
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
  }, upstream: async () => { throw new Error("unexpected HTTP send after protected WS refusal"); } });
  globalThis.WebSocket = Socket as any;
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${PROXY_KEY}` }, body: JSON.stringify({ ...input, stream: true }) }),
      config, { model: "", provider: "" }, { codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME });
    const text = await response.text(); expect(frames).toBe(1); expect(fixture.seen.length).toBe(0);
    expect(text).toContain("credits"); expect(response.status).toBe(429);
    expect(codexLocalFailure(response)?.kind).toBe("protected"); expect(isNonReplayableResponse(response)).toBe(true);
    expect(isReplayRefusalResponse(response)).toBe(false);
  } finally { globalThis.WebSocket = previous; await fixture.close(); }
});

import { expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fixturePath } from "../helpers/repo-root";
import { createCodexPassthroughFixture, disabledCodexPassthrough } from "../helpers/codex-passthrough-fixture";
import { reserveIngressFixture, withReserveIngressCleanup, ACCESS, PROXY_KEY, deferred } from "../helpers/reserve-ingress-fixture";
import { CODEX_PASSTHROUGH_CATALOG, resolveCodexPassthroughPermissions, type CodexPassthroughConfig } from "../../src/fork/codex-passthrough-contract";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { updateAccountQuota } from "../../src/codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { setDebugSettings, resetDebugSettingsForTests } from "../../src/lib/debug-settings";
import { resetProviderDebugPersistenceForTests } from "../../src/fork/debug-persistence";
import { getConfigDir } from "../../src/config";
import * as reserveRemoval from "../helpers/remove-tree";
import * as reserveServer from "../../src/server";

const legacyText = readFileSync(fixturePath("codex-passthrough-legacy.json"), "utf8");
const legacy = JSON.parse(legacyText);
const incoming = { model: "gpt-5.6-sol", stream: false, temperature: 0.2, max_output_tokens: 47,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "frozen baseline" }] }],
  client_metadata: { caller_field: "keep" }, unknown_valid_field: { nested: [1, true, "keep"] } };
const clientHeaders = { "x-openai-internal-codex-responses-lite": "true", "x-codex-routing-hint": "caller-hint", session_id: "frozen-session" };
const upstream = { id: "resp_frozen", object: "response", status: "completed", model: incoming.model,
  output: [{ id: "msg_frozen", type: "message", role: "assistant", content: [{ type: "output_text", text: "frozen output" }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
const forms: Array<[string, CodexPassthroughConfig | undefined]> = [["unset", undefined], ["empty", {}], ["all true", resolveCodexPassthroughPermissions(undefined)]];
const permissionVariants: Array<CodexPassthroughConfig | null> = [null, {}, disabledCodexPassthrough(), resolveCodexPassthroughPermissions(undefined),
  ...CODEX_PASSTHROUGH_CATALOG.map(row => row.group === "localErrors"
    ? { localErrorPolicies: { [row.key]: false } } : { [row.key]: false })];
async function patch(fetcher: typeof fetch, base: string, provider: string, value: CodexPassthroughConfig | null) {
  const response = await fetcher(`${base}/api/providers?name=${provider}`, { method: "PATCH",
    headers: { authorization: `Bearer ${process.env.OPENCODEX_ADMIN_AUTH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ codexPassthrough: value }), signal: AbortSignal.timeout(10_000) });
  expect(response.status).toBe(200); await response.text();
}

test("reserve fixture preserves startup and removal failures", async () => {
  const startupError = new Error("controlled reserve startup failure");
  const removalError = Object.assign(new Error("controlled reserve removal failure"), { code: "EBUSY" });
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  const realRemove = reserveRemoval.removeTreeAfterBackgroundWork;
  const removal = spyOn(reserveRemoval, "removeTreeAfterBackgroundWork").mockImplementation(async path => {
    await realRemove(path);
    throw removalError;
  });
  let failure: unknown;
  try {
    await reserveIngressFixture({ configure() { throw startupError; } });
  } catch (error) { failure = error; }
  finally { removal.mockRestore(); }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toHaveLength(2);
  expect((failure as AggregateError).errors[0]).toBe(startupError);
  expect((failure as AggregateError).errors[1]).toBe(removalError);
  expect(globalThis.fetch).toBe(originalFetch);
  expect(process.env.OPENCODEX_HOME).toBe(originalHome);
});

test("reserve fixture preserves shutdown and removal failures after restoring its globals", async () => {
  const shutdownError = new Error("controlled reserve shutdown failure");
  const removalError = Object.assign(new Error("controlled reserve removal failure"), { code: "EBUSY" });
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  const realStart = reserveServer.startServer;
  const realRemove = reserveRemoval.removeTreeAfterBackgroundWork;
  const startup = spyOn(reserveServer, "startServer").mockImplementation((...args) => {
    const server = realStart(...args);
    const realStop = server.stop.bind(server);
    return new Proxy(server, { get(target, key) {
      if (key === "stop") return async (closeActive: boolean) => { await realStop(closeActive); throw shutdownError; };
      return Reflect.get(target, key, target);
    } });
  });
  const removal = spyOn(reserveRemoval, "removeTreeAfterBackgroundWork").mockImplementation(async path => {
    await realRemove(path);
    throw removalError;
  });
  let failure: unknown;
  try {
    const fixture = await reserveIngressFixture();
    await fixture.close();
  } catch (error) { failure = error; }
  finally { startup.mockRestore(); removal.mockRestore(); }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toHaveLength(2);
  expect((failure as AggregateError).errors[0]).toBe(shutdownError);
  expect((failure as AggregateError).errors[1]).toBe(removalError);
  expect(globalThis.fetch).toBe(originalFetch);
  expect(process.env.OPENCODEX_HOME).toBe(originalHome);
});

test("fallback cleanup preserves every failure and closes the real gateway", async () => {
  const bodyError = new Error("controlled fallback assertion failure");
  const closeError = new Error("controlled fallback fixture close failure");
  const gatewayError = new Error("controlled fallback gateway stop failure");
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture gateway") });
  const url = gateway.url.toString();
  const nativeFetch = globalThis.fetch;
  let failure: unknown;
  let reachable = true;
  try {
    expect(await (await nativeFetch(url, { signal: AbortSignal.timeout(1_000) })).text()).toBe("fixture gateway");
    try {
      await withReserveIngressCleanup(
        () => { throw bodyError; },
        () => { throw closeError; },
        async () => { await gateway.stop(true); throw gatewayError; },
      );
    } catch (error) { failure = error; }
    try { await nativeFetch(url, { signal: AbortSignal.timeout(1_000) }); }
    catch { reachable = false; }
  } finally { await gateway.stop(true); }
  expect(reachable).toBe(false);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toHaveLength(3);
  expect((failure as AggregateError).errors[0]).toBe(bodyError);
  expect((failure as AggregateError).errors[1]).toBe(closeError);
  expect((failure as AggregateError).errors[2]).toBe(gatewayError);
});

test("reserve cleanup preserves a lone error and a successful body result", async () => {
  const failure = new Error("controlled lone cleanup failure");
  await expect(withReserveIngressCleanup(() => { throw failure; }, () => {})).rejects.toBe(failure);
  await expect(withReserveIngressCleanup(() => 47, () => { throw failure; })).rejects.toBe(failure);
  await expect(withReserveIngressCleanup(() => 47, () => {})).resolves.toBe(47);
});

test("legacy fixture is the immutable pre-implementation evidence", () => {
  expect(legacy.sourceHead).toBe("34f76ec760fd0d5381672fa7a419da0fed7e063c");
  expect(createHash("sha256").update(legacyText).digest("hex")).toBe("0b3c717b68c2c1e4e60479e5f1c2e0ddde870bdae1e248f5a9001b8df697d688");
});

for (const mode of ["direct", "pool"] as const) test(`default_forms_match_frozen_legacy_wire (${mode})`, async () => {
  for (const [label, permissions] of forms) {
    const fixture = await createCodexPassthroughFixture({ mode, configure(config) { config.providers.openai!.codexPassthrough = permissions; },
      upstream: async () => new Response([
        { type: "response.created", response: { ...upstream, status: "in_progress", output: [] } },
        { type: "response.completed", response: upstream },
      ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream", "x-fixture-upstream": "preserved" },
      }) });
    try {
      for (const stream of [false, true]) {
        const response = await fixture.request({ ...incoming, stream }, clientHeaders); const text = await response.text();
        const expected = legacy.records[`${mode}-${stream ? "sse" : "json"}`];
        const sent = fixture.seen.at(-1)!;
        expect(sent.body, label).toEqual(expected.upstream.body);
        for (const [key, value] of Object.entries(expected.upstream.headers)) expect(sent.headers.get(key), `${label}/${key}`).toEqual(value);
        expect(response.status).toBe(expected.status); expect(stream ? text : JSON.parse(text)).toEqual(expected.payload);
        expect(response.headers.get("content-type")).toBe(expected.headers.contentType);
        expect(response.headers.get("x-fixture-upstream")).toBe(expected.headers.upstream);
        expect(response.headers.has("x-opencodex-request-id")).toBe(expected.headers.requestIdPresent);
        expect(response.headers.get("access-control-expose-headers")).toBe(expected.headers.expose);
        expect(response.headers.get("access-control-allow-origin")).toBe(`http://localhost:${new URL(fixture.publicBase).port}`);
      }
    } finally { await fixture.close(); }
  }
}, 45_000);

for (const mode of ["direct", "pool"] as const) test(`default_forms_match_frozen_legacy_client_ws (${mode})`, async () => {
  for (const [label, permissions] of forms) {
    const nativeFetch = globalThis.fetch;
    const fixture = await reserveIngressFixture({ primaryLoopback: true, configure(config) {
      config.providers.openai!.codexAccountMode = mode; config.providers.openai!.codexPassthrough = permissions;
      config.streamMode = "legacy-tee"; if (mode === "pool") config.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    } });
    const fixtureFetch = globalThis.fetch; let sent: { body: unknown; headers: Headers } | undefined;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url !== "https://chatgpt.com/backend-api/codex/responses") return fixtureFetch(input, init);
      sent = { body: await request.json(), headers: request.headers };
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: upstream })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }, { preconnect() {} });
    try {
      const response = await fixture.request("public", "ws", incoming.model, { ...clientHeaders, authorization: `Bearer ${mode === "direct" ? ACCESS : PROXY_KEY}` }, incoming);
      const expected = legacy.records[`${mode}-ws`]; expect(response.opened).toBe(true);
      expect(response.status).toBe(expected.status); expect(JSON.parse(response.text), label).toEqual(expected.payload);
      expect(sent!.body).toEqual(expected.upstream.body);
      for (const [key, value] of Object.entries(expected.upstream.headers)) expect(sent!.headers.get(key)).toEqual(value);
    } finally { globalThis.fetch = nativeFetch; await fixture.close(); }
  }
}, 45_000);

test("next_ws_turn_uses_new_flags_but_running_turn_does_not", async () => {
  const nativeFetch = globalThis.fetch; const NativeSocket = globalThis.WebSocket;
  const started = deferred<void>(); const release = deferred<void>(); let calls = 0;
  const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream: async () => {
    calls++; if (calls === 1) { started.resolve(); await release.promise; }
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_turn_${calls}`, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "snapshot" }] }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const socket = new NativeSocket(fixture.publicBase.replace("http:", "ws:") + "/v1/responses", { headers: { authorization: `Bearer ${ACCESS}`, "thread-id": "contract-ws-thread" } } as unknown as string[]);
  const frames: any[] = []; const waiters: Array<(value: any) => void> = [];
  socket.addEventListener("message", event => { const frame = JSON.parse(String(event.data));
    if (frame.type === "response.completed" || frame.type === "error") { const waiter = waiters.shift(); if (waiter) waiter(frame); else frames.push(frame); } });
  const next = () => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("client WS terminal deadline")), 15_000);
    const done = (value: any) => { clearTimeout(timer); resolve(value); };
    if (frames.length) done(frames.shift()); else waiters.push(done);
  });
  try {
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("client WS open failed")), { once: true }); });
    socket.send(JSON.stringify({ ...incoming, stream: true, type: "response.create" })); await started.promise;
    await patch(nativeFetch, fixture.publicBase, "openai", disabledCodexPassthrough()); release.resolve();
    const first = await next(); expect(typeof first.response.output[0].id).toBe("string");
    socket.send(JSON.stringify({ ...incoming, stream: true, type: "response.create" }));
    const second = await next(); expect(second.response.output[0]).not.toHaveProperty("id");
    expect(fixture.seen).toHaveLength(2); expect(fixture.seen[0]!.body).not.toHaveProperty("temperature");
    expect(fixture.seen[1]!.body).toMatchObject({ temperature: 0.2, max_output_tokens: 47, unknown_valid_field: incoming.unknown_valid_field });
    expect(fixture.seen[0]!.headers.get("session_id")).not.toBeNull();
    expect(fixture.seen[1]!.headers.get("session_id")).toBeNull();
  } finally { release.resolve(); socket.close(); await fixture.close(); }
}, 30_000);

test("native_client_ws_retains_the_complete_real_upstream_429_when_rewrites_are_off", async () => {
  const nativeFetch = globalThis.fetch;
  const payload = { error: { type: "vendor_future_quota", code: "vendor_quota_future", message: "unmodified vendor message", retry_hint: [3, 1] }, future: { order: [3, 1, 2] } };
  const fixture = await reserveIngressFixture({ primaryLoopback: true, configure(config) {
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
  } });
  const fixtureFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== "https://chatgpt.com/backend-api/codex/responses") return fixtureFetch(input, init);
    calls++; return Response.json(payload, { status: 429, headers: { "retry-after": "1", "x-fixture-future": "preserved" } });
  }, { preconnect() {} });
  try {
    const response = await fixture.request("public", "ws", incoming.model, { authorization: `Bearer ${ACCESS}` }, incoming);
    expect(response.status).toBe(429); expect(calls).toBe(1);
    const frame = JSON.parse(response.text); const delivered = frame.response ?? frame;
    expect(delivered.error).toEqual(payload.error); expect(delivered.future).toEqual(payload.future);
  } finally { globalThis.fetch = nativeFetch; await fixture.close(); }
});

test("third_party_wire_and_admission_are_invariant_under_all_20_overrides", async () => {
  const nativeFetch = globalThis.fetch; const seen: unknown[] = [];
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/responses")) return Response.json({ models: [] });
    seen.push(await request.json()); return Response.json(upstream);
  } });
  const fixture = await reserveIngressFixture({ primaryLoopback: true, configure(config) {
    config.providers.gateway = { adapter: "openai-responses", authMode: "key", apiKey: "sk-controlled-gateway", baseUrl: endpoint.url.toString(), allowPrivateNetwork: true };
  } });
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    return new URL(request.url).origin === endpoint.url.origin ? nativeFetch(input, init) : fixtureFetch(input, init);
  }, { preconnect() {} });
  let first: unknown; let firstReply: unknown;
  try {
    for (const permissions of permissionVariants) {
      await patch(nativeFetch, fixture.publicBase, "gateway", null);
      if (permissions !== null) await patch(nativeFetch, fixture.publicBase, "gateway", permissions);
      const response = await nativeFetch(fixture.publicBase + "/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${PROXY_KEY}` },
        body: JSON.stringify({ ...incoming, model: "gateway/gpt-5.6-sol" }) });
      const reply = await response.json(); expect(response.status).toBe(200);
      if (first === undefined) { first = seen.at(-1); firstReply = reply; }
      expect(seen.at(-1)).toEqual(first); expect(reply).toEqual(firstReply);
      expect(response.headers.has("x-opencodex-request-id")).toBe(true); expect(response.headers.has("access-control-allow-origin")).toBe(true);
    }
    expect(seen).toHaveLength(permissionVariants.length);
    expect(first).toMatchObject({ model: incoming.model, temperature: incoming.temperature, unknown_valid_field: incoming.unknown_valid_field });
  } finally { await fixture.close(); await endpoint.stop(true); }
}, 45_000);

test("added_pool_accounts_share_permissions_and_keep_injected_credentials_out_of_diagnostics", async () => {
  const tokens = ["pool-contract-a", "pool-contract-b"].map(account => fakeChatGptJwt({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: account } }));
  const nativeFetch = globalThis.fetch; const replySecret = "synthetic-private-contract-marker";
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); config.providers.openai!.headers = { "session-token": replySecret };
    config.pausedCodexAccountIds = [MAIN_CODEX_ACCOUNT_ID]; config.activeCodexAccountId = undefined;
    config.codexAccounts = tokens.map((token, index) => { const id = `contract-pool-${index}`; const chatgptAccountId = `pool-contract-${index ? "b" : "a"}`;
      saveCodexAccountCredential(id, { accessToken: token, refreshToken: "synthetic-refresh", expiresAt: 4_000_000_000_000, chatgptAccountId });
      return { id, isMain: false, chatgptAccountId };
    });
    config.codexAccountNamespaces = { ...config.codexAccountNamespaces, a: "contract-pool-0", b: "contract-pool-1" };
  }, upstream: async request => Response.json({ error: { code: "upstream_real_429", message: `${request.headers.get("authorization")} / ${replySecret}` }, future: [3, 1] },
    { status: 429, headers: { "x-private-echo": replySecret, "retry-after": "1" } }) });
  resetProviderDebugPersistenceForTests(); setDebugSettings({ debug: true, providerText: true, usage: true });
  try {
    for (const selector of ["a", "b"]) {
      const response = await fixture.request({ ...incoming, model: `${selector}/${incoming.model}` }); const text = await response.text();
      expect(response.status).toBe(429); expect(text).toContain("upstream_real_429"); expect(JSON.parse(text).future).toEqual([3, 1]);
      for (const secret of [replySecret, ...tokens]) expect(text).not.toContain(secret);
      expect(response.headers.get("x-private-echo")).toBe("[REDACTED]");
    }
    expect(fixture.seen).toHaveLength(2); expect(fixture.seen.map(row => row.headers.get("authorization"))).toEqual(tokens.map(token => `Bearer ${token}`));
    const root = getConfigDir(); const logs: string[] = [];
    const collect = (directory: string) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name); if (entry.isDirectory()) collect(path); else if (entry.isFile()) logs.push(readFileSync(path, "utf8"));
      }
    };
    collect(join(root, "provider-debug")); collect(join(root, "provider-debug-artifacts"));
    if (existsSync(join(root, "usage-debug.jsonl"))) logs.push(readFileSync(join(root, "usage-debug.jsonl"), "utf8"));
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [replySecret, ...tokens]) expect(logs.join("\n")).not.toContain(secret);
    await patch(nativeFetch, fixture.publicBase, "openai", { normalizeRequestParameters: true });
    const response = await fixture.request({ ...incoming, model: `a/${incoming.model}` }); await response.text();
    expect(fixture.seen.at(-1)!.body).not.toHaveProperty("temperature");
  } finally { resetDebugSettingsForTests(); resetProviderDebugPersistenceForTests(); await fixture.close(); }
}, 30_000);

for (const routeKind of ["combo", "policy"] as const) for (const first of ["official", "gateway"] as const) test(`actual_${routeKind}_fallback_uses_each_destination_permissions (${first})`, async () => {
  const nativeFetch = globalThis.fetch; const gatewayBodies: any[] = []; const order: string[] = [];
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/responses")) return Response.json({ models: [] });
    gatewayBodies.push(await request.json()); order.push("gateway");
    return first === "gateway" ? Response.json({ error: { code: "rate_limit_exceeded", message: "controlled gateway quota" } }, { status: 429 }) : Response.json(upstream);
  } });
  let closeFixture: (() => Promise<void>) | undefined;
  await withReserveIngressCleanup(async () => {
    const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
      config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
      config.providers.gateway = { adapter: "openai-responses", authMode: "key", apiKey: "sk-controlled-gateway", baseUrl: gateway.url.toString(), allowPrivateNetwork: true,
        codexPassthrough: disabledCodexPassthrough() };
      const candidates = (first === "official" ? ["openai", "gateway"] : ["gateway", "openai"]).map(provider => ({ provider, model: incoming.model }));
      if (routeKind === "combo") config.combos = { contract: { strategy: "failover", targets: candidates } };
      else config.routingProfiles = { contract: { candidates } };
    }, upstream: async () => {
      order.push("official"); return first === "official" ? Response.json({ error: { code: "rate_limit_exceeded", message: "controlled official quota" } }, { status: 429 }) : Response.json(upstream);
    } });
    closeFixture = fixture.close;
    const fixtureFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => new URL(new Request(input, init).url).origin === gateway.url.origin
      ? nativeFetch(input, init) : fixtureFetch(input, init), { preconnect() {} });
    const response = await fixture.request({ ...incoming, model: `${routeKind}/contract` }, clientHeaders);
    expect(response.status).toBe(200); expect((await response.json()).id).toBe(upstream.id);
    expect(order).toEqual(first === "official" ? ["official", "gateway"] : ["gateway", "official"]);
    expect(fixture.seen.length).toBe(1); expect(gatewayBodies.length).toBe(1);
    expect(fixture.seen[0]!.body).toMatchObject({ model: incoming.model, stream: false, temperature: incoming.temperature, unknown_valid_field: incoming.unknown_valid_field });
    expect(fixture.seen[0]!.headers.get("x-codex-routing-hint")).toBe("caller-hint");
    expect(gatewayBodies[0]).toMatchObject({ model: incoming.model, temperature: incoming.temperature });
  }, () => closeFixture?.(), () => gateway.stop(true));
});

for (const [label, permissions] of [...forms, ["all off", disabledCodexPassthrough()] as const]) test(`pool_rotation_keeps_the_same_permissions_on_both_physical_sends (${label})`, async () => {
  const tokens = ["rotation-a", "rotation-b"].map(account => fakeChatGptJwt({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: account } }));
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(config) {
    config.providers.openai!.codexPassthrough = permissions;
    config.pausedCodexAccountIds = [MAIN_CODEX_ACCOUNT_ID]; config.activeCodexAccountId = "rotation-0";
    config.codexAccounts = tokens.map((token, index) => {
      const id = `rotation-${index}`; const chatgptAccountId = `rotation-${index ? "b" : "a"}`;
      saveCodexAccountCredential(id, { accessToken: token, refreshToken: "synthetic-refresh", expiresAt: 4_000_000_000_000, chatgptAccountId });
      updateAccountQuota(id, 10 + index * 10); return { id, isMain: false, chatgptAccountId };
    });
  }, upstream: async request => request.headers.get("chatgpt-account-id") === "rotation-a"
    ? Response.json({ error: { code: "rate_limit_exceeded", message: "controlled account quota" } }, { status: 429, headers: { "retry-after": "30" } })
    : Response.json(upstream) });
  try {
    const response = await fixture.request(incoming, clientHeaders);
    expect(response.status).toBe(200); expect((await response.json()).id).toBe(upstream.id);
    expect(fixture.seen.map(row => row.headers.get("authorization"))).toEqual(tokens.map(token => `Bearer ${token}`));
    for (const sent of fixture.seen) {
      if (permissions?.normalizeRequestParameters === false) expect(sent.body).toMatchObject({ temperature: incoming.temperature, stream: false, unknown_valid_field: incoming.unknown_valid_field, client_metadata: incoming.client_metadata });
      else expect(sent.body).not.toHaveProperty("temperature");
      expect(sent.headers.get("x-codex-routing-hint")).toBe(permissions?.synthesizeRoutingHint === false ? "caller-hint" : `model=${incoming.model}`);
      expect(sent.headers.get("session_id")).toBe("frozen-session");
    }
  } finally { await fixture.close(); }
});

for (const wire of ["chat", "anthropic"] as const) test(`translated_${wire}_inbound_ignores_subscription_overrides`, async () => {
  const nativeFetch = globalThis.fetch;
  const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream: async () => Response.json(upstream) });
  let firstBody: unknown; let firstReply: unknown;
  try {
    for (const value of permissionVariants) {
      await patch(nativeFetch, fixture.publicBase, "openai", null);
      if (value !== null) await patch(nativeFetch, fixture.publicBase, "openai", value);
      const response = await nativeFetch(fixture.publicBase + (wire === "chat" ? "/v1/chat/completions" : "/v1/messages"), {
        method: "POST", headers: { authorization: `Bearer ${ACCESS}`, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: incoming.model, stream: false, temperature: 0.2, messages: [{ role: "user", content: "translated fixture" }], ...(wire === "anthropic" ? { max_tokens: 47 } : {}) }),
      });
      const reply = await response.json(); expect(response.status).toBe(200);
      const sent = fixture.seen.at(-1)!.body as { input?: unknown; messages?: unknown };
      expect(Array.isArray(sent.input)).toBe(true); expect(sent.messages).toBeUndefined();
      if (firstBody === undefined) { firstBody = sent; firstReply = reply; }
      expect(sent).toEqual(firstBody);
      if (wire === "chat") { expect((reply as any).choices[0].message.content).toBe((firstReply as any).choices[0].message.content); }
      else expect((reply as any).content).toEqual((firstReply as any).content);
      expect(response.headers.has("x-opencodex-request-id")).toBe(wire === "anthropic");
    }
    expect(fixture.seen.length).toBe(permissionVariants.length);
  } finally { await fixture.close(); }
});

test("key_auth_to_the_official_host_is_excluded_by_the_actual_auth_mode", async () => {
  const nativeFetch = globalThis.fetch;
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    config.providers.nativeKey = { adapter: "openai-responses", baseUrl: config.providers.openai!.baseUrl, authMode: "key", apiKey: "sk-test-1native" };
  }, upstream: async () => Response.json(upstream) });
  const fixtureFetch = globalThis.fetch; const keyed: { body: unknown; headers: Headers }[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== "https://chatgpt.com/backend-api/codex/v1/responses") return fixtureFetch(input, init);
    keyed.push({ body: await request.json(), headers: request.headers }); return Response.json(upstream);
  }, { preconnect() {} });
  let firstBody: unknown;
  try {
    for (const value of permissionVariants) {
      await patch(nativeFetch, fixture.publicBase, "nativeKey", null);
      if (value !== null) await patch(nativeFetch, fixture.publicBase, "nativeKey", value);
      const response = await fixture.request({ ...incoming, model: `nativeKey/${incoming.model}` }); await response.text();
      expect(response.status).toBe(200); const sent = keyed.at(-1)!;
      if (firstBody === undefined) firstBody = sent.body;
      expect(sent.body).toEqual(firstBody); expect(sent.headers.get("authorization")).toBe("Bearer sk-test-1native");
      expect(response.headers.has("x-opencodex-request-id")).toBe(true);
    }
    expect(keyed.length).toBe(permissionVariants.length); expect(fixture.seen.length).toBe(0);
  } finally { await fixture.close(); }
});

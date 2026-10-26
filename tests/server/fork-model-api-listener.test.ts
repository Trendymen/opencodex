import { expect, spyOn, test } from "bun:test";
import { getDefaultConfig } from "../../src/config";
import { resolveForkModelApiTopology } from "../../src/fork/model-api-listener-config";
import { createForkModelApiListener, forkModelApiRouteAllowed } from "../../src/fork/model-api-listener";
import { spendLedgerOwnerSnapshot } from "../../src/lib/spend-ledger-owner";
import { AuxiliaryListenerBindError } from "../../src/server/ports";
import { startForkModelApiFixture, startForkModelApiFixtureWithDeps } from "../helpers/fork-model-api-fixture";

function config() {
  return { ...getDefaultConfig(), hostname: "127.0.0.1", port: 10101,
    claudeCode: { intercept: { enabled: false } },
    forkModelApiListener: { enabled: true },
    apiKeys: [{ id: "fixture", name: "fixture", key: "fixture-data-key", createdAt: "2026-01-01T00:00:00Z" }],
    providers: { local: { adapter: "openai-chat" as const, baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, models: ["fixture-model"] } }, defaultProvider: "local" };
}
const auth = { "x-opencodex-api-key": "fixture-data-key" };

test("namespace admits every v1 data path but no Link management prefix", () => {
  for (const path of ["/v1/models", "/v1/new-native-capability"]) expect(forkModelApiRouteAllowed(new URL(path, "http://test"))).toBe(true);
  for (const path of ["/v1", "/api/settings", "/v1/link-management", "/v1/link-management/settings"]) expect(forkModelApiRouteAllowed(new URL(path, "http://test"))).toBe(false);
});

test("auxiliary binds the logical API port and authenticates the actual receiving listener", async () => {
  const fixture = await startForkModelApiFixture(config());
  try {
    expect(fixture.apiUrl).not.toBeNull();
    expect(fixture.logicalBinds).toEqual([{ hostname: "127.0.0.1", port: 10101 }, { hostname: "0.0.0.0", port: 10100 }]);
    const unauthenticated = await fetch(`${fixture.apiUrl}/v1/models`);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ error: { code: "invalid_api_key" } });
    const response = await fetch(`${fixture.apiUrl}/v1/models`, { headers: auth });
    expect(response.status).toBe(200);
    const catalog = await response.json();
    expect(catalog).toMatchObject({ object: "list" });
    const alias = await fetch(`${fixture.apiUrl}/backend-api/codex/models`, { headers: auth });
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(catalog);
    const unknown = await fetch(`${fixture.apiUrl}/v1/unknown`, { headers: auth });
    expect(unknown.status).toBe(404);
  } finally { await fixture.close(); }
  expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
});

test("auxiliary denies management, GUI, health, pairing and workspace before credentials or Host", async () => {
  const fixture = await startForkModelApiFixture(config());
  try {
    for (const path of ["/", "/api/settings", "/opencodex-session", "/healthz", "/readyz", "/remote-workspace/pair", "/remote-workspace/agent", "/v1/link-management", "/v1/link-management/api/settings", "/v1"]) {
      for (const headers of [{}, auth, { "x-opencodex-api-key": fixture.adminToken }, { ...auth, host: "localhost:10101", authorization: "Bearer fixture-admin", cookie: "opencodex-session=forged" }]) {
        const response = await fetch(`${fixture.apiUrl}${path}`, { headers });
        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
      }
    }
    expect((await fetch(`${fixture.primaryUrl}/healthz`)).status).toBe(200);
  } finally { await fixture.close(); }
});

test("disabled and native nonloopback primary create one listener and preserve native health", async () => {
  for (const candidate of [{ ...config(), forkModelApiListener: { enabled: false } }, { ...config(), hostname: "0.0.0.0", port: 10100 }]) {
    const fixture = await startForkModelApiFixtureWithDeps(candidate);
    try {
      expect(fixture.logicalBinds).toHaveLength(1);
      expect((await fetch(`${fixture.primaryUrl}/healthz`)).status).toBe(200);
      expect((await fetch(`${fixture.primaryUrl}/api/settings`, { headers: auth })).status).not.toBe(404);
    } finally { await fixture.close(); }
  }
});

test("auxiliary refuses admin-only credentials before binding", async () => {
  let binds = 0;
  await expect(startForkModelApiFixtureWithDeps({ ...config(), apiKeys: [] }, { bindListener(options) { binds++; return Bun.serve(options); } })).rejects.toThrow("data-plane credential");
  expect(binds).toBe(0);
});

test("second bind failure rolls back the primary socket and owner", async () => {
  let first: ReturnType<typeof Bun.serve> | undefined;
  let calls = 0;
  await expect(startForkModelApiFixtureWithDeps(config(), { bindListener(options) {
    if (++calls === 2) throw Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
    return first = Bun.serve(options);
  } })).rejects.toBeInstanceOf(AuxiliaryListenerBindError);
  expect(calls).toBe(2);
  const rebound = Bun.serve({ port: first!.port, hostname: "127.0.0.1", fetch: () => new Response("rebound") });
  await rebound.stop(true);
  expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
});

test("controller snapshot, owns, bind-once and repeated stop", async () => {
  const topology = resolveForkModelApiTopology(config());
  let calls = 0;
  let bound: ReturnType<typeof Bun.serve> | undefined;
  const controller = createForkModelApiListener(topology, { bind(options) { calls++; return bound = Bun.serve({ ...options, port: 0 }); }, track: server => server });
  expect(controller.snapshot()).toEqual({ topology, active: false, bind: null });
  controller.start({ fetch: () => new Response("ok") });
  controller.start({ fetch: () => new Response("unused") });
  expect(calls).toBe(1);
  expect(controller.snapshot()).toEqual({ topology, active: true, bind: { hostname: bound!.hostname, port: bound!.port } });
  await controller.stop(true);
  await controller.stop(true);
  expect(controller.snapshot().active).toBe(false);
});

test("both sockets stop and can bind again", async () => {
  const fixture = await startForkModelApiFixtureWithDeps(config());
  const ports = fixture.bound.map(server => server.port);
  await fixture.close();
  for (const port of ports) {
    const rebound = Bun.serve({ hostname: "0.0.0.0", port, fetch: () => new Response("ok") });
    await rebound.stop(true);
  }
});

test("a later management listener failure also rolls back the model API socket", async () => {
  const bound: ReturnType<typeof Bun.serve>[] = [];
  await expect(startForkModelApiFixtureWithDeps({ ...config(), runtimeRole: "hub", hub: {
    managementPublicOrigin: "https://hub.example.test", managementIngress: { enabled: true, port: 10102 },
  } }, { bindListener(options) {
    if (bound.length === 2) throw new Error("EADDRINUSE later listener");
    const server = Bun.serve(options);
    bound.push(server);
    return server;
  } })).rejects.toBeInstanceOf(AuxiliaryListenerBindError);
  expect(bound).toHaveLength(2);
  for (const server of bound) {
    const rebound = Bun.serve({ hostname: "0.0.0.0", port: server.port, fetch: () => new Response("ok") });
    await rebound.stop(true);
  }
  expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
});

test("server rejects an auxiliary port collision without binding", async () => {
  let calls = 0;
  await expect(startForkModelApiFixtureWithDeps({ ...config(), unauthenticatedLoopbackListener: { enabled: true, port: 10100 } }, {
    bindListener(options) { calls++; return Bun.serve(options); },
  })).rejects.toBeInstanceOf(AuxiliaryListenerBindError);
  expect(calls).toBe(0);
});

test("native Responses WebSocket registers on the receiving API server", async () => {
  const fixture = await startForkModelApiFixtureWithDeps({ ...config(), websockets: true });
  const primaryUpgrade = spyOn(fixture.server, "upgrade");
  const apiUpgrade = spyOn(fixture.bound[1]!, "upgrade");
  try {
    const opened = await new Promise<boolean>(resolve => {
      const socket = new WebSocket(fixture.apiUrl!.replace("http:", "ws:") + "/v1/responses", { headers: auth });
      const timeout = setTimeout(() => { socket.close(); resolve(false); }, 1500);
      socket.onopen = () => { clearTimeout(timeout); socket.close(); resolve(true); };
      socket.onerror = () => { clearTimeout(timeout); resolve(false); };
    });
    expect(opened).toBe(true);
    expect(primaryUpgrade).not.toHaveBeenCalled();
    expect(apiUpgrade).toHaveBeenCalledTimes(1);
  } finally { primaryUpgrade.mockRestore(); apiUpgrade.mockRestore(); await fixture.close(); }
});

test("main loopback session bootstrap stays native and its valid session cannot open auxiliary management", async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const port = probe.port;
  await probe.stop(true);
  const fixture = await startForkModelApiFixtureWithDeps({ ...config(), port }, {}, true);
  try {
    expect(fixture.server.port).toBe(port);
    const bootstrap = await fetch(`${fixture.primaryUrl}/opencodex-session`);
    expect(bootstrap.status).toBe(200);
    const html = await bootstrap.text();
    const token = html.match(/ocx_session_[A-Za-z0-9_-]+/)?.[0];
    expect(token).toBeDefined();
    const sessionHeaders = { "x-opencodex-api-key": token!, "x-opencodex-gui-origin": fixture.primaryUrl };
    expect((await fetch(`${fixture.primaryUrl}/api/settings`, { headers: sessionHeaders })).status).toBe(200);
    for (const path of ["/api/settings", "/opencodex-session", "/healthz", "/remote-workspace/pair"]) {
      const refused = await fetch(`${fixture.apiUrl}${path}`, { headers: sessionHeaders });
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ error: { code: "not_found" } });
    }
  } finally { await fixture.close(); }
});

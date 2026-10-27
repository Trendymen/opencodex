import { expect, test } from "bun:test";
import { loadConfig, saveConfig } from "../../src/config";
import { readRuntimePort, writeRuntimePort, writePid } from "../../src/config/process-state";
import { createForkModelApiListener } from "../../src/fork/model-api-listener";
import { resolveForkModelApiTopology } from "../../src/fork/model-api-listener-config";
import { parseForkModelApiRuntimeSnapshot, projectForkModelApiStatus } from "../../src/fork/model-api-listener-status";
import { createLocalManagementReadCapability, verifyLocalManagementReadCapability, LOCAL_MANAGEMENT_READ_PATHS } from "../../src/lib/local-management-capability";
import { LOCAL_ATTESTATION_PROOF_HEADER } from "../../src/lib/local-management-attestation";
import { fetchBoundLocalManagementRead } from "../../src/server/local-management-read-client";
import { startForkModelApiFixtureWithDeps } from "../helpers/fork-model-api-fixture";
import { getDefaultConfig } from "../../src/config";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { spawnTestChild } from "../helpers/spawn-test-child";
import { findAvailablePort, shouldPersistSelectedPort } from "../../src/server/ports";

function config() {
  return { ...getDefaultConfig(), hostname: "127.0.0.1", port: 10101,
    claudeCode: { intercept: { enabled: false } }, forkModelApiListener: { enabled: true },
    apiKeys: [{ id: "fixture", name: "fixture", key: "fixture-data-key", createdAt: "2026-01-01T00:00:00Z" }],
    providers: { local: { adapter: "openai-chat" as const, baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, models: ["fixture-model"] } }, defaultProvider: "local" };
}

async function attestedSnapshot(fixture: Awaited<ReturnType<typeof startForkModelApiFixtureWithDeps>>, secret: string) {
  const target = { pid: process.pid, port: fixture.server.port!, hostname: "127.0.0.1", source: "runtime" as const };
  writeRuntimePort({ ...target, attestationSecret: secret });
  const result = await fetchBoundLocalManagementRead(target, LOCAL_MANAGEMENT_READ_PATHS.systemHealth, { requireResponseProof: true });
  if (result.kind !== "response") throw new Error("Expected attested listener snapshot");
  const snapshot = parseForkModelApiRuntimeSnapshot((await result.response.json()).forkModelApiListener);
  if (!snapshot) throw new Error("Expected valid listener snapshot");
  return snapshot;
}

test("configured port zero keeps its initial allocation intent after CLI selection and startServer override", async () => {
  const candidate = { ...config(), port: 0 };
  const selected = await findAvailablePort(0, candidate.hostname, { allowEphemeralFallback: true });
  expect(selected).toBeGreaterThan(0);
  expect(shouldPersistSelectedPort(0, selected, 0)).toBe(false);
  const secret = "A".repeat(43);
  const fixture = await startForkModelApiFixtureWithDeps(candidate, { localAttestationSecret: secret }, false, { startPort: selected });
  try {
    expect(fixture.logicalBinds[0]!.port).toBe(selected);
    expect(loadConfig().port).toBe(0);
    const snapshot = await attestedSnapshot(fixture, secret);
    expect(snapshot.topology.primary.port).toBe(0);
    expect(projectForkModelApiStatus(resolveForkModelApiTopology(loadConfig()), snapshot, true).restartRequired).toBe(false);
    writePid(process.pid);
    const cli = await spawnTestChild([process.execPath, repoPath("src/cli/index.ts"), "status", "--json"], {
      cwd: repoRoot(), env: { ...process.env }, deadlineMs: 10000,
    });
    expect({ exit: cli.exitCode, stderr: cli.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(cli.stdout).forkModelApiListener).toMatchObject({ active: true, restartRequired: false });
  } finally { await fixture.close(); }
});

test("a fixed port saved as zero still requires restart and cannot rewrite the started intent", async () => {
  const secret = "A".repeat(43);
  const fixture = await startForkModelApiFixtureWithDeps(config(), { localAttestationSecret: secret });
  try {
    const before = await attestedSnapshot(fixture, secret);
    saveConfig({ ...loadConfig(), port: 0 });
    const after = await attestedSnapshot(fixture, secret);
    expect(after.topology).toEqual(before.topology);
    expect(after.topology.primary.port).toBe(10101);
    expect(projectForkModelApiStatus(resolveForkModelApiTopology(loadConfig()), after, true).restartRequired).toBe(true);
  } finally { await fixture.close(); }
});

test("a nonzero override retains effective topology comparison against a different desired port", async () => {
  const selected = await findAvailablePort(0, "127.0.0.1", { allowEphemeralFallback: true });
  const secret = "A".repeat(43);
  const fixture = await startForkModelApiFixtureWithDeps(config(), { localAttestationSecret: secret }, false, { startPort: selected });
  try {
    const snapshot = await attestedSnapshot(fixture, secret);
    expect(snapshot.topology.primary.port).toBe(selected);
    expect(loadConfig().port).toBe(10101);
    expect(projectForkModelApiStatus(resolveForkModelApiTopology(loadConfig()), snapshot, true).restartRequired).toBe(true);
  } finally { await fixture.close(); }
});

test("projection distinguishes stopped, unverified, disabled and native primary", () => {
  const desired = resolveForkModelApiTopology(config());
  expect(projectForkModelApiStatus(desired, null, false)).toEqual({ enabled: true, active: false, hostname: null, port: null, inactiveReason: "not-running", restartRequired: false });
  expect(projectForkModelApiStatus(desired, null, true)).toEqual({ enabled: true, active: null, hostname: null, port: null, inactiveReason: "unverified", restartRequired: null });
  for (const [candidate, reason] of [
    [{ ...config(), forkModelApiListener: { enabled: false } }, "disabled"],
    [{ ...config(), hostname: "0.0.0.0", port: 10100 }, "primary-non-loopback"],
  ] as const) {
    const topology = resolveForkModelApiTopology(candidate);
    expect(projectForkModelApiStatus(topology, { topology, active: false, bind: null }, true)).toMatchObject({
      active: false, hostname: null, port: null, inactiveReason: reason, restartRequired: false,
    });
  }
});

test("snapshot reports the actual socket while restart compares logical topology", async () => {
  const topology = resolveForkModelApiTopology(config());
  let bound: ReturnType<typeof Bun.serve> | undefined;
  const controller = createForkModelApiListener(topology, {
    bind(options) { return bound = Bun.serve({ ...options, hostname: "127.0.0.1", port: 0 }); }, track: server => server,
  });
  controller.start({ fetch: () => new Response("fixture") });
  try {
    expect(controller.snapshot().bind).toEqual({ hostname: bound!.hostname, port: bound!.port });
    expect(projectForkModelApiStatus(topology, controller.snapshot(), true)).toEqual({ enabled: true, active: true,
      hostname: bound!.hostname, port: bound!.port, inactiveReason: null, restartRequired: false });
    const changed = resolveForkModelApiTopology({ ...config(), port: 10102 });
    expect(projectForkModelApiStatus(changed, controller.snapshot(), true).restartRequired).toBe(true);
  } finally { await controller.stop(true); }
  expect(projectForkModelApiStatus(topology, controller.snapshot(), false).inactiveReason).toBe("not-running");
});

test("system health is an exact read capability, bound to method/path/PID/port/nonce", () => {
  const secret = "A".repeat(43), nonce = "B".repeat(43), now = Date.now(), expires = now + 10000;
  const path = LOCAL_MANAGEMENT_READ_PATHS.systemHealth;
  expect(path).toBe("/api/system/health");
  const capability = createLocalManagementReadCapability(secret, nonce, "GET", path, 4242, 31000, expires);
  expect(capability).toHaveLength(43);
  expect(verifyLocalManagementReadCapability(secret, nonce, "GET", path, 4242, 31000, expires, capability, now)).toBe(true);
  for (const [method, candidatePath, pid, port, candidateNonce] of [
    ["POST", path, 4242, 31000, nonce], ["GET", "/api/config", 4242, 31000, nonce],
    ["GET", path, 4243, 31000, nonce], ["GET", path, 4242, 31001, nonce], ["GET", path, 4242, 31000, "C".repeat(43)],
  ] as const) expect(verifyLocalManagementReadCapability(secret, candidateNonce, method, candidatePath, pid, port, expires, capability, now)).toBe(false);
  expect(createLocalManagementReadCapability(secret, nonce, "POST", path, 4242, 31000, expires)).toBeNull();
  expect(createLocalManagementReadCapability(secret, nonce, "GET", "/api/system/restart", 4242, 31000, expires)).toBeNull();
});

test("attested system health retains startup topology across desired save and restart", async () => {
  const candidate = config();
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") });
  candidate.port = probe.port!;
  await probe.stop(true);
  const secret = "A".repeat(43);
  const fixture = await startForkModelApiFixtureWithDeps(candidate, { localAttestationSecret: secret }, true);
  try {
    const target = { pid: process.pid, port: fixture.server.port!, hostname: "127.0.0.1", source: "runtime" as const };
    writeRuntimePort({ pid: process.pid, port: fixture.server.port!, hostname: "127.0.0.1", attestationSecret: secret });
    writePid(process.pid);
    const read = () => fetchBoundLocalManagementRead(target, LOCAL_MANAGEMENT_READ_PATHS.systemHealth, { requireResponseProof: true });
    const first = await read();
    expect(first).toMatchObject({ kind: "response" });
    if (first.kind !== "response") throw new Error("Expected attested health");
    const health = await first.response.json();
    expect(health.forkModelApiListener).toMatchObject({ topology: resolveForkModelApiTopology(candidate), active: true,
      bind: { hostname: fixture.bound[1]!.hostname, port: fixture.bound[1]!.port } });
    saveConfig({ ...loadConfig(), forkModelApiListener: { enabled: false } });
    const second = await read();
    if (second.kind !== "response") throw new Error("Expected attested health after save");
    expect((await second.response.json()).forkModelApiListener).toEqual(health.forkModelApiListener);
    expect(projectForkModelApiStatus(resolveForkModelApiTopology(loadConfig()), health.forkModelApiListener, true)).toMatchObject({ active: true, restartRequired: true });
    const cli = await spawnTestChild([process.execPath, repoPath("src/cli/index.ts"), "status", "--json"], {
      cwd: repoRoot(), env: { ...process.env }, deadlineMs: 10000,
    });
    expect({ exit: cli.exitCode, stderr: cli.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(cli.stdout).forkModelApiListener).toMatchObject({ enabled: false, active: true, port: fixture.bound[1]!.port, restartRequired: true });
    expect((await fetch(`${fixture.apiUrl}/v1/models`, { headers: { "x-opencodex-api-key": "fixture-data-key" } })).status).toBe(200);
    const runtime = readRuntimePort(process.pid)!;
    expect(JSON.stringify(health)).not.toContain(runtime.attestationSecret!);
    expect(JSON.stringify(health)).not.toContain("fixture-data-key");
    expect(JSON.stringify(health)).not.toContain(fixture.adminToken);
    const forged = await fetchBoundLocalManagementRead(target, LOCAL_MANAGEMENT_READ_PATHS.systemHealth, {
      requireResponseProof: true,
      fetchImpl: Object.assign(async () => Response.json(health, { headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: "C".repeat(43) } }), { preconnect: fetch.preconnect }),
    });
    expect(forged).toEqual({ kind: "unavailable", reason: "unattested-response" });
  } finally { await fixture.close(); }
  const restarted = await startForkModelApiFixtureWithDeps({ ...candidate, forkModelApiListener: { enabled: false } }, { localAttestationSecret: secret }, true);
  try {
    writeRuntimePort({ pid: process.pid, port: restarted.server.port!, hostname: "127.0.0.1", attestationSecret: secret });
    const result = await fetchBoundLocalManagementRead({ pid: process.pid, port: restarted.server.port!, hostname: "127.0.0.1", source: "runtime" }, LOCAL_MANAGEMENT_READ_PATHS.systemHealth, { requireResponseProof: true });
    if (result.kind !== "response") throw new Error("Expected attested restarted health");
    const health = await result.response.json();
    expect(projectForkModelApiStatus(resolveForkModelApiTopology(loadConfig()), health.forkModelApiListener, true)).toMatchObject({ enabled: false, active: false, inactiveReason: "disabled", restartRequired: false });
  } finally { await restarted.close(); }
});

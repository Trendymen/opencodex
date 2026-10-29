import { expect, test } from "bun:test";
import { getDefaultConfig } from "../../src/config";
import { runForkModelApiCliFixture } from "../helpers/fork-model-api-cli-fixture";

for (const scenario of ["preflight-busy", "bind-race", "primary-busy"] as const) {
  for (const explicit of [false, true]) {
    test(`fixed topology: ${scenario}, explicit=${explicit}`, async () => {
      const config = { ...getDefaultConfig(), hostname: "127.0.0.1", port: 10101, claudeCode: { intercept: { enabled: false } }, forkModelApiListener: { enabled: true } };
      const result = await runForkModelApiCliFixture(explicit ? ["start", "--port", "10101"] : ["start"], config, scenario);
      expect(result.exitCode).not.toBe(0);
      expect(result.ownerProbes).toContainEqual({ hostname: "127.0.0.1", port: 10101, result: "ECONNREFUSED" });
      expect(result.ownerProbes).toContainEqual({ hostname: "[::1]", port: 10101, result: "ECONNREFUSED" });
      expect(result.ownerProbes.every(probe => probe.result === "ECONNREFUSED")).toBe(true);
      expect(result.stderr + result.stdout).not.toContain("picking another");
      expect(result.stderr + result.stdout).toContain(scenario === "primary-busy" ? "refusing ephemeral fallback" : "Could not bind forkModelApiListener at 0.0.0.0:10100");
      expect(result.logicalBinds.some(bind => bind.hostname === "0.0.0.0" && bind.port === 10100)).toBe(true);
      expect(result.logicalBinds.every(bind => [10100, 10101].includes(bind.port))).toBe(true);
      if (scenario === "bind-race") expect(result.logicalBinds.filter(bind => bind.kind === "bun").map(bind => bind.port)).toEqual([10101, 10100]);
      if (scenario === "primary-busy") expect(result.logicalBinds.some(bind => bind.kind === "bun")).toBe(false);
    }, 20_000);
  }
}

test("unknown owner response refuses startup before binding and preserves state", async () => {
  const config = { ...getDefaultConfig(), hostname: "127.0.0.1", port: 10101, claudeCode: { intercept: { enabled: false } }, forkModelApiListener: { enabled: true } };
  const result = await runForkModelApiCliFixture(["start"], config, "owner-unknown");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("Proxy ownership is unverified; startup refused");
  expect(result.ownerProbes).toContainEqual({ hostname: "127.0.0.1", port: 10101, result: "fixture" });
  expect(result.ownerProbes).toContainEqual({ hostname: "[::1]", port: 10101, result: "fixture" });
  expect(result.fixtureResponses).toBeGreaterThanOrEqual(2);
  expect(result.logicalBinds).toEqual([]);
  expect(result.ownerState?.before.pid).toBe(String(process.pid));
  expect(result.ownerState?.after).toEqual(result.ownerState?.before);
});

test("configured port zero allows one initial OS selection but no bind-race retry", async () => {
  const config = { ...getDefaultConfig(), hostname: "127.0.0.1", port: 0, claudeCode: { intercept: { enabled: false } }, forkModelApiListener: { enabled: true } };
  const result = await runForkModelApiCliFixture(["start"], config, "bind-race");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("Could not bind forkModelApiListener at 0.0.0.0:10100");
  const binds = result.logicalBinds.filter(bind => bind.kind === "bun");
  expect(binds).toHaveLength(2);
  expect(binds[0]!.port).toBeGreaterThan(0);
  expect(binds[0]!.port).not.toBe(10100);
  expect(binds[1]!.port).toBe(10100);
  expect(result.logicalBinds.filter(bind => bind.kind === "node" && bind.port === 0)).toHaveLength(1);
  expect(result.stderr + result.stdout).not.toContain("picking another");
}, 20_000);

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armClaudeCodeBaseline, getConfigPath, getDefaultConfig, loadConfig,
  mutatePersistedConfig, saveConfig, saveConfigPreservingClaudeCode, validateConfigCandidate,
} from "../../src/config";
import { configDiagnosticsFromRaw } from "../../src/config/diagnostics";
import {
  assertForkModelApiLoadPreserved, assertForkModelApiRawConfig,
  ForkModelApiConfigurationError, resolveForkModelApiTopology,
} from "../../src/fork/model-api-listener-config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const enabled = { enabled: true };
let home: string;
let previousHome: string | undefined;
let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-model-api-config-"));
  process.env.OPENCODEX_HOME = home;
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function candidate(extra: Record<string, unknown> = {}) {
  return { ...getDefaultConfig(), port: 10101, ...extra };
}

function writeCandidate(extra: Record<string, unknown>) {
  writeFileSync(getConfigPath(), JSON.stringify(candidate(extra)), "utf8");
}

describe("model API topology", () => {
  test.each([undefined, { enabled: false }])("disabled option keeps the original main port: %j", option => {
    expect(resolveForkModelApiTopology({ hostname: "0.0.0.0", port: 22000, forkModelApiListener: option })).toEqual({
      mode: "disabled", primary: { hostname: "0.0.0.0", port: 22000 }, listener: null,
    });
  });

  test.each([undefined, "", "localhost", "localhost.", " LOCALHOST. ", "127.0.0.1", "::1", "[::1]"])("loopback %j gets a separate model listener", hostname => {
    const result = resolveForkModelApiTopology({ hostname, port: 10101, forkModelApiListener: enabled });
    expect(result.mode).toBe("auxiliary");
    expect(result.listener).toEqual({ hostname: "0.0.0.0", port: 10100 });
    expect(result.primary).toEqual({ hostname: hostname?.includes("::1") ? hostname : "127.0.0.1", port: 10101 });
  });

  test.each(["0.0.0.0", "::", "192.168.1.10", "relay.example.test", "custom.localhost"])("nonloopback %s uses only the primary on 10100", hostname => {
    expect(resolveForkModelApiTopology({ hostname, port: 10100, forkModelApiListener: enabled })).toEqual({
      mode: "primary", primary: { hostname, port: 10100 }, listener: null,
    });
    expect(() => resolveForkModelApiTopology({ hostname, port: 10101, forkModelApiListener: enabled })).toThrow(ForkModelApiConfigurationError);
  });

  test("the default or explicit loopback port cannot collide with 10100", () => {
    expect(() => resolveForkModelApiTopology({ forkModelApiListener: enabled })).toThrow(ForkModelApiConfigurationError);
    expect(() => resolveForkModelApiTopology({ hostname: "127.0.0.1", port: 10100, forkModelApiListener: enabled })).toThrow(ForkModelApiConfigurationError);
    expect(resolveForkModelApiTopology({ port: 22000, forkModelApiListener: enabled }).primary.port).toBe(22000);
  });

  test("the CLI effective main port controls collision and primary mode checks", () => {
    expect(resolveForkModelApiTopology({ port: 10100, forkModelApiListener: enabled }, 10101).mode).toBe("auxiliary");
    expect(() => resolveForkModelApiTopology({ port: 10101, forkModelApiListener: enabled }, 10100)).toThrow(ForkModelApiConfigurationError);
    expect(resolveForkModelApiTopology({ hostname: "0.0.0.0", port: 10101, forkModelApiListener: enabled }, 10100).mode).toBe("primary");
    expect(() => resolveForkModelApiTopology({ hostname: "0.0.0.0", port: 10100, forkModelApiListener: enabled }, 10101)).toThrow(ForkModelApiConfigurationError);
  });

  test("an omitted nonloopback main port keeps the native default", () => {
    expect(resolveForkModelApiTopology({ hostname: "0.0.0.0", forkModelApiListener: enabled })).toEqual({
      mode: "primary", primary: { hostname: "0.0.0.0", port: 10100 }, listener: null,
    });
  });
});

describe("strict candidate and file loading", () => {
  test.each([null, true, "true", {}, { enabled: "true" }, { enabled: false, port: 10100 }, { enabled: true, extra: true }])("rejects malformed option %j on write and real load", forkModelApiListener => {
    const raw = candidate({ forkModelApiListener });
    expect(validateConfigCandidate(raw).ok).toBe(false);
    expect(() => assertForkModelApiRawConfig(raw)).toThrow(ForkModelApiConfigurationError);
    saveConfig(candidate());
    const before = readFileSync(getConfigPath(), "utf8");
    expect(() => saveConfig(raw)).toThrow();
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    expect(() => loadConfig()).toThrow(ForkModelApiConfigurationError);
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8"))).toEqual(raw);
  });

  test.each([
    { hostname: "127.0.0.1", port: 10100 },
    { hostname: "0.0.0.0", port: 10101 },
    { hostname: null }, { port: "10101" },
  ])("rejects enabled invalid topology before fallback: %j", extra => {
    const raw = candidate({ ...extra, forkModelApiListener: enabled });
    expect(validateConfigCandidate(raw).ok).toBe(false);
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    expect(() => loadConfig()).toThrow(ForkModelApiConfigurationError);
  });

  test.each([
    {},
    { defaultProvider: undefined },
    { combos: { broken: { targets: [] } } },
  ])("retains explicit enable on normal, repair and salvage loads: %j", extra => {
    writeCandidate({ ...extra, forkModelApiListener: enabled });
    const loaded = loadConfig();
    expect(loaded.forkModelApiListener).toEqual(enabled);
    expect(loaded.port).toBe(10101);
    expect(resolveForkModelApiTopology(loaded).mode).toBe("auxiliary");
    if ("combos" in extra) expect(loaded.combos?.broken).toBeUndefined();
    const diagnostics = configDiagnosticsFromRaw(readFileSync(getConfigPath(), "utf8"));
    expect(diagnostics.config.forkModelApiListener).toEqual(enabled);
    expect(resolveForkModelApiTopology(diagnostics.config).mode).toBe("auxiliary");
  });

  test("an explicit null main port is rejected before a direct save can replace the file", () => {
    saveConfig(candidate());
    const before = readFileSync(getConfigPath(), "utf8");
    const invalid = candidate({ hostname: "0.0.0.0", port: null, forkModelApiListener: enabled });
    expect(() => saveConfig(invalid)).toThrow(ForkModelApiConfigurationError);
    expect(() => assertForkModelApiRawConfig(invalid)).toThrow(ForkModelApiConfigurationError);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(loadConfig().port).toBe(10101);
  });

  test.each([
    { hostname: null },
    { hostname: "127.0.0.1", port: 10100 },
    { hostname: "0.0.0.0", port: 10101 },
    { hostname: "0.0.0.0", port: null },
  ])("invalid raw topology cannot be normalized and rewritten by an unrelated mutation: %j", extra => {
    const before = JSON.stringify(candidate({ ...extra, forkModelApiListener: enabled }));
    writeFileSync(getConfigPath(), before);
    const diagnostics = configDiagnosticsFromRaw(before);
    let called = false;
    const outcome = mutatePersistedConfig(config => {
      called = true;
      config.logLevel = "warn";
      return { changed: true, value: null };
    });
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("forkModelApiListener:");
    expect(diagnostics.error).not.toBe("invalid_json");
    expect(outcome).toEqual({ status: "unavailable", reason: "invalid" });
    expect(called).toBe(false);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test.each([undefined, { enabled: false }])("diagnostics keep legacy hostname degradation when the listener is %j", forkModelApiListener => {
    writeCandidate({ hostname: null, forkModelApiListener });
    const diagnostics = configDiagnosticsFromRaw(readFileSync(getConfigPath(), "utf8"));
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config.hostname).toBeUndefined();
    expect(mutatePersistedConfig(config => {
      config.logLevel = "warn";
      return { changed: true, value: null };
    }).status).toBe("committed");
    expect(loadConfig().logLevel).toBe("warn");
  });

  test("explicit enable cannot fall through an unrelated unsalvageable error", () => {
    writeCandidate({ providers: "invalid", forkModelApiListener: enabled });
    expect(() => loadConfig()).toThrow(ForkModelApiConfigurationError);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test("unexpected load errors cannot silently discard an explicit enable", () => {
    writeCandidate({ forkModelApiListener: enabled, nativeReasoningRetention: { modelSwitch: "invalid" } });
    warn.mockImplementationOnce(() => { throw new Error("synthetic warning failure"); });
    expect(() => loadConfig()).toThrow(ForkModelApiConfigurationError);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, { enabled: false }])("unrelated legacy fallback still works when option is %j", forkModelApiListener => {
    writeCandidate({ providers: "invalid", forkModelApiListener });
    expect(loadConfig().forkModelApiListener?.enabled).not.toBe(true);
  });

  test("load preservation refuses dropped enable or changed topology", () => {
    const raw = candidate({ forkModelApiListener: enabled });
    expect(() => assertForkModelApiLoadPreserved(raw, candidate())).toThrow(ForkModelApiConfigurationError);
    expect(() => assertForkModelApiLoadPreserved(raw, { ...raw, hostname: "0.0.0.0", port: 10100 })).toThrow(ForkModelApiConfigurationError);
    expect(() => assertForkModelApiLoadPreserved(raw, { ...raw })).not.toThrow();
  });

  test("valid save/load round trips keep omitted, disabled and enabled options", () => {
    for (const forkModelApiListener of [undefined, { enabled: false }, enabled]) {
      const checked = validateConfigCandidate(candidate({ forkModelApiListener }));
      expect(checked.ok).toBe(true);
      if (!checked.ok) throw new Error(checked.error);
      saveConfig(checked.config);
      expect(loadConfig().forkModelApiListener).toEqual(forkModelApiListener);
    }
  });
});

test.each([true, false, undefined])("desired setting %j survives guarded saves while active topology stays unchanged", desired => {
  saveConfig(candidate({ forkModelApiListener: { enabled: false } }));
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  const disk = loadConfig();
  disk.forkModelApiListener = desired === undefined ? undefined : { enabled: desired };
  saveConfig(disk);
  live.logLevel = "warn";
  saveConfigPreservingClaudeCode(live);
  saveConfigPreservingClaudeCode(live);
  expect(live.forkModelApiListener).toEqual({ enabled: false });
  expect(loadConfig().forkModelApiListener).toEqual(desired === undefined ? undefined : { enabled: desired });
});

test("disabling an enabled desired listener does not disable the active topology", () => {
  saveConfig(candidate({ forkModelApiListener: enabled }));
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  const disk = loadConfig();
  disk.forkModelApiListener = { enabled: false };
  saveConfig(disk);
  saveConfigPreservingClaudeCode(live);
  expect(live.forkModelApiListener).toEqual(enabled);
  expect(loadConfig().forkModelApiListener).toEqual({ enabled: false });
});

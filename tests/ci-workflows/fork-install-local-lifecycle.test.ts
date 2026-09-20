import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePackageModes } from "../../scripts/prepare-package";
import { runLocalInstallLifecycle, validatedPackedTarball } from "../../scripts/install-local";
import { repoPath } from "../helpers/repo-root";

// Windows CI runners spawn Node/Bun child processes slowly ("Slow filesystem detected");
// the package-main import test measured 9.4s there vs bun's 5s default. Same remedy as
// codex-history-provider / cursor-mcp-stdio.
setDefaultTimeout(30_000);

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function removeModeFixture(path: string): void {
  try { chmodSync(path, 0o700); } catch { /* best-effort cleanup */ }
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

function systemCommandPath(command: string): string {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`required test command is unavailable: ${command}`);
  }
  return result.stdout.trim();
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, { encoding: "utf8", mode: 0o755 });
}

async function readText(path: string): Promise<string> {
  return await Bun.file(repoPath(path)).text();
}

describe("fork install-local lifecycle", () => {
test("validates the active npm or version-manager runtime before stopping the service", async () => {
  const installer = await readText("scripts/install-local.ts");
  const main = installer.slice(installer.indexOf("export async function runLocalInstaller"));
  const preflight = main.indexOf("currentInstalledRuntime();");
  const lifecycle = main.indexOf("await runLocalInstallLifecycleWithManifestGuard(");
  expect(preflight).toBeGreaterThan(-1);
  expect(preflight).toBeLessThan(lifecycle);
});

test("local installer preserves an installed service and refuses a loaded manager after stop", async () => {
  const installer = await readText("scripts/install-local.ts");
  expect(installer).toContain("const serviceProbe = probeLocalServiceInstallation();");
  expect(installer).toContain("requireKnownServiceInstallation(serviceProbe);");
  expect(installer).toContain("const serviceDiagnostic = diagnoseService();");
  expect(installer).toContain("assertNoRunningService(serviceDiagnostic);");
  expect(installer).toContain("[\"ocx\", \"service\", \"repair\"]");
  expect(installer).toContain("Background service is still loaded after ocx stop");
});

test("local installer snapshots launchd through the tri-state probe and refuses unknown state", async () => {
  const installer = await readText("scripts/install-local.ts");
  expect(installer).toContain("const launchdLoad = serviceWasInstalled && process.platform === \"darwin\"");
  expect(installer).toContain("probeLaunchdLoadState()");
  expect(installer).toContain('if (launchdLoad?.state === "unknown")');
  expect(installer).toContain('launchdLoad?.state !== "loaded-current" && launchdLoad?.state !== "loaded-stale"');
  expect(installer).toContain("restartAfterRollback: launchdSnapshot");
  expect(installer).not.toContain("captureProviderDebugLaunchdSnapshot(launchdProxyPlistPath(), diagnoseService().running)");
});

test("local installer restores the macOS debug defaults and keeps the runtime call signatures aligned", async () => {
  const installer = await readText("scripts/install-local.ts");
  const main = installer.slice(installer.indexOf("export async function runLocalInstaller"));
  expect(main).toContain("localInstallAfterReplace(serviceWasInstalled, restart)");
  expect(main).toContain("restartLocalInstall(serviceWasInstalled, {}, process.platform, current.runtime)");
  expect(installer).toContain("OCX_DEBUG");
  expect(installer).toContain("OCX_PROVIDER_TEXT_DEBUG");
  expect(installer).toContain("ensureProviderDebugLaunchdDefault");
  expect(installer).toContain("refreshProviderDebugLaunchd");
});

test("local installer chooses foreground start only when no service was installed", async () => {
  const module = await import("../../scripts/install-local");
  const choose = (module as unknown as {
    localInstallRestartArgs?: (serviceWasInstalled: boolean) => string[];
  }).localInstallRestartArgs;
  expect(typeof choose).toBe("function");
  if (!choose) return;
  expect(choose(false)).toEqual(["ocx", "start"]);
  expect(choose(true)).toEqual(["ocx", "service", "repair"]);
});

test("local installer refuses to replace the package while a service manager is loaded", async () => {
  const module = await import("../../scripts/install-local");
  const assertStopped = (module as unknown as {
    assertNoRunningService?: (diagnostic: { running: boolean; backend: string | null }) => void;
  }).assertNoRunningService;
  expect(typeof assertStopped).toBe("function");
  if (!assertStopped) return;
  expect(() => assertStopped({ running: true, backend: "launchd" })).toThrow(/Background service is still loaded after ocx stop/);
  expect(() => assertStopped({ running: false, backend: "launchd" })).not.toThrow();
  expect(() => assertStopped({ running: true, backend: "scheduler" })).not.toThrow();
  expect(() => assertStopped({ running: true, backend: "native" })).toThrow(/Background service is still loaded after ocx stop/);
});

test("local installer fails closed when service installation state is unknown", async () => {
  const module = await import("../../scripts/install-local");
  const requireKnown = (module as unknown as {
    requireKnownServiceInstallation?: (probe: { state: "installed" | "absent" | "unknown"; detail?: string }) => boolean;
  }).requireKnownServiceInstallation;
  expect(typeof requireKnown).toBe("function");
  if (!requireKnown) return;
  expect(requireKnown({ state: "installed" })).toBe(true);
  expect(requireKnown({ state: "absent" })).toBe(false);
  expect(() => requireKnown({ state: "unknown", detail: "scheduler query failed" }))
    .toThrow(/Background service state is unknown/);
});

test("local installer stops and verifies before replacement, and aborts replacement on stop failure", async () => {
  const module = await import("../../scripts/install-local");
  const runLifecycle = (module as unknown as {
    runLocalInstallLifecycle?: (restart: boolean, deps: {
      stop: () => void | Promise<void>;
      verifyStopped: () => void | Promise<void>;
      replace: () => void | Promise<void>;
      restart?: () => void | Promise<void>;
      ready?: () => void | Promise<void>;
    }) => Promise<void>;
  }).runLocalInstallLifecycle;
  expect(typeof runLifecycle).toBe("function");
  if (!runLifecycle) return;

  const events: string[] = [];
  await runLifecycle(true, {
    stop: () => { events.push("stop"); },
    verifyStopped: () => { events.push("verify"); },
    replace: () => { events.push("replace"); },
    restart: () => { events.push("restart"); },
    ready: () => { events.push("ready"); },
  });
  expect(events).toEqual(["stop", "verify", "replace", "restart", "ready"]);

  events.length = 0;
  await expect(runLifecycle(true, {
    stop: () => { events.push("stop"); throw new Error("stop failed"); },
    verifyStopped: () => { events.push("verify"); },
    replace: () => { events.push("replace"); },
    restart: () => { events.push("restart"); },
    ready: () => { events.push("ready"); },
  })).rejects.toThrow("stop failed");
  expect(events).toEqual(["stop"]);

  events.length = 0;
  await expect(runLifecycle(true, {
    stop: () => { events.push("stop"); },
    verifyStopped: () => { events.push("verify"); throw new Error("service still loaded"); },
    replace: () => { events.push("replace"); },
    restart: () => { events.push("restart"); },
    ready: () => { events.push("ready"); },
  })).rejects.toThrow("service still loaded");
  expect(events).toEqual(["stop", "verify"]);

  events.length = 0;
  await runLifecycle(false, {
    stop: () => { events.push("stop"); },
    verifyStopped: () => { events.push("verify"); },
    replace: () => { events.push("replace"); },
    restart: () => { events.push("restart"); },
    ready: () => { events.push("ready"); },
  });
  expect(events).toEqual(["stop", "verify", "replace"]);
});

test("restores configuration after every deferred rollback attempt and only starts after safe recovery", async () => {
  const events: string[] = [];
  let newRuntimeReady = false;

  await expect(runLocalInstallLifecycle(true, {
    stop: () => { events.push("stop"); },
    verifyStopped: () => { events.push("verify"); },
    replace: () => ({
      commit: () => ({ ok: true, phase: "committed" }),
      rollback: () => { events.push("rollback"); return { ok: true, phase: "rolled-back" }; },
    }),
    restart: () => { events.push("restart"); },
    ready: () => {
      events.push("ready");
      if (!newRuntimeReady) {
        newRuntimeReady = true;
        throw new Error("new runtime readiness failed");
      }
    },
    afterRollback: () => { events.push("restore-plist"); },
    restartAfterRollback: () => { events.push("load-restored-launchd"); return true; },
  })).rejects.toThrow("new runtime readiness failed");

  expect(events).toEqual([
    "stop", "verify", "restart", "ready",
    "stop", "verify", "rollback", "restore-plist", "load-restored-launchd", "ready",
  ]);
});

test("keeps the replacement failure primary when the restored runtime does not become ready", async () => {
  const events: string[] = [];
  const replacementFailure = new Error("new runtime readiness failed");
  const restoredRuntimeFailure = new Error("restored runtime readiness failed");
  let readyCalls = 0;

  let thrown: unknown;
  try {
    await runLocalInstallLifecycle(true, {
      stop: () => { events.push("stop"); },
      verifyStopped: () => { events.push("verify"); },
      replace: () => ({
        commit: () => ({ ok: true, phase: "committed" }),
        rollback: () => { events.push("rollback"); return { ok: true, phase: "rolled-back" }; },
      }),
      restart: () => { events.push("restart-new"); },
      ready: () => {
        readyCalls += 1;
        events.push(`ready-${readyCalls}`);
        throw readyCalls === 1 ? replacementFailure : restoredRuntimeFailure;
      },
      afterRollback: () => { events.push("restore-plist"); },
      restartAfterRollback: () => { events.push("load-restored-launchd"); return true; },
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(AggregateError);
  expect((thrown as AggregateError).errors).toEqual([replacementFailure, restoredRuntimeFailure]);
  expect(events).toEqual([
    "stop", "verify", "restart-new", "ready-1",
    "stop", "verify", "rollback", "restore-plist", "load-restored-launchd", "ready-2",
  ]);
});

test("attempts configuration restore but does not start when rollback or restoration is unsafe", async () => {
  for (const rollback of [
    () => ({ ok: false, phase: "rollback", error: "backup unsafe", recoveryUnsafe: true }),
    () => { throw new Error("rollback threw"); },
  ]) {
    const events: string[] = [];
    await expect(runLocalInstallLifecycle(true, {
      stop: () => { events.push("stop"); },
      verifyStopped: () => { events.push("verify"); },
      replace: () => ({
        commit: () => ({ ok: true, phase: "committed" }),
        rollback: () => { events.push("rollback"); return rollback(); },
      }),
      restart: () => { events.push("restart"); },
      ready: () => { events.push("ready"); throw new Error("new runtime readiness failed"); },
      afterRollback: () => { events.push("restore-plist"); },
      restartAfterRollback: () => { events.push("unexpected-restart"); return true; },
    })).rejects.toThrow("local package replacement failed");
    expect(events).toEqual(["stop", "verify", "restart", "ready", "stop", "verify", "rollback", "restore-plist"]);
  }
});

test("does not start a restored service when the second stop check or plist restoration fails", async () => {
  for (const scenario of [
    { secondVerifyFails: false, afterRollback: () => { throw new Error("plist restoration failed"); } },
    { secondVerifyFails: true, afterRollback: () => {} },
  ]) {
    const events: string[] = [];
    let verifies = 0;
    await expect(runLocalInstallLifecycle(true, {
      stop: () => { events.push("stop"); },
      verifyStopped: () => {
        events.push("verify");
        verifies += 1;
        if (scenario.secondVerifyFails && verifies === 2) throw new Error("new runtime did not stop");
      },
      replace: () => ({
        commit: () => ({ ok: true, phase: "committed" }),
        rollback: () => { events.push("rollback"); return { ok: true, phase: "rolled-back" }; },
      }),
      restart: () => { events.push("restart"); },
      ready: () => { events.push("ready"); throw new Error("new runtime readiness failed"); },
      afterRollback: () => { events.push("restore-plist"); return scenario.afterRollback(); },
      restartAfterRollback: () => { events.push("unexpected-restart"); return true; },
    })).rejects.toThrow("local package replacement failed");
    expect(events).toEqual(scenario.secondVerifyFails
      ? ["stop", "verify", "restart", "ready", "stop", "verify", "restore-plist"]
      : ["stop", "verify", "restart", "ready", "stop", "verify", "rollback", "restore-plist"]);
  }
});

test("does not wait for readiness when the old launchd service was originally unloaded or restart is disabled", async () => {
  for (const restart of [true, false]) {
    const events: string[] = [];
    await expect(runLocalInstallLifecycle(restart, {
      stop: () => { events.push("stop"); },
      verifyStopped: () => { events.push("verify"); },
      replace: () => ({
        commit: () => ({ ok: true, phase: "committed" }),
        rollback: () => { events.push("rollback"); return { ok: true, phase: "rolled-back" }; },
      }),
      afterReplace: () => { throw new Error("post-replace failure"); },
      restart: () => { events.push("unexpected-restart"); },
      ready: () => { events.push("unexpected-ready"); },
      afterRollback: () => { events.push("restore-plist"); },
      restartAfterRollback: () => { events.push("loaded-state-check"); return false; },
    })).rejects.toThrow("post-replace failure");
    expect(events).toEqual(restart
      ? ["stop", "verify", "stop", "verify", "rollback", "restore-plist", "loaded-state-check"]
      : ["stop", "verify", "rollback", "restore-plist"]);
  }
});


  test("local installer accepts only a root-local regular tgz from npm JSON", () => {
      const fixture = mkdtempSync(join(tmpdir(), "ocx-local-pack-"));
      const tarball = join(fixture, "fork.tgz");
      try {
        writeFileSync(tarball, "fixture");
        expect(validatedPackedTarball(fixture, JSON.stringify([{ filename: "fork.tgz" }]))).toBe(tarball);
        expect(() => validatedPackedTarball(fixture, JSON.stringify([{ filename: "../outside.tgz" }]))).toThrow();
        expect(() => validatedPackedTarball(fixture, JSON.stringify([{ filename: "not-a-tarball.txt" }]))).toThrow();
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
  });

});

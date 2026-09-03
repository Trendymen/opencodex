import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { bootRestoreProbe, transactionalNpmUpdate } from "../src/update/transactional-install.mjs";
import { runLocalInstallLifecycle } from "../scripts/install-local";

const roots: string[] = [];
const pkgName = "@bitkyc08/opencodex";

function packageTree(packageDir: string, version: string): void {
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  mkdirSync(join(packageDir, "node_modules", "zod"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: pkgName,
    version,
    bin: { ocx: "bin/ocx.mjs" },
    dependencies: { zod: "1" },
  }));
  writeFileSync(join(packageDir, "bin", "ocx.mjs"), "x".repeat(2_048));
  writeFileSync(join(packageDir, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod" }));
}

function version(packageDir: string): string {
  return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
}

function deferredFixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-deferred-transaction-"));
  roots.push(root);
  const packageDir = join(root, "scope", "opencodex");
  const stagedTree = join(root, "prepared");
  packageTree(packageDir, "2.40.0-ben.2");
  packageTree(stagedTree, "2.40.0-ben.3");
  const result = transactionalNpmUpdate({
    packageDir,
    pkgName,
    targetVersion: "2.40.0-ben.3",
    tag: "latest",
    deferCommit: true,
    runNpm: (args: string[]) => {
      const prefix = args[args.indexOf("--prefix") + 1]!;
      const target = join(prefix, "lib", "node_modules", "@bitkyc08", "opencodex");
      mkdirSync(dirname(target), { recursive: true });
      cpSync(stagedTree, target, { recursive: true });
      return { status: 0 };
    },
    verifyLive: packageDir => {
      const probe = bootRestoreProbe(packageDir);
      return probe.action === "pending"
        ? { ok: true, failures: [] }
        : { ok: false, failures: [`launcher probe reaped a pending backup: ${probe.action}`] };
    },
  });
  return { root, packageDir, result };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("install:local deferred package transaction", () => {
  test("keeps the backup while a healthy new launcher probes during a pending transaction", () => {
    const { packageDir, result } = deferredFixture();
    expect(result).toMatchObject({ ok: true, phase: "pending" });
    expect(version(packageDir)).toBe("2.40.0-ben.3");
    expect(existsSync(result.backup!)).toBe(true);

    expect(bootRestoreProbe(packageDir)).toMatchObject({ action: "pending" });
    expect(existsSync(result.backup!)).toBe(true);

    expect(result.commit!()).toMatchObject({ ok: true, phase: "committed" });
    expect(existsSync(result.backup!)).toBe(false);
  });

  test("rolls back package bytes after a post-swap lifecycle failure", () => {
    const { packageDir, result } = deferredFixture();
    expect(result.ok).toBe(true);
    expect(result.rollback!()).toMatchObject({ ok: true, phase: "rolled-back" });
    expect(version(packageDir)).toBe("2.40.0-ben.2");
  });

  test("returns recovery-unsafe when rollback and recovery-marker writes both fail", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-deferred-marker-fault-"));
    roots.push(root);
    const packageDir = join(root, "scope", "opencodex");
    const stagedTree = join(root, "prepared");
    packageTree(packageDir, "2.40.0-ben.2");
    packageTree(stagedTree, "2.40.0-ben.3");
    let renames = 0;
    const result = transactionalNpmUpdate({
      packageDir,
      pkgName,
      targetVersion: "2.40.0-ben.3",
      tag: "latest",
      runNpm: (args: string[]) => {
        const prefix = args[args.indexOf("--prefix") + 1]!;
        const target = join(prefix, "lib", "node_modules", "@bitkyc08", "opencodex");
        mkdirSync(dirname(target), { recursive: true });
        cpSync(stagedTree, target, { recursive: true });
        return { status: 0 };
      },
      deps: {
        rename: (from: string, to: string) => {
          renames += 1;
          if (renames >= 2) throw new Error("EPERM: rename blocked");
          require("node:fs").renameSync(from, to);
        },
        writeRecoveryFile: () => { throw new Error("ENOSPC: marker blocked"); },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      phase: "double-fault",
      rolledBack: false,
      recoveryUnsafe: true,
      markerWriteFailed: true,
    });
  });

  test("rolls back before returning a no-restart configuration failure", async () => {
    const events: string[] = [];
    const failure = new Error("launchd configuration failed");
    await expect(runLocalInstallLifecycle(false, {
      stop: () => { events.push("stop"); },
      verifyStopped: () => { events.push("verify"); },
      replace: () => {
        events.push("replace");
        return {
          commit: () => { events.push("commit"); return { ok: true, phase: "committed" }; },
          rollback: () => { events.push("rollback"); return { ok: true, phase: "rolled-back" }; },
        };
      },
      afterReplace: () => { events.push("configure"); throw failure; },
      restart: () => { events.push("restart"); },
      ready: () => { events.push("ready"); },
    })).rejects.toBe(failure);
    expect(events).toEqual(["stop", "verify", "replace", "configure", "rollback"]);
  });

  test("stops the failed new runtime, rolls back, and restores the old service before returning", async () => {
    const events: string[] = [];
    const failure = new Error("new runtime readiness failed");
    let restartCalls = 0;
    await expect(runLocalInstallLifecycle(true, {
      stop: () => { events.push("stop"); },
      verifyStopped: () => { events.push("verify"); },
      replace: () => {
        events.push("replace");
        return {
          commit: () => { events.push("commit"); return { ok: true, phase: "committed" }; },
          rollback: () => { events.push("rollback"); return { ok: true, phase: "rolled-back" }; },
        };
      },
      restart: () => {
        restartCalls += 1;
        events.push(`restart-${restartCalls}`);
      },
      ready: () => {
        events.push(`ready-${restartCalls}`);
        if (restartCalls === 1) throw failure;
      },
    })).rejects.toBe(failure);
    expect(events).toEqual([
      "stop", "verify", "replace", "restart-1", "ready-1",
      "stop", "verify", "rollback", "restart-2", "ready-2",
    ]);
  });

  test("keeps a pending backup even when another newer backup directory exists", () => {
    const { root, packageDir, result } = deferredFixture();
    expect(result.ok).toBe(true);
    packageTree(join(root, "scope", ".ocx-backup-zzzz", "opencodex"), "1.0.0");
    expect(bootRestoreProbe(packageDir)).toMatchObject({ action: "pending", from: result.backup });
    expect(existsSync(result.backup!)).toBe(true);
  });

  test("restores the marker-owned backup and clears the pending marker after an interrupted swap", () => {
    const { root, packageDir, result } = deferredFixture();
    expect(result.ok).toBe(true);
    const unrelatedBackup = join(root, "scope", ".ocx-backup-zzzz", "opencodex");
    packageTree(unrelatedBackup, "0.9.0");
    rmSync(packageDir, { recursive: true, force: true });

    expect(bootRestoreProbe(packageDir, { isProcessAlive: () => false })).toMatchObject({
      action: "restored",
      from: result.backup,
    });
    expect(version(packageDir)).toBe("2.40.0-ben.2");
    expect(existsSync(join(root, "scope", ".ocx-transaction.json"))).toBe(false);
  });

  test("writes the pending marker before placing the staged tree into the live path", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pending-before-live-"));
    roots.push(root);
    const packageDir = join(root, "scope", "opencodex");
    const stagedTree = join(root, "prepared");
    packageTree(packageDir, "2.40.0-ben.2");
    packageTree(stagedTree, "2.40.0-ben.3");
    let markerObservedBeforeBackup = false;
    let markerObservedBeforeLive = false;

    const result = transactionalNpmUpdate({
      packageDir,
      pkgName,
      targetVersion: "2.40.0-ben.3",
      tag: "latest",
      deferCommit: true,
      runNpm: (args: string[]) => {
        const prefix = args[args.indexOf("--prefix") + 1]!;
        const target = join(prefix, "lib", "node_modules", "@bitkyc08", "opencodex");
        mkdirSync(dirname(target), { recursive: true });
        cpSync(stagedTree, target, { recursive: true });
        return { status: 0 };
      },
      deps: {
        rename: (from: string, to: string) => {
          if (from === packageDir && to.includes(".ocx-backup-")) {
            markerObservedBeforeBackup = existsSync(join(dirname(packageDir), ".ocx-transaction.json"));
          }
          if (to === packageDir && from.includes(".ocx-staging-")) {
            markerObservedBeforeLive = existsSync(join(dirname(packageDir), ".ocx-transaction.json"));
          }
          renameSync(from, to);
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(markerObservedBeforeBackup).toBe(true);
    expect(markerObservedBeforeLive).toBe(true);
    expect(result.rollback!()).toMatchObject({ ok: true, phase: "rolled-back" });
  });

  test("refuses to commit or roll back through a marker owned by another transaction", () => {
    const { root, packageDir, result } = deferredFixture();
    expect(result.ok).toBe(true);
    const markerPath = join(root, "scope", ".ocx-transaction.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    writeFileSync(markerPath, JSON.stringify({ ...marker, id: "another-transaction" }));

    expect(result.rollback!()).toMatchObject({ ok: false, recoveryUnsafe: true });
    expect(version(packageDir)).toBe("2.40.0-ben.3");
    expect(existsSync(result.backup!)).toBe(true);
    expect(result.commit!()).toMatchObject({ ok: false, recoveryUnsafe: true });
  });

  test("fails closed when the pending owner exits after a complete new live tree landed", () => {
    const { root, packageDir, result } = deferredFixture();
    expect(result.ok).toBe(true);
    expect(version(packageDir)).toBe("2.40.0-ben.3");

    expect(bootRestoreProbe(packageDir, { isProcessAlive: () => false })).toMatchObject({
      action: "failed",
      error: expect.stringContaining("complete live package"),
    });
    expect(version(packageDir)).toBe("2.40.0-ben.3");
    expect(version(result.backup!)).toBe("2.40.0-ben.2");
    expect(existsSync(join(root, "scope", ".ocx-transaction.json"))).toBe(true);
  });

  test("clears a dead prepared transaction that never moved the live package", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-prepared-crash-"));
    roots.push(root);
    const packageDir = join(root, "scope", "opencodex");
    const markerPath = join(dirname(packageDir), ".ocx-transaction.json");
    packageTree(packageDir, "2.40.0-ben.2");
    const emptyBackupRoot = join(dirname(packageDir), ".ocx-backup-never-created");
    mkdirSync(emptyBackupRoot, { recursive: true });
    writeFileSync(markerPath, JSON.stringify({
      state: "pending",
      id: "dead-prepared",
      ownerPid: 999_999_999,
      live: packageDir,
      backup: join(emptyBackupRoot, "opencodex"),
    }));

    expect(bootRestoreProbe(packageDir, {
      isProcessAlive: () => false,
      remove: (path: string, options?: Parameters<typeof rmSync>[1]) => rmSync(path, options),
    })).toMatchObject({ action: "aborted" });
    expect(version(packageDir)).toBe("2.40.0-ben.2");
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(emptyBackupRoot)).toBe(false);
  });

  test("rejects a live-owner marker before trusting paths outside this package scope", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pending-wrong-path-"));
    roots.push(root);
    const packageDir = join(root, "scope", "opencodex");
    packageTree(packageDir, "2.40.0-ben.2");
    writeFileSync(join(dirname(packageDir), ".ocx-transaction.json"), JSON.stringify({
      state: "pending",
      id: "wrong-path",
      ownerPid: process.pid,
      live: join(root, "elsewhere", "opencodex"),
      backup: join(root, "elsewhere", ".ocx-backup-fake", "opencodex"),
    }));

    expect(bootRestoreProbe(packageDir, { isProcessAlive: () => true })).toMatchObject({ action: "failed" });
  });

  test.skipIf(process.platform === "win32")("rejects a symlinked backup before restore or cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pending-symlink-"));
    roots.push(root);
    const packageDir = join(root, "scope", "opencodex");
    const outside = join(root, "outside", "opencodex");
    const linkedRoot = join(root, "scope", ".ocx-backup-linked");
    packageTree(packageDir, "2.40.0-ben.3");
    packageTree(outside, "2.40.0-ben.2");
    symlinkSync(dirname(outside), linkedRoot, "dir");
    writeFileSync(join(dirname(packageDir), ".ocx-transaction.json"), JSON.stringify({
      state: "pending",
      id: "linked",
      ownerPid: 999_999_999,
      live: packageDir,
      backup: join(linkedRoot, "opencodex"),
    }));

    expect(bootRestoreProbe(packageDir, { isProcessAlive: () => false })).toMatchObject({ action: "failed" });
    expect(version(outside)).toBe("2.40.0-ben.2");
  });

  test("fails closed when the package scope cannot be enumerated", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pending-unreadable-"));
    roots.push(root);
    const packageDir = join(root, "scope", "opencodex");
    packageTree(packageDir, "2.40.0-ben.2");
    expect(bootRestoreProbe(packageDir, {
      readDirectory: () => { throw new Error("EACCES: unreadable scope"); },
    })).toMatchObject({ action: "failed" });
  });

  test("reports rollback as recovery-unsafe when the pending marker cannot be removed", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pending-remove-fault-"));
    roots.push(root);
    const packageDir = join(root, "scope", "opencodex");
    const stagedTree = join(root, "prepared");
    packageTree(packageDir, "2.40.0-ben.2");
    packageTree(stagedTree, "2.40.0-ben.3");
    const markerPath = join(dirname(packageDir), ".ocx-transaction.json");
    const result = transactionalNpmUpdate({
      packageDir,
      pkgName,
      targetVersion: "2.40.0-ben.3",
      tag: "latest",
      deferCommit: true,
      runNpm: (args: string[]) => {
        const prefix = args[args.indexOf("--prefix") + 1]!;
        const target = join(prefix, "lib", "node_modules", "@bitkyc08", "opencodex");
        mkdirSync(dirname(target), { recursive: true });
        cpSync(stagedTree, target, { recursive: true });
        return { status: 0 };
      },
      deps: {
        remove: (path: string, options?: Parameters<typeof rmSync>[1]) => {
          if (path === markerPath) throw new Error("EACCES: marker unlink blocked");
          rmSync(path, options);
        },
      },
    });
    expect(result.ok).toBe(true);

    expect(result.rollback!()).toMatchObject({
      ok: false,
      recoveryUnsafe: true,
      markerCleanupFailed: true,
    });
    expect(version(packageDir)).toBe("2.40.0-ben.2");
    expect(existsSync(markerPath)).toBe(true);
    expect(readdirSync(dirname(packageDir)).some(name => name.startsWith(".ocx-failed-live-"))).toBe(false);
    expect(bootRestoreProbe(packageDir, {
      isProcessAlive: () => false,
      remove: (path: string, options?: Parameters<typeof rmSync>[1]) => rmSync(path, options),
    })).toMatchObject({ action: "aborted" });
    expect(existsSync(markerPath)).toBe(false);
  });

  test("does not replace an existing pending marker when two transactions race", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pending-race-"));
    roots.push(root);
    const packageDir = join(root, "scope", "opencodex");
    const stagedTree = join(root, "prepared");
    packageTree(packageDir, "2.40.0-ben.2");
    packageTree(stagedTree, "2.40.0-ben.3");
    const markerPath = join(dirname(packageDir), ".ocx-transaction.json");
    const competing = JSON.stringify({
      state: "pending",
      id: "competing",
      ownerPid: process.pid,
      live: packageDir,
      backup: join(dirname(packageDir), ".ocx-backup-competing", "opencodex"),
    });
    let injected = false;
    const result = transactionalNpmUpdate({
      packageDir,
      pkgName,
      targetVersion: "2.40.0-ben.3",
      tag: "latest",
      deferCommit: true,
      runNpm: (args: string[]) => {
        const prefix = args[args.indexOf("--prefix") + 1]!;
        const target = join(prefix, "lib", "node_modules", "@bitkyc08", "opencodex");
        mkdirSync(dirname(target), { recursive: true });
        cpSync(stagedTree, target, { recursive: true });
        return { status: 0 };
      },
      deps: {
        linkMarker: (from: string, to: string) => {
          if (!injected) {
            writeFileSync(markerPath, competing);
            injected = true;
          }
          require("node:fs").linkSync(from, to);
        },
      },
    });

    expect(result).toMatchObject({ ok: false, phase: "pending-marker", recoveryUnsafe: true });
    expect(readFileSync(markerPath, "utf8")).toBe(competing);
    expect(version(packageDir)).toBe("2.40.0-ben.2");
  });

  test("fails closed for an invalid pending marker or one whose backup is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-invalid-pending-"));
    roots.push(root);
    const packageDir = join(root, "scope", "opencodex");
    packageTree(packageDir, "2.40.0-ben.3");
    mkdirSync(dirname(packageDir), { recursive: true });
    writeFileSync(join(dirname(packageDir), ".ocx-transaction.json"), "{");
    expect(bootRestoreProbe(packageDir)).toMatchObject({ action: "failed" });

    writeFileSync(join(dirname(packageDir), ".ocx-transaction.json"), JSON.stringify({
      state: "pending",
      live: packageDir,
      backup: join(dirname(packageDir), ".ocx-backup-missing", "opencodex"),
    }));
    expect(bootRestoreProbe(packageDir)).toMatchObject({ action: "failed" });
  });

  test("runs the completion guard before committing the package transaction", async () => {
    const events: string[] = [];
    const failure = new Error("completion manifest drift");
    await expect(runLocalInstallLifecycle(false, {
      stop: () => { events.push("stop"); },
      verifyStopped: () => { events.push("verify"); },
      replace: () => ({
        commit: () => { events.push("commit"); return { ok: true, phase: "committed" }; },
        rollback: () => { events.push("rollback"); return { ok: true, phase: "rolled-back" }; },
      }),
      beforeCommit: () => { events.push("completion-guard"); throw failure; },
      restart: () => { events.push("restart"); },
      ready: () => { events.push("ready"); },
    })).rejects.toBe(failure);
    expect(events).toEqual(["stop", "verify", "completion-guard", "rollback"]);
  });

  test("marks a failed stop of the new runtime as recovery-unsafe", async () => {
    const events: string[] = [];
    const readinessFailure = new Error("new runtime readiness failed");
    let stopCalls = 0;
    let thrown: unknown;
    try {
      await runLocalInstallLifecycle(true, {
        stop: () => {
          stopCalls += 1;
          events.push(`stop-${stopCalls}`);
          if (stopCalls === 2) throw new Error("new runtime would not stop");
        },
        verifyStopped: () => { events.push("verify"); },
        replace: () => ({
          commit: () => ({ ok: true, phase: "committed" }),
          rollback: () => { events.push("rollback"); return { ok: true, phase: "rolled-back" }; },
        }),
        restart: () => { events.push("restart"); },
        ready: () => { events.push("ready"); throw readinessFailure; },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError & { localInstallRecoverySafe?: boolean }).localInstallRecoverySafe).toBe(false);
    expect(events).toEqual(["stop-1", "verify", "restart", "ready", "stop-2"]);
  });
});

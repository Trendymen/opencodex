/**
 * #1942 / #1849: transactional update invariant — the live tree is always either
 * old-complete or new-complete, never a partial skeleton, across every injected fault.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootRestoreProbe,
  launcherUsableAfterNpmUpdate,
  transactionalNpmUpdate,
  verifyInstallTree,
} from "../../src/update/transactional-install.mjs";
import { npmUpdateFailureGuidance } from "../../src/update/update-failure-guidance.mjs";
import { planStoppedRuntimeRecovery } from "../../src/update/runtime-ownership.mjs";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const PKG = "@bitkyc08/opencodex";

function writeTree(packageDir: string, version: string): void {
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  mkdirSync(join(packageDir, "node_modules", "bun"), { recursive: true });
  mkdirSync(join(packageDir, "node_modules", "zod"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: PKG, version, dependencies: { bun: "1", zod: "1" },
  }));
  writeFileSync(join(packageDir, "bin", "ocx.mjs"), "#!/usr/bin/env node\n" + "x".repeat(2048));
  writeFileSync(join(packageDir, "node_modules", "bun", "package.json"), JSON.stringify({ name: "bun" }));
  // The manifest size-gates the real Bun binary (>= 10MB); give the fixture one.
  writeFileSync(join(packageDir, "node_modules", "bun", "bun.exe"), Buffer.alloc(10 * 1024 * 1024 + 1024));
  writeFileSync(join(packageDir, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod" }));
}

function liveVersion(packageDir: string): string | undefined {
  try {
    return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

function pendingMarkerReadWithLstat(scopeDir: string, inspect: typeof lstatSync): { state: string } {
  const source = readFileSync(repoPath("src/update/transactional-install.mjs"), "utf8");
  const start = source.indexOf("function readPendingMarker(scopeDir) {");
  const end = source.indexOf("\nfunction pendingMarkerMatches(", start);
  if (start < 0 || end < 0) throw new Error("pending marker reader boundary changed");
  const load = new Function("existsSync", "lstatSync", "readFileSync", "pendingMarkerPath",
    `${source.slice(start, end)}\nreturn readPendingMarker;`);
  return load(existsSync, inspect, readFileSync, (dir: string) => join(dir, ".ocx-transaction.json"))(scopeDir);
}

/** npm stub that materializes a GLOBAL-style staged tree (deps nested inside the package). */
function stagingNpm(version: string, opts: { fail?: boolean; truncate?: boolean } = {}) {
  return (args: string[]) => {
    if (opts.fail) return { status: 1 };
    const prefixIndex = args.indexOf("--prefix");
    const stageRoot = args[prefixIndex + 1]!;
    // Mirror npm -g layout on POSIX: <prefix>/lib/node_modules/<pkg>.
    const staged = join(stageRoot, "lib", "node_modules", ...PKG.split("/"));
    writeTree(staged, version);
    if (opts.truncate) rmSync(join(staged, "bin", "ocx.mjs"));
    return { status: 0 };
  };
}

describe("#1942 transactional update", () => {
  let scopeDir: string;
  let packageDir: string;

  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "ocx-tx-update-"));
    packageDir = join(scopeDir, "opencodex");
    writeTree(packageDir, "1.0.0");
  });

  afterEach(() => {
    removeTreeWithRetry(scopeDir);
  });

  test("manifest verifies a complete tree and rejects a truncated one", () => {
    expect(verifyInstallTree(packageDir, "1.0.0").ok).toBe(true);
    expect(verifyInstallTree(packageDir, "9.9.9").ok).toBe(false);
    rmSync(join(packageDir, "bin", "ocx.mjs"));
    expect(verifyInstallTree(packageDir).ok).toBe(false);
  });

  test("happy path swaps and keeps a backup; stage scaffolding is gone", () => {
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0"),
    });
    expect(result.ok).toBe(true);
    expect(liveVersion(packageDir)).toBe("2.0.0");
    expect(existsSync(result.backup!)).toBe(true);
    expect(liveVersion(result.backup!)).toBe("1.0.0");
  });

  test("global staging explicitly allows only Bun's required install script", () => {
    let installArgs: string[] = [];
    const stage = stagingNpm("2.0.0");
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: (args: string[]) => {
        installArgs = args;
        return stage(args);
      },
    });

    expect(result.ok).toBe(true);
    expect(installArgs).toContain("--allow-scripts=bun");
    expect(installArgs).not.toContain("--dangerously-allow-all-scripts");
    expect(installArgs).not.toContain("--ignore-scripts");
  });

  test("staging pins the pre-flight's npm cache instead of npm's default root (#6288)", () => {
    // --prefix <stage> moves npm's globalconfig into the stage, so a cache= from the operator's
    // global npmrc would be dropped; the stage must use the root the pre-flight checked.
    const calls: string[][] = [];
    const recording = (version: string) => {
      const stage = stagingNpm(version);
      return (args: string[]) => { calls.push(args); return stage(args); };
    };
    const cachePath = join(scopeDir, "configured cache");

    expect(transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest", cachePath, runNpm: recording("2.0.0"),
    }).ok).toBe(true);
    expect(calls[0]![calls[0]!.indexOf("--cache") + 1]).toBe(cachePath);

    // Without a resolved cache the arguments stay as before.
    expect(transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "3.0.0", tag: "latest", runNpm: recording("3.0.0"),
    }).ok).toBe(true);
    expect(calls[1]).not.toContain("--cache");
  });

  test("npm's strict script policy finds the stage's global root in place (#5760)", () => {
    // With strict-allow-scripts, npm 11.19 plans the global tree before it creates the prefix
    // layout and fails with ENOENT on <prefix>/lib when the stage is bare.
    const stage = stagingNpm("2.0.0");
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: (args: string[]) => {
        const stageRoot = args[args.indexOf("--prefix") + 1]!;
        if (process.platform !== "win32" && !existsSync(join(stageRoot, "lib"))) return { status: 254 };
        return stage(args);
      },
    });
    expect(result.ok).toBe(true);
    expect(liveVersion(packageDir)).toBe("2.0.0");
  });

  test("stage install failure leaves live untouched (D4 row 1)", () => {
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0", { fail: true }),
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("stage");
    expect(liveVersion(packageDir)).toBe("1.0.0");
  });

  test("verification failure leaves live untouched (D4 row 2)", () => {
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0", { truncate: true }),
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("verify");
    expect(liveVersion(packageDir)).toBe("1.0.0");
  });

  test("wrong staged version is refused before any swap", () => {
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("3.0.0"),
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("verify");
    expect(liveVersion(packageDir)).toBe("1.0.0");
  });

  for (const outcome of ["false", "throw", "promise"] as const) {
    test(`final swap authorization rejects ${outcome} after publishing its pending marker`, () => {
      let authorizations = 0;
      let renames = 0;
      const result = transactionalNpmUpdate({
        packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
        runNpm: stagingNpm("2.0.0"),
        mayReplacePackage: (() => {
          if (++authorizations === 1) return true;
          if (outcome === "throw") throw new Error("private authority detail");
          return outcome === "promise" ? Promise.resolve(true) : false;
        }) as () => boolean,
        deps: { rename: () => { renames += 1; } },
      });
      expect(result).toMatchObject({ ok: false, phase: "authorize" });
      expect(JSON.stringify(result)).not.toContain("private authority detail");
      expect(authorizations).toBe(2);
      expect(renames).toBe(0);
      expect(liveVersion(packageDir)).toBe("1.0.0");
      expect(readdirSync(scopeDir)).toEqual(["opencodex"]);
      expect(launcherUsableAfterNpmUpdate(result)).toBe(true);
    });
  }

  for (const allowed of [false, true]) {
    test(`a marker replaced during ${allowed ? "allowed" : "refused"} authorization is preserved`, () => {
      let authorizations = 0;
      let renames = 0;
      let foreignMarker = "";
      const markerPath = join(scopeDir, ".ocx-transaction.json");
      const result = transactionalNpmUpdate({
        packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
        runNpm: stagingNpm("2.0.0"),
        mayReplacePackage: () => {
          if (++authorizations === 1) return true;
          const marker = JSON.parse(readFileSync(markerPath, "utf8"));
          foreignMarker = JSON.stringify({ ...marker, id: "foreign-transaction" });
          writeFileSync(markerPath, foreignMarker);
          return allowed;
        },
        deps: { rename: () => { renames += 1; } },
      });
      expect(result).toMatchObject({ ok: false, phase: "pending-owner", recoveryUnsafe: true });
      expect(renames).toBe(0);
      expect(liveVersion(packageDir)).toBe("1.0.0");
      expect(readFileSync(markerPath, "utf8")).toBe(foreignMarker);
      expect(launcherUsableAfterNpmUpdate(result)).toBe(false);
    });
  }

  test("a retryable backup rename rechecks package authority before trying again", () => {
    let authorizations = 0;
    let renames = 0;
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0"),
      mayReplacePackage: () => ++authorizations < 3,
      deps: {
        rename: () => {
          renames += 1;
          throw Object.assign(new Error("locked"), { code: "EBUSY" });
        },
      },
    });
    expect(result).toMatchObject({ ok: false, phase: "authorize" });
    expect(authorizations).toBe(3);
    expect(renames).toBe(1);
    expect(liveVersion(packageDir)).toBe("1.0.0");
    expect(readdirSync(scopeDir)).toEqual(["opencodex"]);
  });

  test("safe pending-marker failure keeps the old launcher and reports the old version", () => {
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0"),
      deps: { writeFile: () => { throw new Error("marker write failed"); } },
    });
    expect(result).toMatchObject({ ok: false, phase: "pending-marker" });
    expect(result.recoveryUnsafe).not.toBe(true);
    expect(liveVersion(packageDir)).toBe("1.0.0");
    expect(readdirSync(scopeDir)).toEqual(["opencodex"]);
    expect(launcherUsableAfterNpmUpdate(result)).toBe(true);
    expect(npmUpdateFailureGuidance({ ...result, pkgName: PKG }).previousVersionKept).toBe(true);

    const unsafe = { ...result, recoveryUnsafe: true };
    expect(launcherUsableAfterNpmUpdate(unsafe)).toBe(false);
    const guidance = npmUpdateFailureGuidance({ ...unsafe, pkgName: PKG });
    expect(guidance.previousVersionKept).toBe(false);
    expect(guidance.lines.join(" ")).toContain("uncertain recovery state");
    expect(guidance.lines.join(" ")).not.toContain("run 'ocx update' again");
  });

  test.skipIf(process.platform === "win32")("a dangling pending-marker symlink remains unsafe after publication fails", () => {
    const markerPath = join(scopeDir, ".ocx-transaction.json");
    const stage = stagingNpm("2.0.0");
    let publications = 0;
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: args => {
        const staged = stage(args);
        symlinkSync(join(scopeDir, "missing-marker-target"), markerPath);
        return staged;
      },
      deps: { linkMarker: (from, to) => { publications += 1; linkSync(from, to); } },
    });
    expect(result).toMatchObject({ ok: false, phase: "pending-marker", recoveryUnsafe: true });
    expect(publications).toBe(1);
    expect(lstatSync(markerPath).isSymbolicLink()).toBe(true);
    expect(liveVersion(packageDir)).toBe("1.0.0");
    expect(launcherUsableAfterNpmUpdate(result)).toBe(false);
    expect(npmUpdateFailureGuidance({ ...result, pkgName: PKG }).previousVersionKept).toBe(false);
  });

  test.skipIf(process.platform === "win32")("a pre-existing dangling marker refuses before staging", () => {
    const markerPath = join(scopeDir, ".ocx-transaction.json");
    symlinkSync(join(scopeDir, "missing-marker-target"), markerPath);
    let installs = 0;
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: () => { installs += 1; return { status: 1 }; },
    });
    expect(result).toMatchObject({ ok: false, phase: "pending-existing", recoveryUnsafe: true });
    expect(installs).toBe(0);
    expect(lstatSync(markerPath).isSymbolicLink()).toBe(true);
    expect(liveVersion(packageDir)).toBe("1.0.0");
    expect(launcherUsableAfterNpmUpdate(result)).toBe(false);
  });

  test("a restored package with an uncleared marker cannot drive automatic recovery", () => {
    const markerPath = join(scopeDir, ".ocx-transaction.json");
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0"),
      deps: {
        rename: (from, to) => {
          if (to === packageDir && from.includes(".ocx-staging-")) throw new Error("staged rename failed");
          renameSync(from, to);
        },
        remove: (path, options) => {
          if (path === markerPath) throw new Error("marker cleanup failed");
          rmSync(path, options);
        },
      },
    });
    expect(result).toMatchObject({ ok: false, phase: "double-fault", rolledBack: true, recoveryUnsafe: true, markerCleanupFailed: true });
    expect(liveVersion(packageDir)).toBe("1.0.0");
    expect(existsSync(markerPath)).toBe(true);
    const launcherUsable = launcherUsableAfterNpmUpdate(result);
    expect(launcherUsable).toBe(false);
    for (const serviceInstalled of [false, true]) {
      expect(planStoppedRuntimeRecovery({
        stopAttempted: true, ownership: null, sameOwner: true, liveness: "dead", serviceInstalled,
        launcherUsable, hadRuntimeState: true,
      })).toEqual({ action: "manual", reason: "launcher-unavailable" });
    }
    const guidance = npmUpdateFailureGuidance({ ...result, pkgName: PKG });
    expect(guidance.previousVersionKept).toBe(true);
    expect(guidance.lines.join(" ")).toContain("transaction recovery is unsafe");
    expect(guidance.lines.join(" ")).not.toContain("run 'ocx update' again");
  });

  test("swap-live failure rolls back to the old tree (D4 locked-file row)", () => {
    let renames = 0;
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0"),
      deps: {
        rename: (from: string, to: string) => {
          renames += 1;
          if (renames === 2) throw new Error("EBUSY: locked");
          const { renameSync } = require("node:fs");
          renameSync(from, to);
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("swap-live");
    expect(result.rolledBack).toBe(true);
    expect(liveVersion(packageDir)).toBe("1.0.0");
  });

  test("double fault writes the recovery marker with a one-line restore (D4 last row)", () => {
    let renames = 0;
    const result = transactionalNpmUpdate({
      packageDir, pkgName: PKG, targetVersion: "2.0.0", tag: "latest",
      runNpm: stagingNpm("2.0.0"),
      deps: {
        rename: (from: string, to: string) => {
          renames += 1;
          if (renames >= 2) throw new Error("EPERM: still locked");
          const { renameSync } = require("node:fs");
          renameSync(from, to);
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("double-fault");
    const marker = JSON.parse(readFileSync(join(scopeDir, ".ocx-recovery.json"), "utf8"));
    expect(marker.restore).toContain("opencodex");
  });

  for (const live of ["healthy", "broken"] as const) {
    for (const markerKind of ["directory", "dangling symlink", "symlink to marker"] as const) {
      test.skipIf(markerKind !== "directory" && process.platform === "win32")(
        `boot probe preserves ${live} live and recovery evidence for ${markerKind}`,
        () => {
          const backupRoot = join(scopeDir, ".ocx-backup-unknown");
          const backup = join(backupRoot, "opencodex");
          const marker = join(scopeDir, ".ocx-transaction.json");
          const recovery = join(scopeDir, ".ocx-recovery.json");
          const target = join(scopeDir, "other-marker.json");
          writeTree(backup, "0.9.0");
          const recoveryBytes = Buffer.from('{"reason":"manual recovery evidence"}\n');
          writeFileSync(recovery, recoveryBytes);
          if (markerKind === "directory") {
            mkdirSync(marker);
            writeFileSync(join(marker, "evidence"), "directory marker bytes");
          } else {
            if (markerKind === "symlink to marker") {
              writeFileSync(target, JSON.stringify({ state: "pending", id: "other", ownerPid: process.pid, live: packageDir, backup }));
            }
            symlinkSync(target, marker, "file");
          }
          if (live === "broken") rmSync(join(packageDir, "bin", "ocx.mjs"));
          const files = ["package.json", "bin/ocx.mjs", "node_modules/bun/package.json", "node_modules/bun/bun.exe", "node_modules/zod/package.json"];
          const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
          const backupBytes = files.map(file => digest(join(backup, file)));
          const liveManifest = readFileSync(join(packageDir, "package.json"));
          const liveLauncher = live === "healthy" ? readFileSync(join(packageDir, "bin", "ocx.mjs")) : undefined;
          const identity = (path: string) => {
            const { dev, ino, mode } = lstatSync(path);
            return { dev, ino, mode };
          };
          const entries = readdirSync(scopeDir).sort();
          const identities = [packageDir, backupRoot, backup, marker, recovery].map(identity);
          const markerEvidence = markerKind === "directory" ? readFileSync(join(marker, "evidence"), "utf8") : readlinkSync(marker);
          const targetBytes = markerKind === "symlink to marker" ? readFileSync(target) : undefined;
          const renames: string[][] = [];

          const probe = bootRestoreProbe(packageDir, { rename: (from, to) => { renames.push([from, to]); renameSync(from, to); } });

          expect(probe).toEqual({ action: "failed", error: "pending transaction marker is invalid" });
          expect(renames).toEqual([]);
          expect(readdirSync(scopeDir).sort()).toEqual(entries);
          expect([packageDir, backupRoot, backup, marker, recovery].map(identity)).toEqual(identities);
          expect(files.map(file => digest(join(backup, file)))).toEqual(backupBytes);
          expect(readFileSync(recovery)).toEqual(recoveryBytes);
          expect(readFileSync(join(packageDir, "package.json"))).toEqual(liveManifest);
          if (liveLauncher) expect(readFileSync(join(packageDir, "bin", "ocx.mjs"))).toEqual(liveLauncher);
          else expect(existsSync(join(packageDir, "bin", "ocx.mjs"))).toBe(false);
          if (markerKind === "directory") expect(readFileSync(join(marker, "evidence"), "utf8")).toBe(markerEvidence);
          else expect(readlinkSync(marker)).toBe(markerEvidence);
          if (targetBytes) expect(readFileSync(target)).toEqual(targetBytes);
        },
      );
    }
  }

  test("pending marker lstat failure other than ENOENT remains invalid", () => {
    const marker = join(scopeDir, ".ocx-transaction.json");
    writeFileSync(marker, JSON.stringify({ state: "pending", id: "known", ownerPid: process.pid, live: packageDir, backup: "backup" }));
    const denied = (() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }) as typeof lstatSync;
    expect(pendingMarkerReadWithLstat(scopeDir, denied)).toEqual({ state: "invalid" });
    expect(existsSync(marker)).toBe(true);
  });

  test("pending marker removed after lstat is invalid rather than absent", () => {
    const marker = join(scopeDir, ".ocx-transaction.json");
    writeFileSync(marker, JSON.stringify({ state: "pending", id: "known", ownerPid: process.pid, live: packageDir, backup: "backup" }));
    const vanishing = ((path: Parameters<typeof lstatSync>[0]) => {
      const stat = lstatSync(path);
      rmSync(path);
      return stat;
    }) as typeof lstatSync;
    expect(pendingMarkerReadWithLstat(scopeDir, vanishing)).toEqual({ state: "invalid" });
    expect(existsSync(marker)).toBe(false);
  });

  test("boot probe restores the backup over a broken live tree (D4 power-loss rows)", () => {
    // Simulate: swap moved live aside, then power loss before stage landed.
    const backupRoot = join(scopeDir, ".ocx-backup-2026");
    mkdirSync(backupRoot, { recursive: true });
    const { renameSync } = require("node:fs");
    renameSync(packageDir, join(backupRoot, "opencodex"));
    expect(existsSync(packageDir)).toBe(false);
    const probe = bootRestoreProbe(packageDir);
    expect(probe.action).toBe("restored");
    expect(liveVersion(packageDir)).toBe("1.0.0");
  });

  test("boot probe reaps stale backups when live is healthy", () => {
    const backupRoot = join(scopeDir, ".ocx-backup-2026");
    mkdirSync(join(backupRoot, "opencodex"), { recursive: true });
    writeFileSync(join(backupRoot, "opencodex", "package.json"), JSON.stringify({ version: "0.9.0" }));
    const probe = bootRestoreProbe(packageDir);
    expect(probe.action).toBe("reaped");
    expect(existsSync(backupRoot)).toBe(false);
  });
});

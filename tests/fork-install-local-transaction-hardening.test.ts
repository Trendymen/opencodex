import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { bootRestoreProbe, transactionalNpmUpdate, verifyInstallTree } from "../src/update/transactional-install.mjs";
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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ocx-transaction-hardening-"));
  roots.push(root);
  const packageDir = join(root, "scope", "opencodex");
  const stagedTree = join(root, "prepared");
  packageTree(packageDir, "2.40.0-ben.2");
  packageTree(stagedTree, "2.40.0-ben.3");
  return { root, packageDir, stagedTree };
}

function options(packageDir: string, stagedTree: string, deps: Record<string, unknown> = {}) {
  return {
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
    deps,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("deferred local-install transaction hardening", () => {
  test("rejects a staged package replaced after its verifier approves the original object", () => {
    const { packageDir, stagedTree } = setup();
    let verified = false;
    const result = transactionalNpmUpdate({
      ...options(packageDir, stagedTree),
      verifyStage: stagedPackage => {
        expect(verifyInstallTree(stagedPackage, "2.40.0-ben.3")).toMatchObject({ ok: true });
        verified = true;
        renameSync(stagedPackage, `${stagedPackage}-verified`);
        packageTree(stagedPackage, "attacker");
        return { ok: true, failures: [] };
      },
    });

    expect(verified).toBe(true);
    expect(result).toMatchObject({ ok: false, phase: "verify" });
    expect(version(packageDir)).toBe("2.40.0-ben.2");
  });

  test.skipIf(process.platform === "win32")("rejects a symlinked staging root before it can be swapped", () => {
    const { root, packageDir, stagedTree } = setup();
    const outsideStage = join(root, "outside-stage");
    const result = transactionalNpmUpdate({
      ...options(packageDir, stagedTree),
      runNpm: args => {
        const stageRoot = args[args.indexOf("--prefix") + 1]!;
        const outsidePackage = join(outsideStage, "lib", "node_modules", "@bitkyc08", "opencodex");
        mkdirSync(dirname(outsidePackage), { recursive: true });
        cpSync(stagedTree, outsidePackage, { recursive: true });
        rmSync(stageRoot, { recursive: true, force: true });
        symlinkSync(outsideStage, stageRoot, "dir");
        return { status: 0 };
      },
    });

    expect(result).toMatchObject({ ok: false, phase: "verify" });
    expect(version(packageDir)).toBe("2.40.0-ben.2");
  });

  test("rejects a staged package whose canonical path is not contained by its staging root", () => {
    const { root, packageDir, stagedTree } = setup();
    const result = transactionalNpmUpdate({
      ...options(packageDir, stagedTree, {
        realpath: (path: string) => path.endsWith("/opencodex") && path.includes(".ocx-staging-")
          ? join(root, "outside", "opencodex")
          : realpathSync(path),
      }),
    });

    expect(result).toMatchObject({ ok: false, phase: "verify" });
    expect(version(packageDir)).toBe("2.40.0-ben.2");
  });

  test.skipIf(process.platform === "win32")("rejects a symlinked package root", () => {
    const { root, packageDir } = setup();
    const linkedRoot = join(root, "linked-package");
    symlinkSync(packageDir, linkedRoot, "dir");

    expect(verifyInstallTree(linkedRoot)).toMatchObject({ ok: false });
  });

  test.skipIf(process.platform === "win32")("rejects symlinked launcher, dependency sentinel, and Bun tree artifacts", () => {
    const mutations: Array<[string, (packageDir: string) => void]> = [
      ["launcher", packageDir => {
        const internalLauncher = join(packageDir, "bin", "real-ocx.mjs");
        renameSync(join(packageDir, "bin", "ocx.mjs"), internalLauncher);
        symlinkSync(internalLauncher, join(packageDir, "bin", "ocx.mjs"));
      }],
      ["dependency sentinel", packageDir => {
        const sentinel = join(packageDir, "node_modules", "zod", "package.json");
        renameSync(sentinel, `${sentinel}.real`);
        symlinkSync(`${sentinel}.real`, sentinel);
      }],
      ["Bun tree", packageDir => {
        const manifestPath = join(packageDir, "package.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.dependencies.bun = "1";
        writeFileSync(manifestPath, JSON.stringify(manifest));
        const binary = join(packageDir, "node_modules", "bun", "bin", "bun");
        mkdirSync(dirname(binary), { recursive: true });
        writeFileSync(binary, "x".repeat(11 * 1024 * 1024));
        symlinkSync(binary, join(packageDir, "node_modules", "bun", "bin", "bun-link"));
      }],
    ];
    for (const [label, mutate] of mutations) {
      const { packageDir } = setup();
      mutate(packageDir);
      expect(verifyInstallTree(packageDir), label).toMatchObject({ ok: false });
    }
  });

  test.skipIf(process.platform === "win32")("rejects required artifacts whose canonical target escapes the package root", () => {
    const { root, packageDir } = setup();
    const outside = join(root, "outside-launcher.mjs");
    writeFileSync(outside, "x".repeat(2_048));
    rmSync(join(packageDir, "bin", "ocx.mjs"));
    symlinkSync(outside, join(packageDir, "bin", "ocx.mjs"));

    expect(verifyInstallTree(packageDir)).toMatchObject({ ok: false });
  });

  test.skipIf(process.platform === "win32")("boot recovery restores a backup instead of reaping it through a symlinked launcher", () => {
    const { root, packageDir } = setup();
    const backupPackage = join(dirname(packageDir), ".ocx-backup-recovery", "opencodex");
    cpSync(packageDir, backupPackage, { recursive: true });
    const internalLauncher = join(packageDir, "bin", "real-ocx.mjs");
    renameSync(join(packageDir, "bin", "ocx.mjs"), internalLauncher);
    symlinkSync(internalLauncher, join(packageDir, "bin", "ocx.mjs"));

    expect(bootRestoreProbe(packageDir)).toMatchObject({ action: "restored", from: backupPackage });
    expect(lstatSync(join(packageDir, "bin", "ocx.mjs")).isSymbolicLink()).toBe(false);
  });

  test("a canonical-backup lookup failure rolls back before restarting the old runtime", async () => {
    const { packageDir, stagedTree } = setup();
    const events: string[] = [];

    await expect(runLocalInstallLifecycle(true, {
      stop: () => { events.push("stop"); },
      verifyStopped: () => { events.push("verify-stopped"); },
      replace: () => {
        events.push("replace");
        const result = transactionalNpmUpdate({
          ...options(packageDir, stagedTree),
          deps: {
            realpath: (path: string) => {
              if (path.includes(".ocx-backup-")) {
                throw Object.assign(new Error("EACCES: canonical backup lookup failed"), { code: "EACCES" });
              }
              return require("node:fs").realpathSync(path);
            },
          },
        });
        if (!result.ok) throw Object.assign(new Error(result.error), {
          localInstallRecoverySafe: result.recoveryUnsafe !== true,
        });
        return result;
      },
      restart: () => { events.push(`restart-${version(packageDir)}`); },
      ready: () => { events.push(`ready-${version(packageDir)}`); },
    })).rejects.toThrow("canonical backup lookup failed");

    expect(version(packageDir)).toBe("2.40.0-ben.2");
    expect(events).toEqual(["stop", "verify-stopped", "replace", "restart-2.40.0-ben.2", "ready-2.40.0-ben.2"]);
    expect(existsSync(join(dirname(packageDir), ".ocx-transaction.json"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")("a recovery-marker symlink is never followed", () => {
    const { root, packageDir, stagedTree } = setup();
    const scopeDir = dirname(packageDir);
    const outside = join(root, "outside-marker");
    writeFileSync(outside, "outside remains unchanged");
    symlinkSync(outside, join(scopeDir, ".ocx-recovery.json"));
    let renameCalls = 0;
    const result = transactionalNpmUpdate({
      ...options(packageDir, stagedTree),
      deps: {
        rename: (from: string, to: string) => {
          renameCalls += 1;
          if (renameCalls >= 2) throw Object.assign(new Error("EPERM: staged rename blocked"), { code: "EPERM" });
          renameSync(from, to);
        },
      },
    });

    expect(result).toMatchObject({ ok: false, phase: "double-fault", recoveryUnsafe: true, markerWriteFailed: true });
    expect(readFileSync(outside, "utf8")).toBe("outside remains unchanged");
  });

  test.skipIf(process.platform === "win32")("deferred rollback refuses a replaced backup object before deleting live", () => {
    const { root, packageDir, stagedTree } = setup();
    const result = transactionalNpmUpdate(options(packageDir, stagedTree));
    expect(result.ok).toBe(true);
    const backupPackage = result.backup!;
    const originalBackupRoot = dirname(backupPackage);
    const movedBackupRoot = `${originalBackupRoot}-original`;
    renameSync(originalBackupRoot, movedBackupRoot);
    const outside = join(root, "outside", "opencodex");
    packageTree(outside, "attacker");
    symlinkSync(dirname(outside), originalBackupRoot, "dir");

    expect(result.rollback!()).toMatchObject({ ok: false, recoveryUnsafe: true });
    expect(lstatSync(packageDir).isSymbolicLink()).toBe(false);
    expect(version(packageDir)).toBe("2.40.0-ben.3");
    expect(version(outside)).toBe("attacker");
  });

  test("deferred rollback refuses a foreign directory at the original backup path", () => {
    const { packageDir, stagedTree } = setup();
    const result = transactionalNpmUpdate(options(packageDir, stagedTree));
    expect(result.ok).toBe(true);
    const backupPackage = result.backup!;
    const originalBackupRoot = dirname(backupPackage);
    renameSync(originalBackupRoot, `${originalBackupRoot}-original`);
    packageTree(backupPackage, "attacker");

    expect(result.rollback!()).toMatchObject({ ok: false, recoveryUnsafe: true });
    expect(version(packageDir)).toBe("2.40.0-ben.3");
    expect(version(backupPackage)).toBe("attacker");
  });

  test("rollback verifies the restored package before reporting success", () => {
    const { packageDir, stagedTree } = setup();
    const result = transactionalNpmUpdate({
      ...options(packageDir, stagedTree),
      verifyRollback: () => ({ ok: false, failures: ["GUI asset verification failed"] }),
    });
    expect(result.ok).toBe(true);
    const backupPackage = result.backup!;

    expect(result.rollback!()).toMatchObject({
      ok: false,
      phase: "double-fault",
      rolledBack: false,
      recoveryUnsafe: true,
    });
    expect(version(packageDir)).toBe("2.40.0-ben.3");
    expect(version(backupPackage)).toBe("2.40.0-ben.2");
    const recoveryMarker = JSON.parse(readFileSync(join(dirname(packageDir), ".ocx-recovery.json"), "utf8"));
    expect(recoveryMarker.reason).toBe("restored-backup-verification-failed");
    expect(realpathSync(recoveryMarker.backup)).toBe(realpathSync(backupPackage));
    expect(existsSync(recoveryMarker.backup)).toBe(true);

    expect(bootRestoreProbe(packageDir, { isProcessAlive: () => false })).toMatchObject({
      action: "failed",
      error: expect.stringContaining("failed verification"),
    });
    expect(version(packageDir)).toBe("2.40.0-ben.3");
    expect(version(backupPackage)).toBe("2.40.0-ben.2");
    expect(existsSync(join(dirname(packageDir), ".ocx-transaction.json"))).toBe(true);
    expect(existsSync(join(dirname(packageDir), ".ocx-recovery.json"))).toBe(true);
  });

  test("a failed backup-preservation rename keeps both package trees recoverable", () => {
    const { packageDir, stagedTree } = setup();
    let originalBackupPath = "";
    const result = transactionalNpmUpdate({
      ...options(packageDir, stagedTree),
      verifyRollback: () => ({ ok: false, failures: ["strict local tree verification failed"] }),
      deps: {
        rename: (from: string, to: string) => {
          if (!originalBackupPath && from === packageDir && to.includes(".ocx-backup-")) {
            originalBackupPath = to;
          } else if (from === packageDir && to === originalBackupPath) {
            throw new Error("EPERM: could not preserve rejected backup");
          }
          renameSync(from, to);
        },
      },
    });
    expect(result.ok).toBe(true);

    expect(result.rollback!()).toMatchObject({
      ok: false,
      phase: "double-fault",
      rolledBack: false,
      recoveryUnsafe: true,
    });
    expect(version(packageDir)).toBe("2.40.0-ben.2");
    const recoveryMarker = JSON.parse(readFileSync(join(dirname(packageDir), ".ocx-recovery.json"), "utf8"));
    expect(recoveryMarker.backupPreserveError).toContain("could not preserve rejected backup");
    expect(version(recoveryMarker.failedLive)).toBe("2.40.0-ben.3");
  });

  test("commit refuses to delete a replacement at the original backup path", () => {
    const { packageDir, stagedTree } = setup();
    const result = transactionalNpmUpdate(options(packageDir, stagedTree));
    expect(result.ok).toBe(true);
    const backupPackage = result.backup!;
    const originalBackupRoot = dirname(backupPackage);
    renameSync(originalBackupRoot, `${originalBackupRoot}-original`);
    packageTree(backupPackage, "attacker");

    expect(result.commit!()).toMatchObject({ ok: false, recoveryUnsafe: true });
    expect(version(packageDir)).toBe("2.40.0-ben.3");
    expect(version(backupPackage)).toBe("attacker");
    expect(existsSync(join(dirname(packageDir), ".ocx-transaction.json"))).toBe(true);
  });

  test("rollback revalidates the backup after moving the failed live tree aside", () => {
    const { packageDir, stagedTree } = setup();
    let backupRoot = "";
    let raced = false;
    const result = transactionalNpmUpdate({
      ...options(packageDir, stagedTree),
      deps: {
        rename: (from: string, to: string) => {
          renameSync(from, to);
          if (!backupRoot && to.includes(".ocx-backup-")) backupRoot = dirname(to);
          if (!raced && from === packageDir && to.includes(".ocx-failed-live-")) {
            raced = true;
            renameSync(backupRoot, `${backupRoot}-original`);
            packageTree(join(backupRoot, "opencodex"), "attacker");
          }
        },
      },
    });
    expect(result.ok).toBe(true);

    expect(result.rollback!()).toMatchObject({ ok: false, recoveryUnsafe: true });
    expect(version(packageDir)).toBe("2.40.0-ben.3");
    expect(version(join(backupRoot, "opencodex"))).toBe("attacker");
  });

  test("Windows path identity accepts canonical casing differences", () => {
    const { packageDir, stagedTree } = setup();
    const result = transactionalNpmUpdate(options(packageDir, stagedTree));
    expect(result.ok).toBe(true);
    const scopeSegment = `${join(dirname(packageDir), "_").slice(0, -1)}`;
    const mixedCaseRealpath = (path: string) => realpathSync(path).replace(scopeSegment, scopeSegment.toUpperCase());

    expect(bootRestoreProbe(packageDir, {
      isProcessAlive: () => true,
      platform: "win32",
      realpath: mixedCaseRealpath,
    })).toMatchObject({ action: "pending" });
  });

  test("fresh recovery markers are owner-only", () => {
    const { packageDir, stagedTree } = setup();
    let renameCalls = 0;
    const result = transactionalNpmUpdate({
      ...options(packageDir, stagedTree),
      deps: {
        rename: (from: string, to: string) => {
          renameCalls += 1;
          if (renameCalls >= 2) throw Object.assign(new Error("EPERM: rollback also blocked"), { code: "EPERM" });
          renameSync(from, to);
        },
      },
    });
    expect(result).toMatchObject({ ok: false, phase: "double-fault" });
    expect(lstatSync(join(dirname(packageDir), ".ocx-recovery.json")).mode & 0o777).toBe(0o600);
  });
});

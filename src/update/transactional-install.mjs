/**
 * Transactional npm self-update: stage -> verify -> swap -> rollback (#1942 / #1849).
 *
 * The legacy path ran `npm install -g` straight into the live global tree, so a
 * failure after npm removed the old files left a file-less package skeleton with no
 * recovery. This module stages the new version into a SIBLING directory of the live
 * package (same volume, so directory renames are atomic-ish and never cross devices),
 * verifies the staged tree with a manifest before anything live is touched, then swaps
 * live -> backup -> stage-into-live with a reverse-rename rollback on failure and a
 * recovery marker on double fault.
 *
 * Layout (siblings, never children — a child would travel WITH the live rename and the
 * live dir cannot move into its own subtree):
 *   <scopeDir>/opencodex                      live package
 *   <scopeDir>/.ocx-staging-<ts>/             npm --prefix root (contains node_modules/...)
 *   <scopeDir>/.ocx-backup-<ts>/opencodex     previous live tree during/after the swap
 *   <scopeDir>/.ocx-recovery.json             double-fault marker with a one-line restore
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Verification manifest for a staged (or live) package tree. */
export function verifyInstallTree(packageDir, expectedVersion) {
  const failures = [];
  let canonicalRoot;
  try {
    const rootStat = lstatSync(packageDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { ok: false, failures: ["package root must be a regular directory"] };
    }
    canonicalRoot = realpathSync(packageDir);
  } catch (error) {
    return { ok: false, failures: ["package root unreadable: " + (error?.message ?? String(error))] };
  }
  const regularFile = (parts, label, minimumSize = 0) => {
    const path = join(packageDir, ...parts);
    for (let index = 0; index < parts.length; index += 1) {
      const ancestor = join(packageDir, ...parts.slice(0, index + 1));
      try {
        const stat = lstatSync(ancestor);
        if (stat.isSymbolicLink()) return label + " must not be a symlink";
      } catch {
        return label + " absent";
      }
    }
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < minimumSize) return label + " missing or truncated";
      if (!canonicalPathIsContained(canonicalRoot, realpathSync(path))) return label + " escapes package root";
      return null;
    } catch {
      return label + " absent";
    }
  };
  let pkg;
  try {
    const packageJsonFailure = regularFile(["package.json"], "package.json");
    if (packageJsonFailure) return { ok: false, failures: [packageJsonFailure] };
    pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  } catch (error) {
    return { ok: false, failures: ["package.json unreadable: " + (error?.message ?? String(error))] };
  }
  if (expectedVersion && pkg.version !== expectedVersion) {
    failures.push("package.json version " + pkg.version + " != expected " + expectedVersion);
  }
  const launcher = join(packageDir, "bin", "ocx.mjs");
  const launcherFailure = regularFile(["bin", "ocx.mjs"], "bin/ocx.mjs", 1024);
  if (launcherFailure) failures.push(launcherFailure);
  // The bundled Bun binary is the load-bearing artifact: without it the launcher exits
  // before serving anything, and a boot probe that called this tree healthy would reap
  // the only backup (review High 3). Size-gate the real binary, not just its package.json.
  const bunPkgDir = join(packageDir, "node_modules", "bun");
  if (existsSync(bunPkgDir)) {
    let bunRootUnsafe = false;
    try {
      for (const part of ["node_modules", "bun"]) {
        const parent = join(packageDir, ...(part === "bun" ? ["node_modules", part] : [part]));
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) bunRootUnsafe = true;
      }
    } catch {
      bunRootUnsafe = true;
    }
    const bunTree = bunRootUnsafe ? { largest: undefined, unsafe: true } : findLargestFile(bunPkgDir, canonicalRoot);
    if (bunTree.unsafe || !bunTree.largest || bunTree.largest.size < 10 * 1024 * 1024) {
      failures.push("bundled Bun binary missing or truncated (< 10MB)");
    }
  }
  // Sentinel direct deps: each must have an intact package.json. The bundled Bun dep is
  // the load-bearing one — without it the launcher cannot start the proxy at all.
  const deps = Object.keys(pkg.dependencies ?? {});
  const sentinels = deps.filter(name => name === "bun" || name === "zod").length > 0
    ? deps.filter(name => name === "bun" || name === "zod")
    : deps.slice(0, 2);
  for (const name of sentinels) {
    const failure = regularFile(["node_modules", ...name.split("/"), "package.json"], "sentinel dependency missing: " + name);
    if (failure) failures.push(failure);
  }
  return failures.length === 0 ? { ok: true, failures: [] } : { ok: false, failures };
}

function stampedName(prefix) {
  return prefix + "-" + new Date().toISOString().replace(/[:.]/g, "-");
}

/** Largest regular file under a directory tree (bounded depth) — locates the Bun binary. */
function canonicalPathIsContained(rootPath, childPath, platform = process.platform) {
  const root = normalizePathIdentity(rootPath, platform);
  const child = normalizePathIdentity(childPath, platform);
  const remainder = relative(root, child);
  return remainder.length > 0 && !remainder.startsWith("..") && !isAbsolute(remainder);
}

function findLargestFile(root, canonicalPackageRoot, depth = 3) {
  let best;
  let names = [];
  try { names = readdirSync(root); } catch { return { largest: undefined, unsafe: true }; }
  for (const name of names) {
    const full = join(root, name);
    let st;
    try { st = lstatSync(full); } catch { return { largest: undefined, unsafe: true }; }
    if (st.isSymbolicLink()) return { largest: undefined, unsafe: true };
    if (st.isFile()) {
      try {
        if (!canonicalPathIsContained(canonicalPackageRoot, realpathSync(full))) {
          return { largest: undefined, unsafe: true };
        }
      } catch {
        return { largest: undefined, unsafe: true };
      }
      if (!best || st.size > best.size) best = { path: full, size: st.size };
    } else if (st.isDirectory() && depth > 0) {
      const sub = findLargestFile(full, canonicalPackageRoot, depth - 1);
      if (sub.unsafe) return sub;
      if (sub.largest && (!best || sub.largest.size > best.size)) best = sub.largest;
    }
  }
  return { largest: best, unsafe: false };
}

/** Bounded Windows-class rename retry: EPERM/EBUSY/EACCES from AV/indexers clears in ms. */
function renameWithRetry(rename, from, to, attempts = 5) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = error?.code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt >= attempts - 1) throw error;
      // Synchronous bounded backoff (launcher context has no async loop here).
      const until = Date.now() + 100 * (attempt + 1);
      while (Date.now() < until) { /* spin briefly; total worst case ~1.5s */ }
    }
  }
}

function recoveryMarkerPath(scopeDir) {
  return join(scopeDir, ".ocx-recovery.json");
}

function pendingMarkerPath(scopeDir) {
  return join(scopeDir, ".ocx-transaction.json");
}

function normalizePathIdentity(path, platform = process.platform) {
  const normalized = resolve(path);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathIdentity(path, deps = {}) {
  const realpath = deps.realpath ?? realpathSync;
  const platform = deps.platform ?? process.platform;
  const suffix = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  let canonical;
  try { canonical = resolve(realpath(existing), ...suffix); } catch { canonical = resolve(path); }
  return normalizePathIdentity(canonical, platform);
}

function readPendingMarker(scopeDir) {
  if (!existsSync(pendingMarkerPath(scopeDir))) return { state: "absent" };
  try {
    const parsed = JSON.parse(readFileSync(pendingMarkerPath(scopeDir), "utf8"));
    if (!parsed || parsed.state !== "pending" || typeof parsed.id !== "string" || parsed.id.length === 0
      || !Number.isSafeInteger(parsed.ownerPid) || parsed.ownerPid <= 0
      || typeof parsed.live !== "string" || typeof parsed.backup !== "string") return { state: "invalid" };
    return { state: "pending", id: parsed.id, ownerPid: parsed.ownerPid, live: parsed.live, backup: parsed.backup };
  } catch {
    return { state: "invalid" };
  }
}

function pendingMarkerMatches(marker, transaction) {
  return marker.state === "pending"
    && marker.id === transaction.id
    && marker.ownerPid === transaction.ownerPid
    && pathIdentity(marker.live) === pathIdentity(transaction.live)
    && pathIdentity(marker.backup) === pathIdentity(transaction.backup);
}

function safeBackupIdentity(scopeDir, backupPath, deps = {}) {
  const realpath = deps.realpath ?? realpathSync;
  const platform = deps.platform ?? process.platform;
  const scope = pathIdentity(scopeDir, deps);
  const requestedBackup = resolve(backupPath);
  const requestedRoot = dirname(requestedBackup);
  if (pathIdentity(dirname(requestedRoot), deps) !== scope
    || !basename(requestedRoot).startsWith(".ocx-backup-")
    || basename(backupPath) !== "opencodex"
    || requestedBackup !== resolve(requestedRoot, "opencodex")) return null;
  try {
    const rootStat = lstatSync(requestedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const canonicalRoot = realpath(requestedRoot);
    const canonicalName = platform === "win32" ? basename(canonicalRoot).toLowerCase() : basename(canonicalRoot);
    const requestedName = platform === "win32" ? basename(requestedRoot).toLowerCase() : basename(requestedRoot);
    if (normalizePathIdentity(dirname(canonicalRoot), platform) !== scope
      || canonicalName !== requestedName) return null;
    const canonicalBackup = resolve(canonicalRoot, "opencodex");
    if (existsSync(requestedBackup)) {
      const backupStat = lstatSync(requestedBackup);
      if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) return null;
    }
    return canonicalBackup;
  } catch {
    return null;
  }
}

function writePendingMarker(scopeDir, transaction, deps) {
  const markerPath = pendingMarkerPath(scopeDir);
  const temporaryPath = join(scopeDir, `.ocx-transaction-${transaction.id}.tmp`);
  try {
    if (existsSync(markerPath)) throw new Error("pending transaction marker already exists");
    deps.writeFile(temporaryPath, JSON.stringify({ state: "pending", ...transaction }, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    deps.linkMarker(temporaryPath, markerPath);
    deps.remove(temporaryPath, { force: true });
    const written = readPendingMarker(scopeDir);
    if (!pendingMarkerMatches(written, transaction)) {
      throw new Error("pending transaction marker failed readback verification");
    }
    return { written: true };
  } catch (error) {
    try { deps.remove(temporaryPath, { force: true }); } catch { /* best effort */ }
    return { written: false, error: error?.message ?? String(error) };
  }
}

function writeRecoveryMarker(scopeDir, payload, deps = {}) {
  const writeFile = deps.writeFile ?? writeFileSync;
  const linkMarker = deps.linkMarker ?? linkSync;
  const remove = deps.remove ?? rmSync;
  const markerPath = recoveryMarkerPath(scopeDir);
  const temporaryPath = join(scopeDir, `.ocx-recovery-${randomUUID()}.tmp`);
  try {
    if (existsSync(markerPath)) throw new Error("recovery marker already exists");
    writeFile(temporaryPath, JSON.stringify(payload, null, 2), { flag: "wx", mode: 0o600 });
    linkMarker(temporaryPath, markerPath);
    remove(temporaryPath, { force: true });
    const written = lstatSync(markerPath);
    if (!written.isFile() || written.isSymbolicLink()) throw new Error("recovery marker is not a regular file");
    return { written: true };
  } catch (error) {
    try { remove(temporaryPath, { force: true }); } catch { /* best effort */ }
    return { written: false, error: error?.message ?? String(error) };
  }
}

function directoryIdentity(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameDirectoryIdentity(path, expected) {
  const current = directoryIdentity(path);
  return current !== null && expected !== null
    && current.dev === expected.dev
    && current.ino === expected.ino;
}

function stagedTreeIdentity(stageRoot, stagedPackage, realpath = realpathSync) {
  const root = directoryIdentity(stageRoot);
  const packageIdentity = directoryIdentity(stagedPackage);
  if (root === null || packageIdentity === null) return null;
  try {
    const canonicalRoot = realpath(stageRoot);
    const canonicalPackage = realpath(stagedPackage);
    if (!canonicalPathIsContained(canonicalRoot, canonicalPackage)) return null;
  } catch {
    return null;
  }
  return { root, package: packageIdentity };
}

function sameStagedTreeIdentity(stageRoot, stagedPackage, expected, realpath = realpathSync) {
  return expected !== null
    && sameDirectoryIdentity(stageRoot, expected.root)
    && sameDirectoryIdentity(stagedPackage, expected.package)
    && stagedTreeIdentity(stageRoot, stagedPackage, realpath) !== null;
}

/** Startup probe: restore a backup when the live tree is broken (D4 power-loss rows). */
export function bootRestoreProbe(packageDir, deps = {}) {
  const rename = deps.rename ?? renameSync;
  const remove = deps.remove ?? rmSync;
  const readDirectory = deps.readDirectory ?? readdirSync;
  const pathDeps = { realpath: deps.realpath ?? realpathSync, platform: deps.platform ?? process.platform };
  const isProcessAlive = deps.isProcessAlive ?? ((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  });
  const scopeDir = dirname(packageDir);
  const pending = readPendingMarker(scopeDir);
  const recovery = (() => {
    try { return JSON.parse(readFileSync(recoveryMarkerPath(scopeDir), "utf8")); } catch { return null; }
  })();
  const oldPackageAlreadyRestored = recovery?.error === "previous package restored but pending marker cleanup failed";
  let backups = [];
  try {
    backups = readDirectory(scopeDir).filter(name => name.startsWith(".ocx-backup-")).sort();
  } catch (error) {
    return { action: "failed", error: "package scope could not be enumerated: " + (error?.message ?? String(error)) };
  }
  for (const name of backups) {
    if (safeBackupIdentity(scopeDir, join(scopeDir, name, "opencodex"), pathDeps) === null) {
      return { action: "failed", error: "package scope contains an unsafe transactional backup" };
    }
  }
  if (pending.state === "invalid") return { action: "failed", error: "pending transaction marker is invalid" };
  if (pending.state === "pending" && pathIdentity(pending.live, pathDeps) !== pathIdentity(packageDir, pathDeps)) {
    return { action: "failed", error: "pending transaction marker does not match this package and backup set" };
  }
  if (pending.state === "pending" && isProcessAlive(pending.ownerPid)) {
    const markedBackup = safeBackupIdentity(scopeDir, pending.backup, pathDeps);
    return markedBackup !== null
      ? { action: "pending", from: markedBackup }
      : { action: "failed", error: "pending transaction marker does not match this package and backup set" };
  }
  if (backups.length === 0) {
    if (pending.state !== "pending") return { action: "none" };
    const liveOk = existsSync(join(packageDir, "package.json")) && verifyInstallTree(packageDir).ok;
    if (!liveOk) return { action: "failed", error: "pending transaction backup is missing" };
    if (!oldPackageAlreadyRestored && existsSync(dirname(pathIdentity(pending.backup)))) {
      return { action: "failed", error: "pending transaction backup is missing" };
    }
    try {
      remove(pendingMarkerPath(scopeDir), { force: true });
      const preparedBackup = safeBackupIdentity(scopeDir, pending.backup, pathDeps);
      if (preparedBackup !== null) {
        try { remove(dirname(preparedBackup), { recursive: true, force: true }); } catch { /* empty prepared backup root only */ }
      }
      if (oldPackageAlreadyRestored) {
        try { remove(recoveryMarkerPath(scopeDir), { force: true }); } catch { /* stale diagnostic only */ }
      }
      return { action: "aborted" };
    } catch (error) {
      return { action: "failed", error: "dead prepared transaction marker could not be removed: " + (error?.message ?? String(error)) };
    }
  }
  const liveOk = existsSync(join(packageDir, "package.json"))
    && verifyInstallTree(packageDir).ok;
  if (pending.state === "pending" && recovery?.reason === "restored-backup-verification-failed") {
    return { action: "failed", error: "pending transaction backup failed verification during rollback" };
  }
  if (pending.state === "pending"
    && liveOk
    && !oldPackageAlreadyRestored
    && existsSync(join(pending.backup, "package.json"))) {
    return {
      action: "failed",
      error: "pending transaction owner exited after a complete live package landed; refusing to overwrite it automatically",
    };
  }
  const newestBackup = join(scopeDir, backups[backups.length - 1], "opencodex");
  let restoreBackup = newestBackup;
  if (pending.state === "pending") {
    const markedBackup = safeBackupIdentity(scopeDir, pending.backup, pathDeps);
    if (markedBackup === null) {
      return { action: "failed", error: "pending transaction marker does not match this package and backup set" };
    }
    const belongsToBackups = backups.some(name =>
      pathIdentity(join(scopeDir, name, "opencodex"), pathDeps) === pathIdentity(markedBackup, pathDeps));
    if (!belongsToBackups) {
      if (liveOk) {
        try {
          remove(pendingMarkerPath(scopeDir), { force: true });
          return { action: "aborted" };
        } catch (error) {
          return { action: "failed", error: "restored transaction marker could not be removed: " + (error?.message ?? String(error)) };
        }
      }
      return { action: "failed", error: "pending transaction backup is missing" };
    }
    if (!existsSync(join(markedBackup, "package.json"))) {
      if (liveOk && recovery?.error === "previous package restored but pending marker cleanup failed") {
        try {
          remove(pendingMarkerPath(scopeDir), { force: true });
          try { remove(recoveryMarkerPath(scopeDir), { force: true }); } catch { /* stale diagnostic only */ }
          return { action: "aborted" };
        } catch (error) {
          return { action: "failed", error: "restored transaction marker could not be removed: " + (error?.message ?? String(error)) };
        }
      }
      if (liveOk) {
        try {
          remove(pendingMarkerPath(scopeDir), { force: true });
          try { remove(dirname(markedBackup), { recursive: true, force: true }); } catch { /* empty prepared backup root only */ }
          return { action: "aborted" };
        } catch (error) {
          return { action: "failed", error: "dead prepared transaction marker could not be removed: " + (error?.message ?? String(error)) };
        }
      }
      return { action: "failed", error: "pending transaction backup is missing" };
    }
    restoreBackup = markedBackup;
  }
  if (liveOk && pending.state !== "pending") {
    // Live is healthy: the backups are leftovers from a completed swap. Reap them.
    for (const name of backups) {
      try { rmSync(join(scopeDir, name), { recursive: true, force: true }); } catch { /* keep */ }
    }
    try { rmSync(recoveryMarkerPath(scopeDir), { force: true }); } catch { /* keep */ }
    return { action: "reaped", count: backups.length };
  }
  if (!existsSync(join(restoreBackup, "package.json"))) return { action: "none" };
  let backupCheck;
  try {
    backupCheck = verifyInstallTree(restoreBackup);
  } catch (error) {
    backupCheck = { ok: false, failures: [error?.message ?? String(error)] };
  }
  if (!backupCheck.ok) {
    return {
      action: "failed",
      error: "pending transaction backup failed verification: " + backupCheck.failures.join("; "),
    };
  }
  try {
    try { rmSync(packageDir, { recursive: true, force: true }); } catch { /* may not exist */ }
    rename(restoreBackup, packageDir);
    if (pending.state === "pending") {
      remove(pendingMarkerPath(scopeDir), { force: true });
      try { remove(dirname(restoreBackup), { recursive: true, force: true }); } catch { /* empty backup root only */ }
    }
    return { action: "restored", from: restoreBackup };
  } catch (error) {
    return { action: "failed", error: error?.message ?? String(error) };
  }
}

/**
 * Run the transactional update. `runNpm(args, opts)` is injected so the caller keeps
 * its hardened npm resolution (npm-invocation.mjs) and logging.
 */
export function transactionalNpmUpdate({
  packageDir,
  pkgName,
  targetVersion,
  tag,
  packageSpec,
  installArgs,
  runNpm,
  verifyStage = verifyInstallTree,
  verifyLive = verifyInstallTree,
  verifyRollback = verifyInstallTree,
  log = () => {},
  deferCommit = false,
  deps = {},
}) {
  const rename = deps.rename ?? renameSync;
  const linkMarker = deps.linkMarker ?? linkSync;
  const realpath = deps.realpath ?? realpathSync;
  const remove = deps.remove ?? rmSync;
  const writeFile = deps.writeFile ?? writeFileSync;
  const writeRecoveryFile = deps.writeRecoveryFile ?? writeFile;
  const scopeDir = dirname(packageDir);
  const preexistingPending = readPendingMarker(scopeDir);
  if (preexistingPending.state !== "absent") {
    return { ok: false, phase: "pending-existing", recoveryUnsafe: true, error: "an earlier package transaction still requires recovery" };
  }
  const stageRoot = join(scopeDir, stampedName(".ocx-staging"));
  // GLOBAL-style staging (-g --prefix): npm nests the package's dependencies INSIDE the
  // package dir, exactly like the live global tree this stage will replace. A local-style
  // install would hoist bun/zod to stageRoot/node_modules — siblings that the swap would
  // leave behind, shipping a dependency-less live tree (release-audit blocker).
  // Layout: <stageRoot>/lib/node_modules/<pkg> on POSIX, <stageRoot>/node_modules/<pkg>
  // on Windows.
  const stagedCandidates = [
    join(stageRoot, "lib", "node_modules", ...pkgName.split("/")),
    join(stageRoot, "node_modules", ...pkgName.split("/")),
  ];

  // D1: stage to the side. --prefix keeps npm entirely inside stageRoot; the live tree
  // and the npm bin shims are untouched until the swap. A failure HERE (mkdir EACCES,
  // ENOSPC) must NOT fall back to the destructive legacy install (review High 4): the
  // caller sees a normal phase failure with live untouched.
  try {
    mkdirSync(stageRoot, { recursive: true });
  } catch (error) {
    return { ok: false, phase: "stage", error: "could not create staging directory: " + (error?.message ?? String(error)) };
  }
  const spec = packageSpec || pkgName + "@" + (targetVersion || tag);
  log("Staging " + spec + " into " + stageRoot);
  // npm 12 blocks lifecycle scripts by default. Bun's postinstall copies the selected
  // @oven/bun-* executable into bun/bin, so a successful npm exit without this narrow
  // approval leaves the staged tree intentionally incomplete. Allow only the package
  // whose executable the manifest verifies below; never broaden this to all scripts.
  const install = runNpm([
    "install", "-g", "--prefix", stageRoot,
    ...(installArgs || ["--allow-scripts=bun", "--no-audit", "--no-fund"]),
    spec,
  ]);
  if (install.status !== 0) {
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: "stage", error: "npm staging install failed (" + (install.status ?? "?") + ")" };
  }
  const stagedPackage = stagedCandidates.find(dir => existsSync(join(dir, "package.json")));
  if (!stagedPackage) {
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: "verify", error: "staged package directory not found under " + stageRoot };
  }

  // Bind the verifier's result to this exact staged root and package. npm's successful
  // exit only proves it wrote a path; every directory can be replaced before the swap.
  const stageIdentity = stagedTreeIdentity(stageRoot, stagedPackage, realpath);
  if (stageIdentity === null) {
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: "verify", error: "staged package path is unsafe" };
  }

  // D2: verify INSIDE the stage. Live is still untouched on any failure here.
  let staged;
  try {
    staged = verifyStage(stagedPackage, targetVersion || undefined);
  } catch (error) {
    staged = { ok: false, failures: [error?.message ?? String(error)] };
  }
  if (!staged.ok) {
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: "verify", error: "staged tree failed verification: " + staged.failures.join("; ") };
  }
  if (!sameStagedTreeIdentity(stageRoot, stagedPackage, stageIdentity, realpath)) {
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: "verify", error: "staged package object identity changed during verification" };
  }

  // D3: swap. live -> backup, stage -> live, re-verify live, rollback on failure.
  const backupRoot = join(scopeDir, stampedName(".ocx-backup"));
  const backupPackage = join(backupRoot, "opencodex");
  let pendingTransaction;
  try {
    mkdirSync(backupRoot, { recursive: true });
  } catch (error) {
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: "swap-backup", error: "could not create backup directory: " + (error?.message ?? String(error)) };
  }
  pendingTransaction = {
    id: randomUUID(),
    ownerPid: process.pid,
    live: pathIdentity(packageDir),
    backup: pathIdentity(backupPackage),
  };
  const marker = writePendingMarker(scopeDir, pendingTransaction, { writeFile, linkMarker, remove });
  if (!marker.written) {
    const onDisk = readPendingMarker(scopeDir);
    if (onDisk.state !== "absent") {
      return {
        ok: false,
        phase: "pending-marker",
        recoveryUnsafe: true,
        error: "could not record a trustworthy pending transaction: " + marker.error,
      };
    }
    try { remove(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    try { remove(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: "pending-marker", error: "could not record pending transaction: " + marker.error };
  }
  try {
    renameWithRetry(rename, packageDir, backupPackage);
  } catch (error) {
    let markerCleanupError;
    if (pendingTransaction) {
      try { remove(pendingMarkerPath(scopeDir), { force: true }); } catch (cleanupError) { markerCleanupError = cleanupError; }
    }
    try { remove(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    try { remove(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return markerCleanupError === undefined
      ? { ok: false, phase: "swap-backup", error: "could not move live tree aside: " + (error?.message ?? String(error)) }
      : {
        ok: false,
        phase: "double-fault",
        recoveryUnsafe: true,
        markerCleanupFailed: true,
        error: "live tree stayed intact but pending marker cleanup failed: " + (markerCleanupError?.message ?? String(markerCleanupError)),
      };
  }
  const backupIdentity = {
    root: directoryIdentity(backupRoot),
    package: directoryIdentity(backupPackage),
  };
  let canonicalBackup;
  try {
    if (backupIdentity.root === null || backupIdentity.package === null) {
      throw new Error("backup object identity could not be recorded");
    }
    canonicalBackup = realpath(backupPackage);
  } catch (error) {
    const rollback = rollbackPackageSwap({
      packageDir,
      backupPackage,
      backupRoot,
      scopeDir,
      rename,
      writeRecoveryFile,
      linkMarker,
      remove,
      pendingTransaction,
      backupIdentity,
      verifyRollback,
    });
    return rollback.ok
      ? {
          ok: false,
          phase: "post-verify",
          rolledBack: true,
          error: "canonical backup lookup failed after package swap: " + (error?.message ?? String(error)),
        }
      : rollback;
  }
  try {
    if (!sameStagedTreeIdentity(stageRoot, stagedPackage, stageIdentity, realpath)) {
      throw new Error("staged package object identity changed before placement");
    }
    renameWithRetry(rename, stagedPackage, packageDir);
  } catch (error) {
    const rollback = rollbackPackageSwap({
      packageDir,
      backupPackage,
      backupRoot,
      scopeDir,
      rename,
      writeRecoveryFile,
      linkMarker,
      remove,
      pendingTransaction,
      backupIdentity,
      verifyRollback,
    });
    return rollback.ok
      ? { ok: false, phase: "swap-live", rolledBack: true, error: "could not place staged tree: " + (error?.message ?? String(error)) }
      : rollback;
  }
  let liveCheck;
  try {
    liveCheck = verifyLive(packageDir, targetVersion || undefined);
  } catch (error) {
    liveCheck = { ok: false, failures: [error?.message ?? String(error)] };
  }
  if (!liveCheck.ok) {
    const rollback = rollbackPackageSwap({
      packageDir,
      backupPackage,
      backupRoot,
      scopeDir,
      rename,
      writeRecoveryFile,
      linkMarker,
      remove,
      pendingTransaction,
      backupIdentity,
      verifyRollback,
    });
    return rollback.ok
      ? { ok: false, phase: "post-verify", rolledBack: true, error: "live tree failed post-swap verification: " + liveCheck.failures.join("; ") }
      : rollback;
  }
  // Success: stage scaffolding is disposable now; the backup stays until the next
  // healthy boot reaps it (bootRestoreProbe) — the process that spawned this update may
  // still hold the old cwd.
  try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  if (deferCommit) {
    let state = "pending";
    const verifyOwnership = () => {
      const marker = readPendingMarker(scopeDir);
      return pendingMarkerMatches(marker, pendingTransaction)
        ? { ok: true }
        : { ok: false, phase: "pending-owner", recoveryUnsafe: true, error: "pending transaction marker is missing or belongs to another transaction" };
    };
    const verifyBackupObject = () => safeBackupIdentity(scopeDir, backupPackage) !== null
      && sameDirectoryIdentity(backupRoot, backupIdentity.root)
      && sameDirectoryIdentity(backupPackage, backupIdentity.package)
      ? { ok: true }
      : { ok: false, phase: "pending-owner", recoveryUnsafe: true, error: "transactional backup object identity changed" };
    const commit = () => {
      if (state === "committed") return { ok: true, phase: "committed" };
      if (state !== "pending") return { ok: false, phase: state, error: "transaction is no longer pending" };
      const ownership = verifyOwnership();
      if (!ownership.ok) return ownership;
      const backupObject = verifyBackupObject();
      if (!backupObject.ok) return backupObject;
      try {
        remove(pendingMarkerPath(scopeDir), { force: true });
        state = "committed";
        try { remove(backupRoot, { recursive: true, force: true }); } catch { /* next healthy probe can reap */ }
        try { remove(recoveryMarkerPath(scopeDir), { force: true }); } catch { /* best effort */ }
        return { ok: true, phase: "committed" };
      } catch (error) {
        return { ok: false, phase: "commit", error: error?.message ?? String(error) };
      }
    };
    const rollback = () => {
      if (state === "rolled-back") return { ok: true, phase: "rolled-back" };
      if (state !== "pending") return { ok: false, phase: state, error: "transaction is no longer pending" };
      const ownership = verifyOwnership();
      if (!ownership.ok) return ownership;
      const result = rollbackPackageSwap({
        packageDir,
        backupPackage,
        backupRoot,
        scopeDir,
        rename,
        writeRecoveryFile,
        linkMarker,
        remove,
        pendingTransaction,
        backupIdentity,
        verifyRollback,
      });
      if (result.ok) state = "rolled-back";
      return result;
    };
    return { ok: true, phase: "pending", backup: canonicalBackup, commit, rollback };
  }
  if (!pendingMarkerMatches(readPendingMarker(scopeDir), pendingTransaction)) {
    return { ok: false, phase: "pending-owner", recoveryUnsafe: true, backup: backupPackage, error: "pending transaction marker is missing or belongs to another transaction" };
  }
  try {
    remove(pendingMarkerPath(scopeDir), { force: true });
  } catch (error) {
    return { ok: false, phase: "commit", recoveryUnsafe: true, backup: backupPackage, error: "completed package swap but could not clear pending marker: " + (error?.message ?? String(error)) };
  }
  return { ok: true, phase: "done", backup: backupPackage };
}

function rollbackPackageSwap({
  packageDir,
  backupPackage,
  backupRoot,
  scopeDir,
  rename,
  writeRecoveryFile,
  linkMarker,
  remove,
  pendingTransaction,
  backupIdentity,
  verifyRollback,
}) {
  if (pendingTransaction && !pendingMarkerMatches(readPendingMarker(scopeDir), pendingTransaction)) {
    return {
      ok: false,
      phase: "pending-owner",
      recoveryUnsafe: true,
      error: "pending transaction marker is missing or belongs to another transaction",
    };
  }
  const recoveryMarker = payload => writeRecoveryMarker(scopeDir, payload, {
    writeFile: writeRecoveryFile,
    linkMarker,
    remove,
  });
  const backupObjectMatches = () => backupIdentity
    && safeBackupIdentity(scopeDir, backupPackage) !== null
    && sameDirectoryIdentity(backupRoot, backupIdentity.root)
    && sameDirectoryIdentity(backupPackage, backupIdentity.package);
  const failedLive = join(scopeDir, stampedName(".ocx-failed-live"));
  let quarantinedLive = false;
  const restoreQuarantinedLive = () => {
    if (!quarantinedLive) return { ok: true };
    try {
      if (existsSync(packageDir)) {
        throw new Error("live package path is occupied; refusing to delete it while restoring quarantined live");
      }
      renameWithRetry(rename, failedLive, packageDir);
      quarantinedLive = false;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  };
  if (!backupObjectMatches()) {
    const marker = recoveryMarker({
      at: new Date().toISOString(),
      backup: backupPackage,
      live: packageDir,
      error: "transactional backup object identity changed before rollback",
    });
    return {
      ok: false,
      phase: "double-fault",
      rolledBack: false,
      recoveryUnsafe: true,
      markerWriteFailed: !marker.written,
      error: marker.written
        ? "transactional backup object identity changed; recovery marker written"
        : "transactional backup object identity changed; recovery marker could not be written: " + marker.error,
    };
  }
  try {
    if (existsSync(packageDir)) {
      renameWithRetry(rename, packageDir, failedLive);
      quarantinedLive = true;
    }
    if (!backupObjectMatches()) {
      const restoredLive = restoreQuarantinedLive();
      const marker = recoveryMarker({
        at: new Date().toISOString(),
        backup: backupPackage,
        live: packageDir,
        error: "transactional backup object identity changed during rollback",
        failedLive: restoredLive.ok ? undefined : failedLive,
        liveRestoreError: restoredLive.ok ? undefined : restoredLive.error,
      });
      return {
        ok: false,
        phase: "double-fault",
        rolledBack: false,
        recoveryUnsafe: true,
        markerWriteFailed: !marker.written,
        error: restoredLive.ok
          ? "transactional backup object identity changed during rollback"
          : "transactional backup object identity changed and failed live could not be restored: " + restoredLive.error,
      };
    }
    renameWithRetry(rename, backupPackage, packageDir);
    let restored;
    try {
      restored = verifyRollback(packageDir);
    } catch (error) {
      restored = { ok: false, failures: [error?.message ?? String(error)] };
    }
    if (!restored.ok) {
      let backupPreserveError;
      try {
        if (existsSync(backupPackage)) {
          throw new Error("transactional backup path was unexpectedly occupied");
        }
        renameWithRetry(rename, packageDir, backupPackage);
        if (!backupObjectMatches()) {
          throw new Error("restored backup object identity changed while preserving it");
        }
      } catch (error) {
        backupPreserveError = error?.message ?? String(error);
      }
      const restoredLive = restoreQuarantinedLive();
      const marker = recoveryMarker({
        at: new Date().toISOString(),
        reason: "restored-backup-verification-failed",
        backup: backupPackage,
        live: packageDir,
        error: "restored package failed verification: " + restored.failures.join("; "),
        backupPreserveError,
        failedLive: restoredLive.ok ? undefined : failedLive,
        liveRestoreError: restoredLive.ok ? undefined : restoredLive.error,
      });
      return {
        ok: false,
        phase: "double-fault",
        rolledBack: false,
        recoveryUnsafe: true,
        markerWriteFailed: !marker.written,
        error: backupPreserveError
          ? "restored package failed verification and could not be preserved at its backup path: " + backupPreserveError
          : marker.written
            ? "restored package failed verification; recovery marker written"
            : "restored package failed verification; recovery marker could not be written: " + marker.error,
      };
    }
    if (quarantinedLive) {
      try { remove(failedLive, { recursive: true, force: true }); } catch { /* verified old live already restored */ }
      quarantinedLive = false;
    }
    if (pendingTransaction) {
      try {
        remove(pendingMarkerPath(scopeDir), { force: true });
      } catch (error) {
        const marker = recoveryMarker({
          at: new Date().toISOString(),
          backup: backupPackage,
          live: packageDir,
          error: "previous package restored but pending marker cleanup failed",
          markerCleanupError: String(error?.message ?? error),
        });
        return {
          ok: false,
          phase: "double-fault",
          rolledBack: true,
          recoveryUnsafe: true,
          markerCleanupFailed: true,
          markerWriteFailed: !marker.written,
          error: marker.written
            ? "previous package restored but pending marker cleanup failed; recovery marker written"
            : "previous package restored but pending and recovery marker cleanup failed: " + marker.error,
        };
      }
    }
    try { remove(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: true, phase: "rolled-back" };
  } catch (rollbackError) {
    const restoredLive = restoreQuarantinedLive();
    const marker = recoveryMarker({
      at: new Date().toISOString(),
      backup: backupPackage,
      live: packageDir,
      restore: 'move "' + backupPackage + '" back to "' + packageDir + '"',
      rollbackError: String(rollbackError?.message ?? rollbackError),
      failedLive: restoredLive.ok ? undefined : failedLive,
      liveRestoreError: restoredLive.ok ? undefined : restoredLive.error,
    });
    return {
      ok: false,
      phase: "double-fault",
      rolledBack: false,
      recoveryUnsafe: true,
      markerWriteFailed: !marker.written,
      error: marker.written
        ? "deferred rollback failed; recovery marker written"
        : "deferred rollback failed; recovery marker could not be written: " + marker.error,
    };
  }
}

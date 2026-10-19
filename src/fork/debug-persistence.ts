/**
 * Bounded provider debug persistence for the relay fork.
 *
 * Ownership registration is bookkeeping, never a gate. The ledger is re-read from
 * disk on every registration and fails closed (see `config-ownership.ts`), so a home
 * whose manifest outgrows the metadata read limit used to stop collecting its own
 * local capture with no way back. The root a write lands in is still refused for an
 * unsafe path state — symlinks, non-regular files, containment escapes, cleanup
 * failures, size limits — while the sibling root stays best-effort: what cannot be
 * pruned there leaves that call's budget, and a root that cannot be enumerated is
 * left out of it, instead of either one gating the capture.
 */

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getConfigDir } from "../config/paths";
import {
  recordOwnedConfigPath,
} from "../lib/config-ownership";
import type { DebugLogEntry } from "../lib/debug-log-buffer";

export const PROVIDER_DEBUG_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const PROVIDER_DEBUG_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
export const PROVIDER_DEBUG_MAX_FILES = Number.POSITIVE_INFINITY;
export const PROVIDER_DEBUG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const GROUP_DIRECTORY = "groups";
const GROUP_PREFIX = "segment-";
const GROUP_RESERVE_JOURNAL_BYTES = 1024 * 1024;
const GROUP_PENDING_MAX_AGE_MS = 5 * 60 * 1000;
const GROUP_ID = /^segment-\d{13}-[0-9a-f-]{36}$/;
const GROUP_CAPACITY_BYTES = PROVIDER_DEBUG_MAX_FILE_BYTES;

const DEBUG_ROOTS = new Set(["provider-debug", "provider-debug-artifacts"]);

type DebugFile = { path: string; bytes: number; mtimeMs: number };

export type ProviderDebugPersistenceOptions = {
  append?: boolean;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  maxAgeMs?: number;
  now?: number;
  removeFile?: (path: string) => void;
};

export type ProviderDebugCaptureGroup = {
  readonly id: string;
  readonly day: string;
  readonly hour: string;
  readonly reserveBytes: number;
  readonly lockFd: number;
  readonly lockPath: string;
  readonly journalRelativePath: string;
  readonly journalPath: string;
  readonly pendingPath: string;
  indexWritten: boolean;
  closed: boolean;
};

let activeCaptureGroup: ProviderDebugCaptureGroup | undefined;
let lastGroupCleanupAt = 0;
let cachedCaptureGroup: StoredGroup | undefined;
let unmanagedDebugStorageWarned = false;
let retentionTestLimits: { maxTotalBytes: number; maxAgeMs: number } | undefined;

function retentionLimits(): { maxTotalBytes: number; maxAgeMs: number } {
  return retentionTestLimits ?? {
    maxTotalBytes: PROVIDER_DEBUG_MAX_TOTAL_BYTES,
    maxAgeMs: PROVIDER_DEBUG_MAX_AGE_MS,
  };
}

/** Test-only deterministic retention limits; production always uses the exported constants. */
export function setProviderDebugRetentionLimitsForTests(limits?: Partial<{ maxTotalBytes: number; maxAgeMs: number }>): void {
  retentionTestLimits = limits
    ? { maxTotalBytes: limits.maxTotalBytes ?? PROVIDER_DEBUG_MAX_TOTAL_BYTES, maxAgeMs: limits.maxAgeMs ?? PROVIDER_DEBUG_MAX_AGE_MS }
    : undefined;
}

/** Test isolation for process-local capture state. */
export function resetProviderDebugPersistenceForTests(): void {
  activeCaptureGroup = undefined;
  cachedCaptureGroup = undefined;
  lastGroupCleanupAt = 0;
  unmanagedDebugStorageWarned = false;
}

function warnUnmanagedDebugStorage(): void {
  if (unmanagedDebugStorageWarned) return;
  unmanagedDebugStorageWarned = true;
  console.warn("[opencodex] provider debug storage contains an unsafe sibling that is retained outside managed cleanup capacity.");
}

export function providerDebugLogPath(): string {
  const day = new Date().toISOString().slice(0, 10);
  const hour = String(new Date().getUTCHours()).padStart(2, "0");
  const configDir = resolve(getConfigDir());
  const groupsDir = join(configDir, "provider-debug", day, hour, GROUP_DIRECTORY);
  try {
    const newest = readdirSync(groupsDir)
      .filter(name => GROUP_ID.test(name))
      .map(name => join(groupsDir, name, "provider-debug.jsonl"))
      .map(path => validatedExistingFile(validateRoot(configDir) ?? "", path))
      .filter((file): file is DebugFile => !!file)
      .sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path))[0];
    if (newest) return newest.path;
  } catch {
    /* the legacy path remains readable while no current group exists */
  }
  return join(configDir, "provider-debug", day, "provider-debug.jsonl");
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeSegments(relativePath: string): string[] | null {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\\")) return null;
  const segments = relativePath.split("/");
  if (!DEBUG_ROOTS.has(segments[0] ?? "")
    || segments.some(segment => !segment || segment === "." || segment === "..")) return null;
  return segments;
}

function validateRoot(configDir: string): string | null {
  try {
    const stat = lstatSync(configDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return realpathSync.native(configDir);
  } catch {
    return null;
  }
}

function ensureDirectories(configDir: string, rootReal: string, segments: string[]): string | null {
  let current = configDir;
  for (const segment of segments) {
    current = join(current, segment);
    registerOwnedConfigPathQuietly(configDir, current);
    if (!existsSync(current)) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch {
        return null;
      }
    }
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      if (!inside(rootReal, realpathSync.native(current))) return null;
    } catch {
      return null;
    }
  }
  return current;
}

/**
 * Register an owned path when the ledger can take it. Failure is swallowed on
 * purpose: the capture is local diagnostics, and an unreadable or oversized
 * manifest must not decide whether this home keeps logging.
 */
function registerOwnedConfigPathQuietly(configDir: string, path: string): void {
  try {
    recordOwnedConfigPath(configDir, path);
  } catch {
    /* bookkeeping only */
  }
}

function collectFiles(rootReal: string, directory: string, files: DebugFile[]): boolean {
  if (!existsSync(directory)) return true;
  let entries;
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || !inside(rootReal, realpathSync.native(directory))) return false;
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        // Group transactions own their index and references together. The compatibility writer
        // must never descend into them and delete one referenced file independently.
        if (entry.name === GROUP_DIRECTORY) continue;
        if (!collectFiles(rootReal, path, files)) return false;
        continue;
      }
      if (!stat.isFile() || !inside(rootReal, realpathSync.native(path))) return false;
      files.push({ path, bytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      return false;
    }
  }
  return true;
}

function validatedExistingFile(rootReal: string, path: string): DebugFile | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (!inside(rootReal, realpathSync.native(path))) return null;
    return { path, bytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function rotationPath(relativePath: string, now: number): string {
  const parent = dirname(relativePath).replaceAll("\\", "/");
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `${parent}/provider-debug-${stamp}-${randomUUID()}.jsonl`;
}

function latestWritableRotation(
  rootReal: string,
  parent: string,
  maxFileBytes: number,
  appendedBytes: number,
): DebugFile | null {
  try {
    const candidates = readdirSync(parent)
      .filter(name => /^provider-debug-[A-Za-z0-9-]+\.jsonl$/.test(name))
      .map(name => validatedExistingFile(rootReal, join(parent, name)))
      .filter((file): file is DebugFile => !!file && file.bytes + appendedBytes <= maxFileBytes)
      .sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist one JSONL payload under the two provider-debug roots. Any uncertain
 * link, containment, cleanup, or capacity state refuses the write; ownership
 * registration runs alongside as bookkeeping only.
 */
function writeProviderDebugFile(
  relativePath: string,
  content: string,
  options: ProviderDebugPersistenceOptions = {},
): boolean {
  const inputSegments = safeSegments(relativePath);
  if (!inputSegments) return false;
  const bytes = Buffer.byteLength(content, "utf8");
  const maxFileBytes = options.maxFileBytes ?? PROVIDER_DEBUG_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? PROVIDER_DEBUG_MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? PROVIDER_DEBUG_MAX_FILES;
  const maxAgeMs = options.maxAgeMs ?? PROVIDER_DEBUG_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const removeFile = options.removeFile ?? unlinkSync;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maxFileBytes || bytes > maxTotalBytes
    || maxFiles < 1 || maxAgeMs < 0) return false;

  const configDir = resolve(getConfigDir());
  const rootReal = validateRoot(configDir);
  if (!rootReal) return false;
  registerOwnedConfigPathQuietly(configDir, join(configDir, inputSegments[0]!));

  let segments = inputSegments;
  let parent = ensureDirectories(configDir, rootReal, segments.slice(0, -1));
  if (!parent) return false;
  let target = join(parent, segments.at(-1)!);
  const existing = existsSync(target) ? validatedExistingFile(rootReal, target) : null;
  if (existsSync(target) && !existing) return false;
  if (options.append && existing && existing.bytes + bytes > maxFileBytes) {
    const rotation = latestWritableRotation(rootReal, parent, maxFileBytes, bytes);
    if (rotation) {
      target = rotation.path;
    } else {
      segments = safeSegments(rotationPath(relativePath, now))!;
      parent = ensureDirectories(configDir, rootReal, segments.slice(0, -1));
      if (!parent) return false;
      target = join(parent, segments.at(-1)!);
    }
  }
  registerOwnedConfigPathQuietly(configDir, target);
  if (existsSync(target) && !validatedExistingFile(rootReal, target)) return false;

  const targetRoot = join(configDir, inputSegments[0]!);
  const files: DebugFile[] = [];
  for (const debugRoot of DEBUG_ROOTS) {
    const rootFiles: DebugFile[] = [];
    if (!collectFiles(rootReal, join(configDir, debugRoot), rootFiles)) {
      if (join(configDir, debugRoot) === targetRoot) return false;
      continue;
    }
    files.push(...rootFiles);
  }
  files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  const targetExisting = files.find(file => file.path === target);
  let totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  let fileCount = files.length;

  const remove = (file: DebugFile): boolean => {
    try {
      const current = validatedExistingFile(rootReal, file.path);
      if (!current || current.bytes !== file.bytes || statSync(file.path).mtimeMs !== file.mtimeMs) return false;
      removeFile(file.path);
      totalBytes -= file.bytes;
      fileCount -= 1;
      return true;
    } catch {
      return false;
    }
  };

  const droppedFromBudget = new Set<string>();
  /**
   * Stop counting an entry this call could not verify or delete, without touching it.
   * Idempotent per path: the age pass and the capacity pass can both reach the same
   * undeletable sibling entry, and it must only leave the budget once.
   */
  const dropFromBudget = (file: DebugFile): void => {
    if (droppedFromBudget.has(file.path)) return;
    droppedFromBudget.add(file.path);
    totalBytes -= file.bytes;
    fileCount -= 1;
  };

  /**
   * `refused` keeps the fail-closed contract for the root being written; `skipped`
   * covers the sibling root, where a foreign entry must not become a write gate.
   */
  const prune = (file: DebugFile): "removed" | "skipped" | "refused" => {
    if (remove(file)) return "removed";
    return inside(targetRoot, file.path) ? "refused" : "skipped";
  };

  for (const file of files) {
    if (file.path === target || now - file.mtimeMs <= maxAgeMs) continue;
    const outcome = prune(file);
    if (outcome === "refused") return false;
    if (outcome === "skipped") dropFromBudget(file);
  }

  const activeFiles = files.filter(file => existsSync(file.path));
  let index = 0;
  while (totalBytes + bytes > maxTotalBytes || fileCount + (targetExisting ? 0 : 1) > maxFiles) {
    const candidate = activeFiles.slice(index).find(file => file.path !== target && existsSync(file.path));
    if (!candidate) return false;
    index = activeFiles.indexOf(candidate) + 1;
    const outcome = prune(candidate);
    if (outcome === "refused") return false;
    if (outcome === "skipped") dropFromBudget(candidate);
  }

  const parentReal = validateRoot(parent);
  if (!parentReal || !inside(rootReal, parentReal)) return false;
  const noFollow = (constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const targetExists = existsSync(target);
  if (targetExists && (!options.append || !validatedExistingFile(rootReal, target))) return false;
  const flags = constants.O_WRONLY
    | noFollow
    | (options.append ? constants.O_APPEND : 0)
    | (targetExists ? 0 : constants.O_CREAT | constants.O_EXCL);
  let fd: number | undefined;
  const created = !targetExists;
  try {
    fd = openSync(target, flags, 0o600);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size + bytes > maxFileBytes) throw new Error("unsafe debug file");
    fchmodSync(fd, 0o600);
    const buffer = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
    return true;
  } catch {
    if (created) {
      try { unlinkSync(target); } catch { /* best-effort cleanup */ }
    }
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort close */ }
    }
  }
}

function groupDirectory(configDir: string, day: string, hour: string, id: string): string {
  return join(configDir, "provider-debug", day, hour, GROUP_DIRECTORY, id);
}

function artifactGroupDirectory(configDir: string, day: string, hour: string, id: string): string {
  return join(configDir, "provider-debug-artifacts", day, hour, GROUP_DIRECTORY, id);
}

function groupBytes(rootReal: string, directory: string): number | null {
  const files: DebugFile[] = [];
  return collectFiles(rootReal, directory, files) ? files.reduce((total, file) => total + file.bytes, 0) : null;
}

type StoredGroup = {
  id: string;
  day: string;
  hour: string;
  journalPath: string;
  groupDirectory: string;
  artifactDirectory: string;
  bytes: number;
  mtimeMs: number;
  pending: boolean;
  sealed: boolean;
  legacyIndexes?: string[];
  legacyFiles?: string[];
};

function reservedGroupBytes(group: StoredGroup): number {
  return group.legacyIndexes ? group.bytes : Math.max(group.bytes, GROUP_CAPACITY_BYTES);
}

function collectStoredGroups(configDir: string, rootReal: string): StoredGroup[] | null {
  const base = join(configDir, "provider-debug");
  const groups: StoredGroup[] = [];
  const artifactBase = join(configDir, "provider-debug-artifacts");
  const listDays = (directory: string, sibling: boolean): string[] | null => {
    try { return readdirSync(directory).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)); }
    catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      if (sibling) { warnUnmanagedDebugStorage(); return []; }
      return null;
    }
  };
  const mainDays = listDays(base, false);
  const artifactDays = listDays(artifactBase, true);
  if (!mainDays || !artifactDays) return null;
  const days = [...new Set([...mainDays, ...artifactDays])];
  for (const day of days.filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))) {
    const dayDir = join(base, day);
    const legacyFiles: DebugFile[] = [];
    const legacyArtifacts = join(configDir, "provider-debug-artifacts", day);
    const legacyArtifactsSafe = collectFiles(rootReal, legacyArtifacts, legacyFiles);
    if (!collectFiles(rootReal, dayDir, legacyFiles)) return null;
    if (!legacyArtifactsSafe) {
      warnUnmanagedDebugStorage();
      legacyFiles.length = 0;
      collectFiles(rootReal, dayDir, legacyFiles);
    }
    if (legacyFiles.length > 0) {
      const relevant = legacyFiles.filter(file => !file.path.includes(`${sep}${GROUP_DIRECTORY}${sep}`));
      if (relevant.length > 0) {
        const legacyIndexes = relevant.filter(file => /^provider-debug(?:-[A-Za-z0-9-]+)?\.jsonl$/.test(file.path.split(sep).at(-1) ?? ""));
        groups.push({
          id: `legacy:${day}`,
          day,
          hour: "legacy",
          journalPath: legacyIndexes[0]?.path ?? join(dayDir, "provider-debug.jsonl"),
          groupDirectory: dayDir,
          artifactDirectory: legacyArtifacts,
          bytes: relevant.reduce((sum, file) => sum + file.bytes, 0),
          mtimeMs: Math.min(...relevant.map(file => file.mtimeMs)),
          pending: false,
          sealed: false,
          legacyIndexes: legacyIndexes.map(file => file.path),
          legacyFiles: relevant.map(file => file.path),
        });
      }
    }
    const artifactDayDir = join(artifactBase, day);
    const listHours = (directory: string, sibling: boolean): string[] | null => {
      try { return readdirSync(directory).filter(name => /^\d{2}$/.test(name)); }
      catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return [];
        if (sibling) { warnUnmanagedDebugStorage(); return []; }
        return null;
      }
    };
    const mainHours = listHours(dayDir, false);
    const artifactHours = listHours(artifactDayDir, true);
    if (!mainHours || !artifactHours) return null;
    for (const hour of new Set([...mainHours, ...artifactHours])) {
      const groupsDir = join(dayDir, hour, GROUP_DIRECTORY);
      const artifactGroupsDir = join(artifactDayDir, hour, GROUP_DIRECTORY);
      const listIds = (directory: string, sibling: boolean): string[] | null => {
        try { return readdirSync(directory).filter(name => GROUP_ID.test(name)); }
        catch (error) {
          if ((error as { code?: string }).code === "ENOENT") return [];
          if (sibling) { warnUnmanagedDebugStorage(); return []; }
          return null;
        }
      };
      const mainIds = listIds(groupsDir, true);
      const artifactIds = listIds(artifactGroupsDir, true);
      if (!mainIds || !artifactIds) return null;
      for (const id of new Set([...mainIds, ...artifactIds])) {
        const directory = groupDirectory(configDir, day, hour, id);
        const journalPath = join(directory, "provider-debug.jsonl");
        const journal = validatedExistingFile(rootReal, journalPath);
        const pendingPath = join(directory, ".pending");
        const pending = existsSync(pendingPath);
        const sealed = existsSync(join(directory, ".sealed"));
        const mainBytes = groupBytes(rootReal, directory);
        const artifactBytes = groupBytes(rootReal, artifactGroupDirectory(configDir, day, hour, id));
        if (mainBytes === null) return null;
        if (artifactBytes === null) {
          warnUnmanagedDebugStorage();
          continue;
        }
        if (!journal && !pending && mainBytes + artifactBytes === 0) continue;
        let marker = pending ? validatedExistingFile(rootReal, pendingPath) : journal;
        if (!marker) {
          try {
            const markerPath = existsSync(directory)
              ? directory
              : artifactGroupDirectory(configDir, day, hour, id);
            const stat = lstatSync(markerPath);
            if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
            const files: DebugFile[] = [];
            if (!collectFiles(rootReal, markerPath, files)) return null;
            marker = {
              path: markerPath,
              bytes: 0,
              mtimeMs: files.length > 0 ? Math.min(...files.map(file => file.mtimeMs)) : stat.mtimeMs,
            };
          } catch { return null; }
        }
        groups.push({
          id,
          day,
          hour,
          journalPath,
          groupDirectory: directory,
          artifactDirectory: artifactGroupDirectory(configDir, day, hour, id),
          bytes: mainBytes + artifactBytes,
          mtimeMs: marker?.mtimeMs ?? 0,
          pending,
          sealed,
        });
      }
    }
  }
  return groups;
}

function removeStoredGroup(rootReal: string, group: StoredGroup): boolean {
  if (group.legacyIndexes) {
    for (const path of group.legacyIndexes) {
      if (!validatedExistingFile(rootReal, path)) return false;
      try { unlinkSync(path); } catch { return false; }
    }
    try {
      for (const path of group.legacyFiles ?? []) {
        if (group.legacyIndexes.includes(path)) continue;
        if (validatedExistingFile(rootReal, path)) unlinkSync(path);
      }
    } catch { return false; }
    return true;
  }
  const journal = validatedExistingFile(rootReal, group.journalPath);
  if (journal) {
    try { unlinkSync(group.journalPath); } catch { return false; }
  } else if (group.pending) {
    return false;
  }
  try { rmSync(group.groupDirectory, { recursive: true, force: true }); } catch { return false; }
  try { rmSync(group.artifactDirectory, { recursive: true, force: true }); } catch { return false; }
  if (cachedCaptureGroup?.id === group.id) cachedCaptureGroup = undefined;
  return true;
}

function pruneStoredGroups(
  configDir: string,
  rootReal: string,
  now: number,
  reserveBytes: number,
  protectedId?: string,
): boolean {
  const limits = retentionLimits();
  const groups = collectStoredGroups(configDir, rootReal);
  if (!groups) return false;
  let total = groups.reduce((sum, group) => sum + reservedGroupBytes(group), 0);
  const expired = groups
    .filter(group => group.id !== protectedId && !group.pending && now - group.mtimeMs > limits.maxAgeMs)
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.id.localeCompare(right.id));
  for (const group of expired) {
    if (!removeStoredGroup(rootReal, group)) return false;
    total -= reservedGroupBytes(group);
  }
  const stalePending = groups
    .filter(group => group.id !== protectedId && group.pending && now - group.mtimeMs > GROUP_PENDING_MAX_AGE_MS)
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.id.localeCompare(right.id));
  for (const group of stalePending) {
    // The root lock lets recovery distinguish an unfinished write from a complete journal;
    // a complete journal is retained after its partial tail is repaired.
    if (validatedExistingFile(rootReal, group.journalPath)) {
      if (!repairPendingJournalTail(group.journalPath)) return false;
      try { renameSync(join(group.groupDirectory, ".pending"), join(group.groupDirectory, ".sealed")); } catch { return false; }
      group.pending = false;
      group.sealed = true;
      if (now - group.mtimeMs > limits.maxAgeMs) {
        if (!removeStoredGroup(rootReal, group)) return false;
        total -= reservedGroupBytes(group);
      }
    } else {
      try { rmSync(group.groupDirectory, { recursive: true, force: true }); } catch { return false; }
      try { rmSync(group.artifactDirectory, { recursive: true, force: true }); } catch { return false; }
      total -= reservedGroupBytes(group);
    }
  }
  const candidates = groups
    .filter(group => group.id !== protectedId && !group.pending && now - group.mtimeMs <= limits.maxAgeMs)
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.id.localeCompare(right.id));
  const forceOneCapacityEviction = total + reserveBytes >= limits.maxTotalBytes;
  for (const group of candidates) {
    if (!forceOneCapacityEviction && total + reserveBytes <= limits.maxTotalBytes) break;
    if (forceOneCapacityEviction && total + reserveBytes <= limits.maxTotalBytes && total < limits.maxTotalBytes) break;
    if (!removeStoredGroup(rootReal, group)) continue;
    total -= reservedGroupBytes(group);
  }
  return total + reserveBytes <= limits.maxTotalBytes;
}

function acquireCaptureLock(configDir: string): number | null {
  const lock = join(configDir, ".provider-debug-capture.lock");
  const openLock = (): number | null => {
    let fd: number | undefined;
    try {
      fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeSync(fd, Buffer.from(JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8"));
      return fd;
    } catch {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best-effort close */ }
        try { unlinkSync(lock); } catch { /* only the just-created lock is removed */ }
      }
      return null;
    }
  };
  let fd = openLock();
  if (fd !== null) return fd;
  try {
    let owner: { pid?: unknown } | undefined;
    try { owner = JSON.parse(readFileSync(lock, "utf8")) as { pid?: unknown }; } catch { owner = undefined; }
    if (typeof owner?.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return null;
      } catch { /* a dead owner can be recovered after the stale interval */ }
    }
    if (Date.now() - lstatSync(lock).mtimeMs > GROUP_PENDING_MAX_AGE_MS) unlinkSync(lock);
  } catch { return null; }
  fd = openLock();
  return fd;
}

function releaseCaptureLock(group: ProviderDebugCaptureGroup): void {
  try { closeSync(group.lockFd); } catch { /* best-effort close */ }
  try { unlinkSync(group.lockPath); } catch { /* best-effort release */ }
}

function repairPendingJournalTail(path: string): boolean {
  try {
    const content = readFileSync(path);
    const end = content.lastIndexOf(0x0a);
    if (end === content.length - 1) return true;
    if (end < 0) {
      truncateSync(path, 0);
      return true;
    }
    truncateSync(path, end + 1);
    return true;
  } catch {
    return false;
  }
}

export function beginProviderDebugCaptureGroup(reserveBytes: number): ProviderDebugCaptureGroup | undefined {
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0 || reserveBytes > PROVIDER_DEBUG_MAX_FILE_BYTES) return undefined;
  if (activeCaptureGroup) return undefined;
  const configDir = resolve(getConfigDir());
  const rootReal = validateRoot(configDir);
  if (!rootReal) return undefined;
  const lockFd = acquireCaptureLock(configDir);
  if (lockFd === null) return undefined;
  const now = Date.now();
  const date = new Date(now);
  const day = date.toISOString().slice(0, 10);
  const hour = String(date.getUTCHours()).padStart(2, "0");
  try {
    const needed = GROUP_CAPACITY_BYTES;
    let reusable: StoredGroup | undefined;
    if (cachedCaptureGroup?.day === day && cachedCaptureGroup.hour === hour && !cachedCaptureGroup.pending && !cachedCaptureGroup.sealed) {
      const journal = validatedExistingFile(rootReal, cachedCaptureGroup.journalPath);
      const mainBytes = groupBytes(rootReal, cachedCaptureGroup.groupDirectory);
      const artifactBytes = groupBytes(rootReal, cachedCaptureGroup.artifactDirectory);
      if (journal && mainBytes !== null && artifactBytes !== null
        && mainBytes + artifactBytes + reserveBytes + GROUP_RESERVE_JOURNAL_BYTES <= GROUP_CAPACITY_BYTES
        && journal.bytes + GROUP_RESERVE_JOURNAL_BYTES <= PROVIDER_DEBUG_MAX_FILE_BYTES) {
        reusable = { ...cachedCaptureGroup, bytes: mainBytes + artifactBytes, mtimeMs: journal.mtimeMs };
      } else cachedCaptureGroup = undefined;
    }
    if (!reusable || now - lastGroupCleanupAt > 60 * 60 * 1000) {
      if (!pruneStoredGroups(configDir, rootReal, now, needed, reusable?.id)) throw new Error("debug capacity unavailable");
      lastGroupCleanupAt = now;
    }
    if (!reusable) {
      const groups = collectStoredGroups(configDir, rootReal);
      if (!groups) throw new Error("unsafe debug group inventory");
      reusable = groups
        .filter(group => group.day === day && group.hour === hour && !group.pending && !group.sealed)
        .filter(group => group.bytes + reserveBytes + GROUP_RESERVE_JOURNAL_BYTES <= GROUP_CAPACITY_BYTES)
        .filter(group => (validatedExistingFile(rootReal, group.journalPath)?.bytes ?? 0) + GROUP_RESERVE_JOURNAL_BYTES <= PROVIDER_DEBUG_MAX_FILE_BYTES)
        .sort((left, right) => right.mtimeMs - left.mtimeMs || right.id.localeCompare(left.id))[0];
    }
    const id = reusable?.id ?? `${GROUP_PREFIX}${now}-${randomUUID()}`;
    const directory = groupDirectory(configDir, day, hour, id);
    const parent = ensureDirectories(configDir, rootReal, relative(configDir, directory).split(sep));
    if (!parent) throw new Error("unsafe group directory");
    const pendingPath = join(directory, ".pending");
    if (existsSync(pendingPath)) {
      const pendingAge = now - lstatSync(pendingPath).mtimeMs;
      if (pendingAge <= GROUP_PENDING_MAX_AGE_MS) throw new Error("debug group is still pending");
      const priorJournal = join(directory, "provider-debug.jsonl");
      if (validatedExistingFile(rootReal, priorJournal)) {
        if (!repairPendingJournalTail(priorJournal)) throw new Error("unsafe pending journal tail");
        unlinkSync(pendingPath);
      }
      else {
        rmSync(directory, { recursive: true, force: true });
        rmSync(artifactGroupDirectory(configDir, day, hour, id), { recursive: true, force: true });
        if (!ensureDirectories(configDir, rootReal, relative(configDir, directory).split(sep))) {
          throw new Error("unsafe recovered group directory");
        }
      }
    }
    const pendingFd = openSync(pendingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    closeSync(pendingFd);
    const journalPath = join(directory, "provider-debug.jsonl");
    const group: ProviderDebugCaptureGroup = {
      id, day, hour, reserveBytes, lockFd,
      lockPath: join(configDir, ".provider-debug-capture.lock"),
      journalRelativePath: relative(configDir, journalPath).split(sep).join("/"),
      journalPath, pendingPath, indexWritten: false, closed: false,
    };
    cachedCaptureGroup = {
      id, day, hour, journalPath, groupDirectory: directory,
      artifactDirectory: artifactGroupDirectory(configDir, day, hour, id),
      bytes: reusable?.bytes ?? 0, mtimeMs: now, pending: false, sealed: false,
    };
    activeCaptureGroup = group;
    return group;
  } catch {
    try { closeSync(lockFd); } catch { /* best-effort close */ }
    try { unlinkSync(join(configDir, ".provider-debug-capture.lock")); } catch { /* best-effort release */ }
    return undefined;
  }
}

function writeGroupFile(group: ProviderDebugCaptureGroup, relativePath: string, content: string): boolean {
  if (activeCaptureGroup !== group || group.closed || !content) return false;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= 0 || bytes > PROVIDER_DEBUG_MAX_FILE_BYTES) return false;
  const configDir = resolve(getConfigDir());
  const rootReal = validateRoot(configDir);
  const segments = safeSegments(relativePath);
  if (!rootReal || !segments) return false;
  const mainBytes = groupBytes(rootReal, groupDirectory(configDir, group.day, group.hour, group.id));
  const artifactBytes = groupBytes(rootReal, artifactGroupDirectory(configDir, group.day, group.hour, group.id));
  if (mainBytes === null || artifactBytes === null || mainBytes + artifactBytes + bytes > GROUP_CAPACITY_BYTES) return false;
  const parent = ensureDirectories(configDir, rootReal, segments.slice(0, -1));
  if (!parent) return false;
  const target = join(parent, segments.at(-1)!);
  if (existsSync(target)) return false;
  let fd: number | undefined;
  try {
    const noFollow = (constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    const buffer = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
    fchmodSync(fd, 0o600);
    return true;
  } catch {
    try { if (fd === undefined) unlinkSync(target); } catch { /* best-effort cleanup */ }
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best-effort close */ }
  }
}

export function persistProviderDebugCaptureArtifact(
  group: ProviderDebugCaptureGroup,
  kind: "artifact" | "timeline",
  content: string,
): string | undefined {
  const root = kind === "artifact"
    ? join("provider-debug-artifacts", group.day, group.hour, GROUP_DIRECTORY, group.id)
    : join("provider-debug", group.day, group.hour, GROUP_DIRECTORY, group.id, "timelines");
  const file = kind === "artifact"
    ? `${Date.now()}-${randomUUID()}.jsonl`
    : `timeline-${Date.now()}-${randomUUID()}.jsonl`;
  const relativePath = join(root, file).split(sep).join("/");
  return writeGroupFile(group, relativePath, content) ? relativePath : undefined;
}

export function completeProviderDebugCaptureGroup(group: ProviderDebugCaptureGroup): boolean {
  if (activeCaptureGroup !== group || group.closed) return false;
  try {
    if (!group.indexWritten) {
      cachedCaptureGroup = undefined;
      if (validatedExistingFile(validateRoot(resolve(getConfigDir())) ?? "", group.journalPath)
        && repairPendingJournalTail(group.journalPath)) {
        try { unlinkSync(group.pendingPath); } catch { /* stale recovery retains the marker */ }
      }
      return false;
    }
    unlinkSync(group.pendingPath);
    return true;
  } catch {
    cachedCaptureGroup = undefined;
    return false;
  } finally {
    group.closed = true;
    activeCaptureGroup = undefined;
    releaseCaptureLock(group);
  }
}

export function abandonProviderDebugCaptureGroup(group: ProviderDebugCaptureGroup): void {
  if (activeCaptureGroup === group) activeCaptureGroup = undefined;
  if (group.closed) return;
  group.closed = true;
  try { unlinkSync(group.pendingPath); } catch { /* a stale marker is recovered under the next root lock */ }
  releaseCaptureLock(group);
}

function appendGroupJournal(group: ProviderDebugCaptureGroup, content: string): boolean {
  if (activeCaptureGroup !== group || group.closed) return false;
  const bytes = Buffer.byteLength(content, "utf8");
  const configDir = resolve(getConfigDir());
  const rootReal = validateRoot(configDir);
  if (!rootReal || bytes <= 0) return false;
  const mainBytes = groupBytes(rootReal, groupDirectory(configDir, group.day, group.hour, group.id));
  const artifactBytes = groupBytes(rootReal, artifactGroupDirectory(configDir, group.day, group.hour, group.id));
  if (mainBytes === null || artifactBytes === null || mainBytes + artifactBytes + bytes > GROUP_CAPACITY_BYTES) return false;
  const existing = existsSync(group.journalPath) ? validatedExistingFile(rootReal, group.journalPath) : undefined;
  if (existsSync(group.journalPath) && !existing) return false;
  if ((existing?.bytes ?? 0) + bytes > PROVIDER_DEBUG_MAX_FILE_BYTES) return false;
  let fd: number | undefined;
  const created = !existing;
  const initialBytes = existing?.bytes ?? 0;
  try {
    const noFollow = (constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    fd = openSync(
      group.journalPath,
      constants.O_WRONLY | constants.O_APPEND | noFollow | (created ? constants.O_CREAT | constants.O_EXCL : 0),
      0o600,
    );
    const buffer = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
    fchmodSync(fd, 0o600);
    return true;
  } catch {
    if (created) try { unlinkSync(group.journalPath); } catch { /* best-effort cleanup */ }
    else try { truncateSync(group.journalPath, initialBytes); } catch { /* stale pending preserves recovery */ }
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best-effort close */ }
  }
}

let refusedWriteWarned = false;

/**
 * Callers swallow the boolean, so a home whose capture path is unusable collects
 * nothing and reports nothing. One line per process keeps that visible without
 * touching the request path: the message names the root and the class of obstacle
 * an operator can act on, and the first refusal is the only one they ever see.
 */
function warnRefusedWrite(relativePath: string): void {
  if (refusedWriteWarned) return;
  refusedWriteWarned = true;
  const root = relativePath.split("/")[0] ?? relativePath;
  console.warn(
    `[opencodex] provider debug capture is not being written: ${relativePath} was refused; `
    + `the ${root} root under ${getConfigDir()} needs real directories, `
    + `regular files, and room under the capture size limits.`,
  );
}

/** Test isolation: the refusal notice is process-wide. */
export function resetProviderDebugWarningForTests(): void {
  refusedWriteWarned = false;
}

export function persistProviderDebugFile(
  relativePath: string,
  content: string,
  options: ProviderDebugPersistenceOptions = {},
): boolean {
  let written = false;
  try {
    written = writeProviderDebugFile(relativePath, content, options);
  } catch {
    // A full disk, an unwritable path, or an fs race can throw where the writer
    // used to return false; that has to stay inside the boolean contract because
    // these callers sit on the response path.
    written = false;
  }
  if (!written) warnRefusedWrite(relativePath);
  return written;
}

export function persistDebugEntry(entry: DebugLogEntry): void {
  try {
    if (activeCaptureGroup) {
      activeCaptureGroup.indexWritten = appendGroupJournal(activeCaptureGroup, `${JSON.stringify(entry)}\n`);
      return;
    }
    const line = `${JSON.stringify(entry)}\n`;
    const group = beginProviderDebugCaptureGroup(Buffer.byteLength(line, "utf8"));
    if (!group) {
      warnRefusedWrite("provider-debug");
      return;
    }
    try {
      group.indexWritten = appendGroupJournal(group, line);
    } finally {
      completeProviderDebugCaptureGroup(group);
    }
  } catch {
    /* durable diagnostics must never affect request handling */
  }
}

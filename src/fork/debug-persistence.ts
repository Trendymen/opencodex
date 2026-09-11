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
  realpathSync,
  statSync,
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
export const PROVIDER_DEBUG_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const PROVIDER_DEBUG_MAX_FILES = 256;
export const PROVIDER_DEBUG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

export function providerDebugLogPath(): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(getConfigDir(), "provider-debug", day, "provider-debug.jsonl");
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
    segments = safeSegments(rotationPath(relativePath, now))!;
    parent = ensureDirectories(configDir, rootReal, segments.slice(0, -1));
    if (!parent) return false;
    target = join(parent, segments.at(-1)!);
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
    const path = providerDebugLogPath();
    const rel = relative(getConfigDir(), path).split(sep).join("/");
    persistProviderDebugFile(rel, `${JSON.stringify(entry)}\n`, { append: true });
  } catch {
    /* durable diagnostics must never affect request handling */
  }
}

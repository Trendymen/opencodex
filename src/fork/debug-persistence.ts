/** Bounded, ownership-checked provider debug persistence for the relay fork. */

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
import { recordOwnedConfigPath } from "../lib/config-ownership";
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
    if (!recordOwnedConfigPath(configDir, current)) return null;
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
 * ownership, link, containment, cleanup, or capacity state refuses the write.
 */
export function persistProviderDebugFile(
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
  if (!recordOwnedConfigPath(configDir, join(configDir, inputSegments[0]!))) return false;
  const rootReal = validateRoot(configDir);
  if (!rootReal) return false;

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
  if (!recordOwnedConfigPath(configDir, target)) return false;
  if (existsSync(target) && !validatedExistingFile(rootReal, target)) return false;

  const files: DebugFile[] = [];
  for (const debugRoot of DEBUG_ROOTS) {
    if (!collectFiles(rootReal, join(configDir, debugRoot), files)) return false;
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

  for (const file of files) {
    if (file.path === target || now - file.mtimeMs <= maxAgeMs) continue;
    if (!remove(file)) return false;
  }

  const activeFiles = files.filter(file => existsSync(file.path));
  let index = 0;
  while (totalBytes + bytes > maxTotalBytes || fileCount + (targetExisting ? 0 : 1) > maxFiles) {
    const candidate = activeFiles.slice(index).find(file => file.path !== target && existsSync(file.path));
    if (!candidate || !remove(candidate)) return false;
    index = activeFiles.indexOf(candidate) + 1;
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

export function persistDebugEntry(entry: DebugLogEntry): void {
  try {
    const path = providerDebugLogPath();
    const rel = relative(getConfigDir(), path).split(sep).join("/");
    persistProviderDebugFile(rel, `${JSON.stringify(entry)}\n`, { append: true });
  } catch {
    /* durable diagnostics must never affect request handling */
  }
}

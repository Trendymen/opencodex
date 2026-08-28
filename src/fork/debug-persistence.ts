/** Durable provider debug log persistence (relay fork): append + bounded rotation. */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import type { DebugLogEntry } from "../lib/debug-log-buffer";

const MAX_PERSISTED_DEBUG_BYTES = 4 * 1024 * 1024;
const KEEP_PERSISTED_DEBUG_LINES = 1_000;

export function providerDebugLogPath(): string {
  return join(getConfigDir(), "provider-debug.jsonl");
}

export function persistDebugEntry(entry: DebugLogEntry): void {
  try {
    const dir = getConfigDir();
    const path = providerDebugLogPath();
    recordOwnedConfigPath(dir, path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    if (!existsSync(path) || statSync(path).size <= MAX_PERSISTED_DEBUG_BYTES) return;
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    const kept: string[] = [];
    let keptBytes = 0;
    for (let index = lines.length - 1; index >= 0 && kept.length < KEEP_PERSISTED_DEBUG_LINES; index--) {
      const line = lines[index]!;
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (keptBytes + bytes > MAX_PERSISTED_DEBUG_BYTES) break;
      kept.push(line);
      keptBytes += bytes;
    }
    kept.reverse();
    const temporary = `${path}.rotate-${process.pid}-${randomUUID()}`;
    writeFileSync(temporary, kept.length > 0 ? `${kept.join("\n")}\n` : "", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try { chmodSync(temporary, 0o600); } catch { /* best-effort */ }
    renameSync(temporary, path);
  } catch {
    /* durable diagnostics must never affect request handling */
  }
}

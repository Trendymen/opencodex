/** Durable provider debug log persistence (relay fork): append-only operator evidence.
 *
 * Entries are partitioned by UTC date so a long-running debug log never grows into a single
 * oversized file; the legacy top-level provider-debug.jsonl remains untouched for history.
 */

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { getConfigDir } from "../config/paths";
import { join } from "node:path";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import type { DebugLogEntry } from "../lib/debug-log-buffer";

export function providerDebugLogPath(): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(getConfigDir(), "provider-debug", day, "provider-debug.jsonl");
}

export function persistDebugEntry(entry: DebugLogEntry): void {
  try {
    const dir = getConfigDir();
    const path = providerDebugLogPath();
    const dayDir = dirname(path);
    recordOwnedConfigPath(dir, dayDir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  } catch {
    /* durable diagnostics must never affect request handling */
  }
}

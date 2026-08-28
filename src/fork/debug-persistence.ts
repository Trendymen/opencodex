/** Durable provider debug log persistence (relay fork): append-only operator evidence. */

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import type { DebugLogEntry } from "../lib/debug-log-buffer";

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
  } catch {
    /* durable diagnostics must never affect request handling */
  }
}

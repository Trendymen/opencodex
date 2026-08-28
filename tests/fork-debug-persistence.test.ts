import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDebugLogLine, getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { providerDebugLogPath } from "../src/fork/debug-persistence";

let previousHome: string | undefined;
let testDir = "";

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-fork-debug-persist-"));
  process.env.OPENCODEX_HOME = testDir;
  resetDebugLogBufferForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  resetDebugLogBufferForTests();
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("fork provider debug persistence", () => {
  test("appendDebugLogLine persists each entry as a JSONL line", () => {
    appendDebugLogLine("fork-persist-probe-1");
    appendDebugLogLine("fork-persist-probe-2");
    const lines = readFileSync(providerDebugLogPath(), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]!) as { seq: number; at: number; line: string };
    const second = JSON.parse(lines[1]!) as { seq: number; at: number; line: string };
    expect(first.line).toBe("fork-persist-probe-1");
    expect(second.line).toBe("fork-persist-probe-2");
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  test("persistence failure never breaks in-memory logging", () => {
    // A regular file occupying the config dir path makes mkdir/append fail.
    rmSync(testDir, { recursive: true, force: true });
    writeFileSync(testDir, "not-a-directory");
    expect(() => appendDebugLogLine("fork-persist-resilient")).not.toThrow();
    const entries = getDebugLogEntries();
    expect(entries.at(-1)?.line).toBe("fork-persist-resilient");
  });

  test("append-only persistence keeps existing lines after the former 4 MiB threshold", () => {
    // Pre-seed just over the former rotation threshold. Provider debug is operator evidence
    // and now remains append-only until the operator clears or archives the file.
    const seedLine = JSON.stringify({ seq: 0, at: 0, line: "x".repeat(4096) });
    const seeded = Array.from({ length: 1100 }, () => seedLine).join("\n") + "\n";
    writeFileSync(providerDebugLogPath(), seeded, { mode: 0o600 });
    appendDebugLogLine("fork-persist-after-threshold");
    const appended = readFileSync(providerDebugLogPath(), "utf8");
    const lines = appended.trim().split("\n");
    expect(lines.length).toBe(1101);
    expect(lines[0]).toBe(seedLine);
    expect(statSync(providerDebugLogPath()).size).toBeGreaterThan(4 * 1024 * 1024);
    expect(lines.at(-1)).toContain("fork-persist-after-threshold");
  });
});

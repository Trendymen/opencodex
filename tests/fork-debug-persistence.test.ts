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

  test("rotation keeps the file within the byte and line budget", () => {
    // Pre-seed just over the 4 MiB cap so the next append triggers rotation.
    const seedLine = JSON.stringify({ seq: 0, at: 0, line: "x".repeat(4096) });
    const seeded = Array.from({ length: 1100 }, () => seedLine).join("\n") + "\n";
    writeFileSync(providerDebugLogPath(), seeded, { mode: 0o600 });
    appendDebugLogLine("fork-persist-after-rotation");
    const rotated = readFileSync(providerDebugLogPath(), "utf8");
    const lines = rotated.trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(1001);
    expect(statSync(providerDebugLogPath()).size).toBeLessThanOrEqual(4 * 1024 * 1024 + 4096);
    expect(lines.at(-1)).toContain("fork-persist-after-rotation");
  });
});

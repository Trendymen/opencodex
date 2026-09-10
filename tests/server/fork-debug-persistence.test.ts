import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendDebugLogLine, getDebugLogEntries, resetDebugLogBufferForTests } from "../../src/lib/debug-log-buffer";
import {
  persistProviderDebugFile,
  providerDebugLogPath,
  resetProviderDebugWarningForTests,
} from "../../src/fork/debug-persistence";
import { removeOwnedConfigState } from "../../src/lib/config-ownership";

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

  test("refuses an adopted existing debug directory without touching its sentinel", () => {
    writeFileSync(join(testDir, "runtime-port.json"), "{\"port\":10100}\n");
    const debugDir = join(testDir, "provider-debug");
    mkdirSync(debugDir);
    const sentinel = join(debugDir, "keep.txt");
    writeFileSync(sentinel, "keep\n");

    appendDebugLogLine("must-not-adopt-debug-directory");

    expect(readFileSync(sentinel, "utf8")).toBe("keep\n");
    expect(existsSync(providerDebugLogPath())).toBe(false);
    expect(removeOwnedConfigState(testDir).status).toBe("partial");
    expect(readFileSync(sentinel, "utf8")).toBe("keep\n");
  });

  test("does not rotate an unowned adopted sibling debug root", () => {
    writeFileSync(join(testDir, "runtime-port.json"), "{\"port\":10100}\n");
    const artifactDir = join(testDir, "provider-debug-artifacts");
    mkdirSync(artifactDir);
    const sentinel = join(artifactDir, "sentinel.jsonl");
    writeFileSync(sentinel, "keep\n");

    expect(persistProviderDebugFile("provider-debug/current.jsonl", "new\n", { maxFiles: 1 })).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("keep\n");
  });

  test("a refused capture warns once per process instead of failing silently", () => {
    // Same refusal as above, but the operator must be able to see it: a refused write
    // used to leave no trace anywhere, which is how a legacy home collected nothing
    // for six days.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      resetProviderDebugWarningForTests();
      rmSync(testDir, { recursive: true, force: true });
      writeFileSync(testDir, "not-a-directory");

      appendDebugLogLine("fork-persist-warned-1");
      const firstRefusalCalls = warn.mock.calls.length;
      expect(firstRefusalCalls).toBeGreaterThan(0);
      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain("not being written");
      expect(message).toContain("provider-debug");

      appendDebugLogLine("fork-persist-warned-2");
      expect(warn.mock.calls.length).toBe(firstRefusalCalls);
    } finally {
      warn.mockRestore();
      resetProviderDebugWarningForTests();
    }
  });

  test("persistence rolls over after 4 MiB without truncating existing JSONL records", () => {
    appendDebugLogLine("ownership-seed");
    const seedLine = JSON.stringify({ seq: 0, at: 0, line: "x".repeat(4096) });
    const seeded = Array.from({ length: 1100 }, () => seedLine).join("\n") + "\n";
    const target = providerDebugLogPath();
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, seeded, { mode: 0o600 });
    appendDebugLogLine("fork-persist-after-threshold");
    expect(readFileSync(target, "utf8")).toBe(seeded);
    expect(statSync(target).size).toBeGreaterThan(4 * 1024 * 1024);
    const siblings = readdirSync(dirname(target)).filter(name => name.endsWith(".jsonl"));
    expect(siblings.length).toBeGreaterThan(1);
    expect(siblings.some(name => readFileSync(join(dirname(target), name), "utf8")
      .includes("fork-persist-after-threshold"))).toBe(true);
  });
});

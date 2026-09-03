import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { STORE_BUDGET_MS } from "./helpers/test-budget";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageEntry,
  currentUsageLogRevision,
  normalizeUsageEntryForTest,
  readRecentUsageEntries,
  readUsageEntries,
  readUsageEntriesForManagement,
  readUsageSnapshotForManagement,
  resetUsageReadCacheForTests,
  usageForFinalLog,
  usageLogPath,
  usageStatusForFinalLog,
  usageTotalTokens,
  usageReadCacheStatsForTests,
  usageLogRevisionKey,
  type PersistedUsageEntry,
} from "../src/usage/log";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

  describe("fork usage recovery kinds", () => {
  test("preserves explicitly empty attempts through normalization", () => {
    const normalized = normalizeUsageEntryForTest({
      requestId: "ocx-empty-attempts",
      timestamp: 1,
      provider: "openai",
      model: "gpt-test",
      status: 200,
      durationMs: 1,
      usageStatus: "unreported",
      attempts: [],
    });

    expect(normalized.attempts).toEqual([]);
  });

  test("preserves only valid non-PII Codex account log labels", () => {
    const normalized = normalizeUsageEntryForTest({
      requestId: "ocx-account-label",
      timestamp: 1,
      provider: "openai-pabc123",
      model: "gpt-test",
      accountLogLabel: "pabc123",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      attempts: [{
        ordinal: 1,
        provider: "openai-pabc123",
        model: "gpt-test",
        adapter: "openai-responses",
        accountLogLabel: "pabc123",
        status: 200,
        durationMs: 1,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "reported",
      }],
    });
    expect(normalized.accountLogLabel).toBe("pabc123");
    expect(normalized.attempts?.[0]?.accountLogLabel).toBe("pabc123");

    const rejected = normalizeUsageEntryForTest({
      ...normalized,
      accountLogLabel: "raw-account-id",
      attempts: [{ ...normalized.attempts![0]!, accountLogLabel: "person@example.test" }],
    });
    expect(rejected.accountLogLabel).toBeUndefined();
    expect(rejected.attempts?.[0]?.accountLogLabel).toBeUndefined();
  });

  test("persists the rate-limit-429 recovery kind on attempts", () => {
    const entry: PersistedUsageEntry = {
      requestId: "ocx-ratelimit-kind",
      timestamp: 1,
      provider: "blsc",
      model: "blsc/DeepSeek-V4-Flash",
      status: 429,
      durationMs: 4,
      usageStatus: "reported",
      attempts: [{
        ordinal: 1,
        provider: "blsc",
        model: "blsc/DeepSeek-V4-Flash",
        adapter: "openai-chat",
        status: 429,
        durationMs: 4,
        sendCount: 2,
        recoveryKinds: ["rate-limit-429", "rate-limit-429"],
        usageStatus: "reported",
      }],
    };
    appendUsageEntry(entry);
    expect(readUsageEntries()[0]?.attempts?.[0]?.recoveryKinds).toEqual(["rate-limit-429"]);
  });

  test("persists the agent-task-recovery kind on attempts", () => {
    const entry: PersistedUsageEntry = {
      requestId: "ocx-agent-task-recovery-kind",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.6-terra",
      status: 200,
      durationMs: 4,
      usageStatus: "reported",
      attempts: [{
        ordinal: 1,
        provider: "openai",
        model: "gpt-5.6-terra",
        adapter: "openai-responses",
        status: 200,
        durationMs: 4,
        sendCount: 2,
        recoveryKinds: ["agent-task-recovery", "agent-task-recovery"],
        usageStatus: "reported",
      }],
    };
    appendUsageEntry(entry);
    expect(readUsageEntries()[0]?.attempts?.[0]?.recoveryKinds).toEqual(["agent-task-recovery"]);
  });



  test("keeps the GUI recovery-kind map exhaustive with the persisted backend union", () => {
    const backendSource = readFileSync(join(import.meta.dir, "../src/usage/log.ts"), "utf8");
    const guiSource = readFileSync(join(import.meta.dir, "../gui/src/pages/Logs.tsx"), "utf8");
    const backendBlock = /export type AttemptRecoveryKind =([\s\S]*?);\n\nexport interface PersistedUsageAttempt/.exec(backendSource)?.[1];
    const guiBlock = /const RECOVERY_KIND_KEYS = \{([\s\S]*?)\n\} as const satisfies Record<AttemptRecoveryKind, string>/.exec(guiSource)?.[1];

    expect(backendBlock).toBeDefined();
    expect(guiBlock).toBeDefined();
    const backendKinds = [...backendBlock!.matchAll(/\|\s*"([^"]+)"/g)].map(match => match[1]).sort();
    const guiKinds = [...guiBlock!.matchAll(/^\s*"([^"]+)":/gm)].map(match => match[1]).sort();
    expect(guiKinds).toEqual(backendKinds);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as debugPersistence from "../../src/fork/debug-persistence";
import { createInboundResponsesDebugObserver } from "../../src/fork/inbound-response-debug";
import { CONFIG_OWNER_FILE, CONFIG_UNINSTALL_MANIFEST } from "../../src/lib/config-ownership";
import { localInstallRestartEnv } from "../../scripts/install-local";
import { resetDebugLogBufferForTests } from "../../src/lib/debug-log-buffer";
import {
  getDebugSettings,
  resetDebugSettingsForTests,
  setDebugSettings,
} from "../../src/lib/debug-settings";

let previousHome: string | undefined;
let previousTextEnv: string | undefined;
let root = "";

const MEBIBYTE = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

type SeededGroup = {
  directory: string;
  journal: string;
  artifact: string;
  timeline: string;
  pending: string;
};

function dayAndHour(at: number): { day: string; hour: string } {
  const date = new Date(at);
  return {
    day: date.toISOString().slice(0, 10),
    hour: String(date.getUTCHours()).padStart(2, "0"),
  };
}

function setFileSize(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "w", 0o600);
  try {
    ftruncateSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

function seedGroup(options: {
  at: number;
  bytes?: number;
  artifactOnly?: boolean;
  pending?: boolean;
}): SeededGroup {
  const { day, hour } = dayAndHour(options.at);
  const id = `segment-${options.at}-${randomUUID()}`;
  const directory = join(root, "provider-debug", day, hour, "groups", id);
  const artifactDirectory = join(root, "provider-debug-artifacts", day, hour, "groups", id);
  const journal = join(directory, "provider-debug.jsonl");
  const artifact = join(artifactDirectory, "sample.jsonl");
  const timeline = join(directory, "timelines", "timeline.jsonl");
  const pending = join(directory, ".pending");
  if (!options.artifactOnly) {
    mkdirSync(dirname(journal), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(timeline), { recursive: true, mode: 0o700 });
    writeFileSync(journal, `${JSON.stringify({ debugGroup: id, textRef: join("provider-debug-artifacts", day, hour, "groups", id, "sample.jsonl") })}\n`);
    writeFileSync(timeline, "{\"type\":\"response.output_text.delta\"}\n");
    if (options.pending) writeFileSync(pending, "");
  }
  setFileSize(artifact, options.bytes ?? 1);
  for (const path of [journal, artifact, timeline, pending]) {
    if (existsSync(path)) utimesSync(path, new Date(options.at), new Date(options.at));
  }
  return { directory, journal, artifact, timeline, pending };
}

function treeBytes(directory: string): number {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(directory, entry.name);
    return total + (entry.isDirectory() ? treeBytes(path) : statSync(path).size);
  }, 0);
}

function persistMarker(marker: string): void {
  debugPersistence.persistDebugEntry({ seq: Date.now(), at: Date.now(), line: marker });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousTextEnv = process.env.OCX_PROVIDER_TEXT_DEBUG;
  root = mkdtempSync(join(tmpdir(), "ocx-provider-debug-safety-"));
  process.env.OPENCODEX_HOME = root;
  delete process.env.OCX_PROVIDER_TEXT_DEBUG;
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  debugPersistence.resetProviderDebugPersistenceForTests();
});

afterEach(() => {
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  debugPersistence.resetProviderDebugPersistenceForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousTextEnv === undefined) delete process.env.OCX_PROVIDER_TEXT_DEBUG;
  else process.env.OCX_PROVIDER_TEXT_DEBUG = previousTextEnv;
  if (root) rmSync(root, { recursive: true, force: true });
});

function noteText(observer: ReturnType<typeof createInboundResponsesDebugObserver>): void {
  observer.notePayload({
    type: "response.reasoning_text.delta",
    item_id: "rs_private",
    delta: "private reasoning text",
  });
}

describe("provider debug consent and durable storage safety", () => {
  test("ordinary provider debug remains text-free until providerText is explicitly enabled", () => {
    setDebugSettings({ debug: true });
    const structural = createInboundResponsesDebugObserver();
    noteText(structural);
    expect(structural.summary().textSamples).toBeUndefined();
    expect((getDebugSettings() as unknown as { providerText?: boolean }).providerText).toBe(false);

    setDebugSettings({ providerText: true } as never);
    const textCapture = createInboundResponsesDebugObserver();
    noteText(textCapture);
    expect(textCapture.summary().textSamples?.[0]?.text).toBe("private reasoning text");
    expect((getDebugSettings() as unknown as { providerText?: boolean }).providerText).toBe(true);
  });

  test("install:local preserves debug consent instead of enabling text capture", () => {
    const env = localInstallRestartEnv({ PATH: "/usr/bin" });
    expect(env.OCX_DEBUG).toBeUndefined();
    expect(env.OCX_PROVIDER_TEXT_DEBUG).toBeUndefined();
  });

  test("writes durable debug entries in a home without ownership metadata", () => {
    writeFileSync(join(root, "unowned.txt"), "belongs to the user");
    debugPersistence.persistDebugEntry({ seq: 1, at: 1, line: "local-capture-without-ledger" });
    const rows = readFileSync(debugPersistence.providerDebugLogPath(), "utf8").trim().split("\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("local-capture-without-ledger");
  });

  test("keeps capturing when the ownership manifest is too large to read", () => {
    // 2026-09-11 incident: unique debug artifacts pushed the uninstall manifest past the
    // 64 KiB metadata read limit, loadOwnership() threw, and the write gate closed for good.
    const owner = { version: 1, ownerId: randomUUID(), root: realpathSync.native(root) };
    writeFileSync(join(root, CONFIG_OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`);
    const paths = Array.from({ length: 800 }, (_, index) =>
      `provider-debug/2026-09-11/03/timelines/timeline-${index}-${"a".repeat(60)}.jsonl`);
    writeFileSync(join(root, CONFIG_UNINSTALL_MANIFEST), `${JSON.stringify({ ...owner, paths }, null, 2)}\n`);
    expect(statSync(join(root, CONFIG_UNINSTALL_MANIFEST)).size).toBeGreaterThan(64 * 1024);

    debugPersistence.persistDebugEntry({ seq: 1, at: 1, line: "capture-survives-oversized-ledger" });

    const rows = readFileSync(debugPersistence.providerDebugLogPath(), "utf8").trim().split("\n");
    expect(rows.at(-1)).toContain("capture-survives-oversized-ledger");
  });

  test.skipIf(process.platform === "win32")("keeps writing when the sibling debug root holds an unverifiable entry", () => {
    const sibling = join(root, "provider-debug-artifacts", "2026-09-11", "09");
    mkdirSync(sibling, { recursive: true });
    symlinkSync(join(root, "outside-target.jsonl"), join(sibling, "linked.jsonl"));

    // Only the root being written keeps the fail-closed contract; a foreign entry in the
    // sibling root must not turn into a write gate for this capture.
    expect(debugPersistence.persistProviderDebugFile("provider-debug/current.jsonl", "new\n")).toBe(true);
    expect(readFileSync(join(root, "provider-debug/current.jsonl"), "utf8")).toBe("new\n");
  });

  test("keeps writing when a sibling-root entry cannot be deleted", () => {
    const sibling = join(root, "provider-debug-artifacts", "2026-09-01", "00");
    mkdirSync(sibling, { recursive: true });
    const stuck = join(sibling, "stuck.jsonl");
    writeFileSync(stuck, "stuck\n");
    utimesSync(stuck, new Date(0), new Date(0));

    // The age pass cannot delete it, so it leaves this call's budget instead of
    // refusing the capture that belongs to the other root.
    expect(debugPersistence.persistProviderDebugFile("provider-debug/current.jsonl", "new\n", {
      maxAgeMs: 1_000,
      removeFile: () => { throw new Error("cleanup denied"); },
    })).toBe(true);
    expect(existsSync(stuck)).toBe(true);
    expect(readFileSync(join(root, "provider-debug/current.jsonl"), "utf8")).toBe("new\n");
  });

  test("drops an undeletable sibling entry from the budget only once", () => {
    const sibling = join(root, "provider-debug-artifacts", "2026-09-01", "00");
    mkdirSync(sibling, { recursive: true });
    const stuck = join(sibling, "stuck.jsonl");
    writeFileSync(stuck, "x".repeat(30));
    utimesSync(stuck, new Date(0), new Date(0));
    const targetRoot = join(root, "provider-debug");
    mkdirSync(targetRoot, { recursive: true });
    const keep = join(targetRoot, "keep.jsonl");
    writeFileSync(keep, "y".repeat(99));

    const persisted = debugPersistence.persistProviderDebugFile("provider-debug/current.jsonl", "new\n", {
      maxFileBytes: 1_000,
      maxTotalBytes: 100,
      maxFiles: 10,
      maxAgeMs: 1_000,
      removeFile: (path: string) => {
        if (path === stuck) throw new Error("cleanup denied");
        unlinkSync(path);
      },
    });

    expect(persisted).toBe(true);
    // Counting the stuck entry once keeps the first pass over budget, so the capacity pass
    // still reaches the deletable file; a second deduction would converge early and keep it.
    expect(existsSync(keep)).toBe(false);
    expect(existsSync(stuck)).toBe(true);
  });

  test.skipIf(process.platform === "win32")("refuses a symlinked provider-debug parent", () => {
    debugPersistence.persistDebugEntry({ seq: 1, at: 1, line: "ownership-seed" });
    const outside = mkdtempSync(join(tmpdir(), "ocx-provider-debug-outside-"));
    try {
      rmSync(join(root, "provider-debug"), { recursive: true, force: true });
      symlinkSync(outside, join(root, "provider-debug"), "dir");
      debugPersistence.persistDebugEntry({ seq: 2, at: 2, line: "must-not-follow-parent" });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("refuses a symlinked final JSONL file", () => {
    debugPersistence.persistDebugEntry({ seq: 1, at: 1, line: "ownership-seed" });
    const target = debugPersistence.providerDebugLogPath();
    const outside = join(dirname(root), `ocx-provider-debug-target-${Date.now()}.jsonl`);
    try {
      rmSync(target);
      writeFileSync(outside, "outside\n");
      symlinkSync(outside, target);
      debugPersistence.persistDebugEntry({ seq: 2, at: 2, line: "must-not-follow-final" });
      expect(readFileSync(outside, "utf8")).toBe("outside\n");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("rolls over the main JSONL without truncating its existing records", () => {
    debugPersistence.persistDebugEntry({ seq: 1, at: 1, line: "ownership-seed" });
    const target = debugPersistence.providerDebugLogPath();
    const seeded = `${JSON.stringify({ seq: 1, at: 1, line: "x".repeat(1024) })}\n`;
    const rows = Math.ceil((4 * 1024 * 1024) / Buffer.byteLength(seeded));
    writeFileSync(target, seeded.repeat(rows), { mode: 0o600 });
    const before = readFileSync(target, "utf8");

    debugPersistence.persistDebugEntry({ seq: 2, at: 2, line: "rollover-marker" });

    expect(readFileSync(target, "utf8")).toBe(before);
    const rollover = debugPersistence.providerDebugLogPath();
    expect(rollover).not.toBe(target);
    expect(readFileSync(rollover, "utf8")).toContain("rollover-marker");
  });

  test("enforces aggregate byte and file limits and refuses growth when cleanup fails", () => {
    const persistFile = (debugPersistence as unknown as {
      persistProviderDebugFile?: (
        relativePath: string,
        content: string,
        options?: Record<string, unknown>,
      ) => boolean;
    }).persistProviderDebugFile;
    expect(typeof persistFile).toBe("function");
    if (!persistFile) return;

    const limits = { maxFileBytes: 128, maxTotalBytes: 180, maxFiles: 2, maxAgeMs: 60_000 };
    expect(persistFile("provider-debug-artifacts/2026-09-03/01/a.jsonl", "a".repeat(90), limits)).toBe(true);
    expect(persistFile("provider-debug-artifacts/2026-09-03/02/b.jsonl", "b".repeat(100), limits)).toBe(true);
    expect(existsSync(join(root, "provider-debug-artifacts/2026-09-03/01/a.jsonl"))).toBe(false);
    expect(statSync(join(root, "provider-debug-artifacts/2026-09-03/02/b.jsonl")).size).toBe(100);

    expect(persistFile(
      "provider-debug-artifacts/2026-09-03/03/c.jsonl",
      "c".repeat(90),
      { ...limits, removeFile: () => { throw new Error("cleanup denied"); } },
    )).toBe(false);
    expect(existsSync(join(root, "provider-debug-artifacts/2026-09-03/03/c.jsonl"))).toBe(false);
  });

  test("expires files across day and hour partitions before accepting the current write", () => {
    const persistFile = debugPersistence.persistProviderDebugFile;
    const oldRelative = "provider-debug-artifacts/2026-09-01/23/old.jsonl";
    const oldPath = join(root, oldRelative);
    expect(persistFile(oldRelative, "old\n", { maxAgeMs: 1_000 })).toBe(true);
    utimesSync(oldPath, new Date(0), new Date(0));

    expect(persistFile(
      "provider-debug/2026-09-04/00/timelines/current.jsonl",
      "current\n",
      { maxAgeMs: 1_000, now: Date.now() },
    )).toBe(true);
    expect(existsSync(oldPath)).toBe(false);
  });

  test("keeps a current grouped capture while deleting same-day legacy journals and their references", () => {
    const now = Date.now();
    const { day, hour } = dayAndHour(now);
    const fresh = seedGroup({ at: now - 1_000 });
    const legacyIndex = join(root, "provider-debug", day, "provider-debug.jsonl");
    const legacyHourlyIndex = join(root, "provider-debug", day, hour, "provider-debug.jsonl");
    const legacyTimeline = join(root, "provider-debug", day, hour, "timelines", "legacy.jsonl");
    const legacyArtifact = join(root, "provider-debug-artifacts", day, hour, "legacy.jsonl");
    for (const path of [legacyIndex, legacyHourlyIndex, legacyTimeline, legacyArtifact]) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, "legacy\n");
      utimesSync(path, new Date(now - 8 * DAY_MS), new Date(now - 8 * DAY_MS));
    }

    debugPersistence.setProviderDebugRetentionLimitsForTests({ maxAgeMs: 7 * DAY_MS });
    persistMarker("mixed-legacy-cleanup");

    expect(existsSync(legacyIndex)).toBe(false);
    expect(existsSync(legacyHourlyIndex)).toBe(false);
    expect(existsSync(legacyTimeline)).toBe(false);
    expect(existsSync(legacyArtifact)).toBe(false);
    expect(existsSync(fresh.journal)).toBe(true);
    expect(existsSync(fresh.artifact)).toBe(true);
    expect(existsSync(fresh.timeline)).toBe(true);
  });

  test("counts and expires an artifact-only group", () => {
    const orphan = seedGroup({ at: Date.now() - 8 * DAY_MS, artifactOnly: true });
    debugPersistence.setProviderDebugRetentionLimitsForTests({ maxAgeMs: 7 * DAY_MS });

    persistMarker("artifact-only-cleanup");

    expect(existsSync(orphan.artifact)).toBe(false);
    expect(readFileSync(debugPersistence.providerDebugLogPath(), "utf8")).toContain("artifact-only-cleanup");
  });

  test("continues after an index-delete failure without orphaning its artifact, then retries it", () => {
    const now = Date.now();
    const stuck = seedGroup({ at: now - 3_000 });
    const fallback = seedGroup({ at: now - 2_000 });
    const survivor = seedGroup({ at: now - 1_000 });
    debugPersistence.setProviderDebugRetentionLimitsForTests({ maxTotalBytes: 12 * MEBIBYTE });
    chmodSync(stuck.directory, 0o500);
    try {
      persistMarker("capacity-after-stuck-index");
      expect(existsSync(stuck.journal)).toBe(true);
      expect(existsSync(stuck.artifact)).toBe(true);
      expect([fallback, survivor].some(group => !existsSync(group.journal) && !existsSync(group.artifact))).toBe(true);
      expect(readFileSync(debugPersistence.providerDebugLogPath(), "utf8")).toContain("capacity-after-stuck-index");
    } finally {
      chmodSync(stuck.directory, 0o700);
    }
    for (const path of [stuck.journal, stuck.artifact, stuck.timeline]) {
      utimesSync(path, new Date(now - 8 * DAY_MS), new Date(now - 8 * DAY_MS));
    }

    debugPersistence.resetProviderDebugPersistenceForTests();
    debugPersistence.setProviderDebugRetentionLimitsForTests({ maxTotalBytes: 12 * MEBIBYTE, maxAgeMs: 7 * DAY_MS });
    persistMarker("retry-stuck-index");
    expect(existsSync(stuck.journal)).toBe(false);
    expect(existsSync(stuck.artifact)).toBe(false);
  });

  test("recovers a stale malformed lock without taking over a live owner", () => {
    const lock = join(root, ".provider-debug-capture.lock");
    writeFileSync(lock, "{");
    utimesSync(lock, new Date(Date.now() - 6 * 60 * 1_000), new Date(Date.now() - 6 * 60 * 1_000));

    persistMarker("stale-lock-recovered");

    expect(readFileSync(debugPersistence.providerDebugLogPath(), "utf8")).toContain("stale-lock-recovered");
    debugPersistence.resetProviderDebugPersistenceForTests();
    rmSync(join(root, "provider-debug"), { recursive: true, force: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    persistMarker("must-not-steal-live-lock");

    expect(existsSync(debugPersistence.providerDebugLogPath())).toBe(false);
    expect(readFileSync(lock, "utf8")).toContain(`"pid":${process.pid}`);
  });

  test("preserves committed rows while repairing a stale pending tail", () => {
    const group = debugPersistence.beginProviderDebugCaptureGroup(0);
    expect(group).toBeDefined();
    if (!group) return;
    debugPersistence.persistDebugEntry({ seq: 1, at: 1, line: "committed-before-crash" });
    expect(debugPersistence.completeProviderDebugCaptureGroup(group)).toBe(true);
    writeFileSync(group.journalPath, "{\"partial", { flag: "a" });
    writeFileSync(group.pendingPath, "");
    utimesSync(group.pendingPath, new Date(Date.now() - 6 * 60 * 1_000), new Date(Date.now() - 6 * 60 * 1_000));

    debugPersistence.resetProviderDebugPersistenceForTests();
    persistMarker("capture-after-crash-recovery");

    expect(existsSync(group.journalPath)).toBe(true);
    const rows = readFileSync(group.journalPath, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { line?: string });
    expect(rows.some(row => row.line === "committed-before-crash")).toBe(true);
  });

  test("releases a failed second completion so the committed group can capture again", () => {
    const committed = debugPersistence.beginProviderDebugCaptureGroup(0);
    expect(committed).toBeDefined();
    if (!committed) return;
    debugPersistence.persistDebugEntry({ seq: 1, at: 1, line: "first-committed-row" });
    expect(debugPersistence.completeProviderDebugCaptureGroup(committed)).toBe(true);

    const unfinished = debugPersistence.beginProviderDebugCaptureGroup(0);
    expect(unfinished).toBeDefined();
    if (!unfinished) return;
    expect(debugPersistence.completeProviderDebugCaptureGroup(unfinished)).toBe(false);
    debugPersistence.abandonProviderDebugCaptureGroup(unfinished);
    expect(existsSync(unfinished.pendingPath)).toBe(false);

    const retry = debugPersistence.beginProviderDebugCaptureGroup(0);
    expect(retry).toBeDefined();
    if (!retry) return;
    debugPersistence.persistDebugEntry({ seq: 2, at: 2, line: "second-committed-row" });
    expect(debugPersistence.completeProviderDebugCaptureGroup(retry)).toBe(true);
    const committedRows = readFileSync(committed.journalPath, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { line?: string });
    const retryRows = readFileSync(retry.journalPath, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { line?: string });
    expect(committedRows.some(row => row.line === "first-committed-row")).toBe(true);
    expect(retryRows.some(row => row.line === "second-committed-row")).toBe(true);
  });

  test("repairs an unfinished journal tail before a failed append can be reused", () => {
    const group = debugPersistence.beginProviderDebugCaptureGroup(0);
    expect(group).toBeDefined();
    if (!group) return;
    writeFileSync(group.journalPath, "{\"partial", { flag: "a" });
    expect(debugPersistence.completeProviderDebugCaptureGroup(group)).toBe(false);
    debugPersistence.abandonProviderDebugCaptureGroup(group);

    persistMarker("capture-after-unfinished-tail");

    const rows = readFileSync(group.journalPath, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { line?: string });
    expect(rows.some(row => row.line === "capture-after-unfinished-tail")).toBe(true);
  });

  test("keeps capturing after an indexed group cannot remove its pending marker", () => {
    const group = debugPersistence.beginProviderDebugCaptureGroup(0);
    expect(group).toBeDefined();
    if (!group) return;
    debugPersistence.persistDebugEntry({ seq: 1, at: 1, line: "committed-before-pending-cleanup-failure" });
    rmSync(group.pendingPath);
    mkdirSync(group.pendingPath, { mode: 0o700 });
    expect(debugPersistence.completeProviderDebugCaptureGroup(group)).toBe(false);
    debugPersistence.abandonProviderDebugCaptureGroup(group);

    persistMarker("capture-after-pending-cleanup-failure");

    expect(readFileSync(group.journalPath, "utf8")).toContain("committed-before-pending-cleanup-failure");
    expect(readFileSync(debugPersistence.providerDebugLogPath(), "utf8")).toContain("capture-after-pending-cleanup-failure");
  });

  for (const artifactBlocker of [
    "provider-debug-artifacts",
    "provider-debug-artifacts/{day}",
    "provider-debug-artifacts/{day}/{hour}",
    "provider-debug-artifacts/{day}/{hour}/groups",
  ]) {
    test(`writes the main journal when ${artifactBlocker} is not a directory`, () => {
      const { day, hour } = dayAndHour(Date.now());
      const target = join(root, ...artifactBlocker
        .replace("{day}", day)
        .replace("{hour}", hour)
        .split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, "not-a-directory");

      persistMarker(`main-survives-${artifactBlocker}`);

      expect(readFileSync(debugPersistence.providerDebugLogPath(), "utf8")).toContain(`main-survives-${artifactBlocker}`);
    });
  }

  test.skipIf(process.platform === "win32")("writes the main journal when an artifact groups directory is unreadable", () => {
    const { day, hour } = dayAndHour(Date.now());
    const blocked = join(root, "provider-debug-artifacts", day, hour, "groups");
    mkdirSync(blocked, { recursive: true, mode: 0o700 });
    chmodSync(blocked, 0o000);
    try {
      persistMarker("main-survives-unreadable-artifact-groups");
      expect(readFileSync(debugPersistence.providerDebugLogPath(), "utf8")).toContain("main-survives-unreadable-artifact-groups");
    } finally {
      chmodSync(blocked, 0o700);
    }
  });

  test("expires a sealed group with its references", () => {
    const sealed = seedGroup({ at: Date.now() - 8 * DAY_MS, bytes: MEBIBYTE });
    const marker = join(sealed.directory, ".sealed");
    writeFileSync(marker, "");
    utimesSync(marker, new Date(Date.now() - 8 * DAY_MS), new Date(Date.now() - 8 * DAY_MS));
    debugPersistence.setProviderDebugRetentionLimitsForTests({ maxAgeMs: 7 * DAY_MS });

    persistMarker("sealed-expiry-cleanup");

    expect(existsSync(sealed.journal)).toBe(false);
    expect(existsSync(sealed.artifact)).toBe(false);
  });

  test("reclaims a stale pending group that is already beyond the retention age", () => {
    const stale = seedGroup({ at: Date.now() - 8 * DAY_MS, bytes: MEBIBYTE, pending: true });
    debugPersistence.setProviderDebugRetentionLimitsForTests({ maxAgeMs: 7 * DAY_MS });

    persistMarker("capture-after-expired-pending");

    expect(existsSync(stale.journal)).toBe(false);
    expect(existsSync(stale.artifact)).toBe(false);
  });

  test("evicts a recovered in-retention pending group during the same capacity pass", () => {
    const stale = seedGroup({ at: Date.now() - 6 * 60 * 1_000, bytes: MEBIBYTE, pending: true });
    debugPersistence.setProviderDebugRetentionLimitsForTests({ maxTotalBytes: 4 * MEBIBYTE });

    persistMarker("capture-after-recovered-pending-capacity");

    expect(existsSync(stale.journal)).toBe(false);
    expect(existsSync(stale.artifact)).toBe(false);
    expect(readFileSync(debugPersistence.providerDebugLogPath(), "utf8")).toContain("capture-after-recovered-pending-capacity");
  });

  test("evicts a sealed group before a capacity-bound capture grows beyond its budget", () => {
    const sealed = seedGroup({ at: Date.now() - DAY_MS, bytes: MEBIBYTE });
    writeFileSync(join(sealed.directory, ".sealed"), "");
    debugPersistence.setProviderDebugRetentionLimitsForTests({ maxTotalBytes: 4 * MEBIBYTE });

    persistMarker("n".repeat(Math.floor(3.5 * MEBIBYTE)));

    expect(existsSync(sealed.journal)).toBe(false);
    expect(existsSync(sealed.artifact)).toBe(false);
    expect(treeBytes(root)).toBeLessThanOrEqual(4 * MEBIBYTE);
  });

  test("keeps cached growth inside the injected global budget", () => {
    const budget = 8 * MEBIBYTE;
    debugPersistence.setProviderDebugRetentionLimitsForTests({ maxTotalBytes: budget });

    persistMarker("x".repeat(3 * MEBIBYTE));
    persistMarker("y".repeat(3 * MEBIBYTE));
    persistMarker("z".repeat(3 * MEBIBYTE));

    expect(treeBytes(root)).toBeLessThanOrEqual(budget);
  });

  test("does not apply a hidden file-count cap to grouped captures", () => {
    const now = Date.now();
    const groups = Array.from({ length: 257 }, (_, index) => seedGroup({ at: now - index - 1 }));
    debugPersistence.setProviderDebugRetentionLimitsForTests({ maxTotalBytes: 2 * 1024 * MEBIBYTE });

    persistMarker("more-than-256-groups");

    expect(groups.every(group => existsSync(group.journal) && existsSync(group.artifact))).toBe(true);
    expect(readFileSync(debugPersistence.providerDebugLogPath(), "utf8")).toContain("more-than-256-groups");
  });

  test.skipIf(process.platform === "win32")("keeps an ordinary journal writable when a sibling group is unsafe", () => {
    const { day, hour } = dayAndHour(Date.now());
    const sibling = join(root, "provider-debug-artifacts", day, hour, "groups", `segment-${Date.now()}-${randomUUID()}`);
    mkdirSync(sibling, { recursive: true, mode: 0o700 });
    symlinkSync(join(root, "outside-artifact.jsonl"), join(sibling, "unsafe.jsonl"));

    persistMarker("safe-journal-with-unsafe-sibling");

    expect(readFileSync(debugPersistence.providerDebugLogPath(), "utf8")).toContain("safe-journal-with-unsafe-sibling");
  });
});

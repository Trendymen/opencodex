import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousTextEnv = process.env.OCX_PROVIDER_TEXT_DEBUG;
  root = mkdtempSync(join(tmpdir(), "ocx-provider-debug-safety-"));
  process.env.OPENCODEX_HOME = root;
  delete process.env.OCX_PROVIDER_TEXT_DEBUG;
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
});

afterEach(() => {
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
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

  test("install:local enables provider debug and persists text capture by default", () => {
    const env = localInstallRestartEnv({ PATH: "/usr/bin" }, "darwin");
    expect(env.OCX_DEBUG).toBe("1");
    expect(env.OCX_PROVIDER_TEXT_DEBUG).toBe("1");
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
    const siblings = readdirSync(dirname(target)).filter(name => name.endsWith(".jsonl"));
    expect(siblings.length).toBeGreaterThan(1);
    expect(siblings.some(name => readFileSync(join(dirname(target), name), "utf8").includes("rollover-marker")))
      .toBe(true);
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
});

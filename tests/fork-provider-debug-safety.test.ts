import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as debugPersistence from "../src/fork/debug-persistence";
import { createInboundResponsesDebugObserver } from "../src/fork/inbound-response-debug";
import { localInstallRestartEnv } from "../scripts/install-local";
import { resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import {
  getDebugSettings,
  resetDebugSettingsForTests,
  setDebugSettings,
} from "../src/lib/debug-settings";

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

  test("install:local enables structural provider debug without authorizing text capture", () => {
    const env = localInstallRestartEnv({ PATH: "/usr/bin" }, "darwin");
    expect(env.OCX_DEBUG).toBe("1");
    expect(env.OCX_PROVIDER_TEXT_DEBUG).toBeUndefined();
  });

  test("refuses durable writes when config ownership cannot be established", () => {
    writeFileSync(join(root, "unowned.txt"), "belongs to the user");
    debugPersistence.persistDebugEntry({ seq: 1, at: 1, line: "must-not-persist" });
    expect(existsSync(debugPersistence.providerDebugLogPath())).toBe(false);
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

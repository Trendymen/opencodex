import { expect, test } from "bun:test";
import { normalizePersistedUsageRow, readUsageEntries, resetUsageReadCacheForTests } from "../../src/usage/log";
import { requestLogEntryFromPersistedUsage, addFinalRequestLog, beginRequestAttempt, noteProviderAttemptSend, type RequestLogContext, type RequestLogEntry } from "../../src/server/request-log";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test("upstream HTTP status survives final logging and persisted projections", () => {
  const entries: RequestLogEntry[] = []; const attempt = beginRequestAttempt(1, "openai", "gpt-test", "openai-responses");
  addFinalRequestLog("fixture", 1, { model: "gpt-test", provider: "openai", upstreamHttpStatus: 200,
    errorCode: "private-invalid-json", causeHint: "local-refusal", terminalSource: "synthetic", activeAttempt: attempt, attempts: [attempt] },
  502, { terminalStatus: "failed" }, entry => entries.push(entry));
  expect(entries[0]).toMatchObject({ status: 502, upstreamHttpStatus: 200, failureCause: "local-refusal" });
  const normalized = normalizePersistedUsageRow(entries[0]);
  expect(normalized).toMatchObject({ upstreamHttpStatus: 200, attempts: [expect.objectContaining({ upstreamHttpStatus: 200 })] });
  expect(requestLogEntryFromPersistedUsage(normalized!)).toMatchObject({ upstreamHttpStatus: 200 });
});

test("persisted HTTP status accepts only integer HTTP response statuses", () => {
  const row = { requestId: "fixture", timestamp: 1, provider: "openai", model: "gpt-test", status: 502, durationMs: 1, usageStatus: "unreported" };
  for (const value of [99, 600, 200.5, "200", Infinity, null]) {
    expect(normalizePersistedUsageRow({ ...row, upstreamHttpStatus: value })).not.toHaveProperty("upstreamHttpStatus");
  }
  expect(normalizePersistedUsageRow({ ...row, upstreamHttpStatus: 400 })).toHaveProperty("upstreamHttpStatus", 400);
});

test("the original upstream HTTP status reaches usage.jsonl and rehydrated logs", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-http-status-")); const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try { addFinalRequestLog("http-status-fixture", Date.now(), { model: "gpt-test", provider: "openai", upstreamHttpStatus: 400,
    errorCode: "private-invalid-json", causeHint: "local-refusal", terminalSource: "synthetic" }, 502);
    const [row] = readUsageEntries();
    expect(row).toMatchObject({ upstreamHttpStatus: 400, status: 502, errorCode: "private-invalid-json", failureCause: "local-refusal" });
    expect(requestLogEntryFromPersistedUsage(row!)).toHaveProperty("upstreamHttpStatus", 400);
  } finally { if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    resetUsageReadCacheForTests(); removeTreeWithRetry(home); }
});

test("a send with no response cannot inherit the previous send's HTTP status", () => {
  const attempt = beginRequestAttempt(1, "openai", "gpt-test", "openai-responses"); attempt.upstreamHttpStatus = 200;
  const ctx: RequestLogContext = { model: "gpt-test", provider: "openai", upstreamHttpStatus: 200, activeAttempt: attempt };
  noteProviderAttemptSend(ctx, "openai", { adapter: "openai-responses", baseUrl: "https://fixture.invalid" }, undefined);
  const entries: RequestLogEntry[] = []; addFinalRequestLog("fixture", Date.now(), ctx, 502, undefined, entry => entries.push(entry));
  expect(entries[0]).not.toHaveProperty("upstreamHttpStatus"); expect(attempt).not.toHaveProperty("upstreamHttpStatus");
});

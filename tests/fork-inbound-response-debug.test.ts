import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInboundResponsesDebugObserver,
  persistInboundResponsesDebugSummary,
} from "../src/fork/inbound-response-debug";
import { providerDebugLogPath } from "../src/fork/debug-persistence";
import {
  configureAppOwnedMemoryBudget,
  enforceAppOwnedMemoryBudget,
  resetAppOwnedMemoryForTests,
} from "../src/lib/app-owned-memory";
import { registerDefaultAppOwnedMemoryStores } from "../src/lib/app-owned-memory-stores";
import { appendDebugLogLine, getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
let previousOpenCodexHome: string | undefined;
let testDir = "";

function deepseekConfig(): OcxConfig {
  return {
    providers: {
      deepseek: { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" },
    },
  } as unknown as OcxConfig;
}

function inboundDebugPayload(kind: "inbound-sse-summary" | "inbound-json-summary"): Record<string, unknown> {
  const rows = readFileSync(providerDebugLogPath(), "utf8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line) as { line: string });
  const row = rows.find(entry => entry.line.startsWith(`[ocx:openai-responses:${kind}]`));
  if (!row) throw new Error(`missing ${kind} provider-debug entry`);
  return JSON.parse(row.line.slice(row.line.indexOf("] ") + 2)) as Record<string, unknown>;
}

beforeEach(() => {
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-inbound-response-debug-"));
  process.env.OPENCODEX_HOME = testDir;
  resetDebugLogBufferForTests();
});

describe("inbound upstream Responses debug observer", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetDebugSettingsForTests();
    resetDebugLogBufferForTests();
    resetAppOwnedMemoryForTests();
    if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpenCodexHome;
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test("aggregates native event counts, text bytes, timeline, and terminal shapes", () => {
    setDebugSettings({ debug: true });
    const observer = createInboundResponsesDebugObserver();
    const events = [
      { type: "response.created", response: { id: "resp_1", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
      { type: "response.reasoning_text.delta", delta: "12345" },
      { type: "response.reasoning_text.done", text: "1234567890" },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text" }], summary: [] } },
      { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", phase: "commentary", content: [{ type: "output_text" }] } },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } },
    ];
    for (const payload of events) observer.notePayload(payload);
    expect(observer.summary()).toEqual({
      kind: "inbound-sse-summary",
      terminal: "completed",
      eventCounts: {
        "response.created": 1,
        "response.output_item.added": 1,
        "response.reasoning_text.delta": 1,
        "response.reasoning_text.done": 1,
        "response.output_item.done": 2,
        "response.completed": 1,
      },
      textBytes: {
        reasoningText: 15,
        reasoningSummaryText: 0,
        outputText: 0,
      },
      timeline: [
        { seq: 0, type: "response.created" },
        { seq: 1, type: "response.output_item.added", itemType: "reasoning", summaryParts: 0 },
        { seq: 2, type: "response.reasoning_text.delta", deltaBytes: 5 },
        { seq: 3, type: "response.reasoning_text.done", textBytes: 10 },
        { seq: 4, type: "response.output_item.done", itemType: "reasoning", contentTypes: ["reasoning_text"], summaryParts: 0 },
        { seq: 5, type: "response.output_item.done", itemType: "message", role: "assistant", phase: "commentary", contentTypes: ["output_text"] },
        { seq: 6, type: "response.completed", responseStatus: "completed", outputItemTypes: [] },
      ],
      timelineTruncated: false,
    });
  });

  test("counts continuing events after timeline truncation without storing more entries", () => {
    setDebugSettings({ debug: true });
    const observer = createInboundResponsesDebugObserver({ timelineLimit: 2 });
    for (let index = 0; index < 5; index++) {
      observer.notePayload({ type: "response.reasoning_text.delta", delta: "1234" });
    }
    const summary = observer.summary();
    expect(summary.timeline).toEqual([
      { seq: 0, type: "response.reasoning_text.delta", deltaBytes: 4 },
      { seq: 1, type: "response.reasoning_text.delta", deltaBytes: 4 },
    ]);
    expect(summary.timelineTruncated).toBe(true);
    expect(summary.eventCounts["response.reasoning_text.delta"]).toBe(5);
    expect(summary.textBytes.reasoningText).toBe(20);
  });

  test("bounds a default live SSE observer while continuing aggregate counters", () => {
    const observer = createInboundResponsesDebugObserver();
    for (let index = 0; index < 4_097; index++) {
      observer.notePayload({ type: "response.reasoning_text.delta", delta: "1234" });
    }
    const summary = observer.summary();
    expect(summary.timelineTruncated).toBe(true);
    expect(summary.timeline.length).toBeLessThanOrEqual(4_096);
    expect(summary.eventCounts["response.reasoning_text.delta"]).toBe(4_097);
    expect(summary.textBytes.reasoningText).toBe(4_097 * 4);
  });

  test("allows a structural timeline beyond the UI preview limit without retaining unknown labels", () => {
    const observer = createInboundResponsesDebugObserver({ timelineLimit: 96 });
    const oversizedType = "x".repeat(96);
    const content = Array.from({ length: 128 }, () => ({ type: oversizedType }));
    for (let index = 0; index < 97; index++) {
      observer.notePayload({
        type: "response.output_item.done",
        item: { type: oversizedType, role: oversizedType, phase: oversizedType, content },
      });
    }
    const summary = observer.summary();
    expect(summary.timelineTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(summary), "utf8")).toBeGreaterThan(16 * 1024);
    expect(JSON.stringify(summary)).not.toContain(oversizedType);
  });

  test("maps an unknown event label to other without retaining its upstream text", () => {
    const observer = createInboundResponsesDebugObserver();
    const untrustedType = "secret-upstream-event-with-response-id-rsp_123";
    observer.notePayload({ type: untrustedType, tool_arguments: "never-log-this" });
    expect(observer.summary()).toMatchObject({
      eventCounts: { other: 1 },
      timeline: [{ seq: 0, type: "other" }],
    });
    expect(JSON.stringify(observer.summary())).not.toContain(untrustedType);
  });

  test("writes a full durable structural summary beyond the UI preview limit without unbounded context", () => {
    setDebugSettings({ debug: true });
    const observer = createInboundResponsesDebugObserver({ timelineLimit: 512 });
    for (let index = 0; index < 256; index++) {
      observer.notePayload({
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text" }] },
      });
    }
    const longHost = `${"h".repeat(1024)}.example.test`;
    const longPath = `/${"p".repeat(1024)}`;
    const longModel = `model-${"m".repeat(1024)}`;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      persistInboundResponsesDebugSummary({
        observer,
        host: longHost,
        pathname: longPath,
        model: longModel,
      });
    } finally {
      error.mockRestore();
    }

    const rows = readFileSync(providerDebugLogPath(), "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { line: string });
    const row = rows.find(entry => entry.line.startsWith("[ocx:openai-responses:inbound-sse-summary]"));
    expect(row).toBeDefined();
    expect(Buffer.byteLength(row!.line, "utf8")).toBeGreaterThan(16 * 1024);
    expect(() => JSON.parse(row!.line.slice(row!.line.indexOf("] ") + 2))).not.toThrow();
    expect(row!.line).not.toContain(longHost);
    expect(row!.line).not.toContain(longPath);
    expect(row!.line).not.toContain(longModel);
    expect(getDebugLogEntries()[0]!.line.length).toBeLessThan(row!.line.length);
  });

  test("provider debug ring is not evicted by the global app-owned memory budget", () => {
    resetAppOwnedMemoryForTests();
    registerDefaultAppOwnedMemoryStores();
    appendDebugLogLine("provider-debug-operator-evidence");
    configureAppOwnedMemoryBudget(0);
    enforceAppOwnedMemoryBudget();
    expect(getDebugLogEntries().map(entry => entry.line)).toContain("provider-debug-operator-evidence");
  });

  test("summarizes a native JSON terminal without retaining raw reasoning or assistant text", () => {
    const observer = createInboundResponsesDebugObserver();
    observer.noteJsonResponse({
      id: "resp_should_not_be_logged",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_should_not_be_logged",
          encrypted_content: "opaque_should_not_be_logged",
          content: [{ type: "reasoning_text", text: "raw chain" }],
          summary: [{ type: "summary_text", text: "secret summary" }],
        },
        {
          type: "message",
          id: "msg_should_not_be_logged",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "done" }],
        },
      ],
    });

    const summary = observer.summary();
    expect(summary).toEqual({
      kind: "inbound-json-summary",
      terminal: "completed",
      eventCounts: { "response.json": 1 },
      textBytes: {
        reasoningText: 9,
        reasoningSummaryText: 14,
        outputText: 4,
      },
      timeline: [
        { seq: 0, type: "response.json", responseStatus: "completed", outputItemTypes: ["reasoning", "message"] },
        {
          seq: 1,
          type: "response.output_item.done",
          itemType: "reasoning",
          contentTypes: ["reasoning_text"],
          summaryParts: 1,
          hasEncryptedContent: true,
        },
        {
          seq: 2,
          type: "response.output_item.done",
          itemType: "message",
          role: "assistant",
          phase: "final_answer",
          contentTypes: ["output_text"],
        },
      ],
      timelineTruncated: false,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("raw chain");
    expect(serialized).not.toContain("secret summary");
    expect(serialized).not.toContain("opaque_should_not_be_logged");
    expect(serialized).not.toContain("resp_should_not_be_logged");
  });

  test("records failed terminal and persists with context while disabled writes nothing", () => {
    setDebugSettings({ debug: true });
    const observer = createInboundResponsesDebugObserver();
    observer.notePayload({ type: "response.failed", response: { status: "failed", output: [] } });
    expect(observer.summary().terminal).toBe("failed");

    const persisted: unknown[] = [];
    persistInboundResponsesDebugSummary({
      observer,
      host: "open.bigmodel.cn",
      pathname: "/api/v1/responses",
      model: "glm-5.3-flash",
      threadIdTag: "a1b2c3d4e5f6",
      httpStatus: 200,
      persist: entry => persisted.push(entry),
    });
    expect(persisted[0]).toMatchObject({
      kind: "inbound-sse-summary",
      host: "open.bigmodel.cn",
      pathname: "/api/v1/responses",
      model: "glm-5.3-flash",
      threadIdTag: "a1b2c3d4e5f6",
      httpStatus: 200,
      terminal: "failed",
    });

    resetDebugSettingsForTests();
    const disabled: unknown[] = [];
    persistInboundResponsesDebugSummary({
      observer: createInboundResponsesDebugObserver(),
      host: "example.test",
      pathname: "/responses",
      model: "x",
      persist: entry => disabled.push(entry),
    });
    expect(disabled).toEqual([]);
  });

  test("core captures the original upstream SSE lifecycle and persists only its structural summary", async () => {
    setDebugSettings({ debug: true });
    const rawReasoning = "upstream reasoning must not be retained";
    const rawAssistant = "upstream assistant text must not be retained";
    const frames = [
      { type: "response.created", response: { id: "resp_private", status: "in_progress", output: [] } },
      { type: "response.output_item.added", item: { type: "reasoning", id: "rs_private", summary: [] } },
      { type: "response.reasoning_text.delta", delta: rawReasoning },
      { type: "response.output_item.done", item: { type: "message", id: "msg_private", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: rawAssistant }] } },
      { type: "response.completed", response: { id: "resp_private", status: "completed", output: [] } },
    ].map(payload => `data: ${JSON.stringify(payload)}\n\n`).join("");
    const encoder = new TextEncoder();
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const config = deepseekConfig();

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    await response.text();
    await new Promise(resolve => setTimeout(resolve, 0));

    const line = getDebugLogEntries()
      .map(entry => entry.line)
      .find(entry => entry.startsWith("[ocx:openai-responses:inbound-sse-summary]"));
    expect(line).toBeDefined();
    expect(line).toContain('"response.reasoning_text.delta":1');
    expect(line).toContain('"phase":"commentary"');
    expect(line).toContain('"terminal":"completed"');
    expect(line).not.toContain(rawReasoning);
    expect(line).not.toContain(rawAssistant);
    expect(line).not.toContain("resp_private");
    expect(line).not.toContain("rs_private");

    const persisted = readFileSync(providerDebugLogPath(), "utf8");
    expect(persisted).toContain("inbound-sse-summary");
    expect(persisted).not.toContain(rawReasoning);
    expect(persisted).not.toContain(rawAssistant);
  });

  test("core JSON capture is pre-rewrite, excludes raw values, and ignores an untrusted content-type header", async () => {
    setDebugSettings({ debug: true });
    const rawReasoning = "json raw reasoning must not be retained";
    const rawAssistant = "json assistant text must not be retained";
    const contentType = `application/json; private=${"x".repeat(1024)}`;
    globalThis.fetch = (async () => Response.json({
      id: "resp_json_private",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_json_private",
          encrypted_content: "opaque_json_private",
          content: [{ type: "reasoning_text", text: rawReasoning }],
          summary: [],
        },
        {
          type: "message",
          id: "msg_json_private",
          role: "assistant",
          content: [{ type: "output_text", text: rawAssistant }],
        },
      ],
    }, { headers: { "content-type": contentType } })) as typeof fetch;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", input: "ping", stream: false }),
      }),
      deepseekConfig(),
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    await response.text();

    const payload = inboundDebugPayload("inbound-json-summary");
    expect(payload).toMatchObject({
      terminal: "completed",
      textBytes: {
        reasoningText: Buffer.byteLength(rawReasoning, "utf8"),
        outputText: Buffer.byteLength(rawAssistant, "utf8"),
      },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(rawReasoning);
    expect(serialized).not.toContain(rawAssistant);
    expect(serialized).not.toContain("resp_json_private");
    expect(serialized).not.toContain("opaque_json_private");
    expect(serialized).not.toContain(contentType);
    expect(serialized).not.toHaveProperty("contentType");
  });

  test("core records the terminal-repair source stream rather than its synthesized terminal", async () => {
    setDebugSettings({ debug: true });
    const rawReasoning = "terminal-repair raw reasoning";
    const frames = [
      { type: "response.created", response: { id: "resp_repaired", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_repaired", status: "in_progress", content: [], summary: [] } },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_repaired", status: "completed", content: [{ type: "reasoning_text", text: rawReasoning }], summary: [] } },
    ].map(payload => `data: ${JSON.stringify(payload)}\n\n`).join("");
    globalThis.fetch = (async () => new Response(frames, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", input: "ping", stream: true }),
      }),
      deepseekConfig(),
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    const clientWire = await response.text();
    expect(clientWire).toContain("response.completed");

    const payload = inboundDebugPayload("inbound-sse-summary");
    expect(payload).toMatchObject({ terminal: "none" });
    expect((payload.eventCounts as Record<string, number>)["response.completed"]).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(rawReasoning);
  });
});

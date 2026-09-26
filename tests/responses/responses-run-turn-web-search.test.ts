import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMeta, ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { isNonReplayableResponse } from "../../src/lib/upstream-retry";
import { createTranslatorBudget, type TranslatorBudget } from "../../src/lib/translator-budget";
import { saveCredential } from "../../src/oauth/store";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const resolver = await import("../../src/server/adapter-resolve");
const resolveAdapter = resolver.resolveAdapter;
let attempts: OcxParsedRequest[] = [];
let events: AdapterEvent[][] = [];
let onAttempt: ((index: number, parsed: OcxParsedRequest, incoming: IncomingMeta, emit: (event: AdapterEvent) => void) => void | Promise<void>) | undefined;
let onPacingSlotWait: (() => void | Promise<void>) | undefined;
function fixture(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "cursor",
    buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
    async *parseStream() { yield { type: "done" } as AdapterEvent; },
    async runTurn(parsed, incoming, emit) {
      const index = attempts.length;
      attempts.push(structuredClone(parsed));
      for (const event of events[index] ?? []) emit(event);
      await onAttempt?.(index, parsed, incoming, emit);
    },
  };
}
mock.module("../../src/server/adapter-resolve", () => ({ ...resolver,
  resolveAdapter: (provider: OcxProviderConfig, cache?: "none" | "short" | "long") =>
    provider.adapter === "cursor" ? fixture(provider) : resolveAdapter(provider, cache),
}));
const pacing = await import("../../src/providers/request-pacing");
const originalWaitForSlot = pacing.waitForProviderRequestSlot;
mock.module("../../src/providers/request-pacing", () => ({ ...pacing,
  waitForProviderRequestSlot: async (...args: Parameters<typeof originalWaitForSlot>) => {
    await onPacingSlotWait?.();
    return originalWaitForSlot(...args);
  },
}));
const { handleResponses } = await import("../../src/server/responses");
const originalHome = process.env.OPENCODEX_HOME;
let home = "";
let release: (() => void) | undefined;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-runturn-search-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearGenericFailoverHealth();
  attempts = [];
  onAttempt = undefined;
  onPacingSlotWait = undefined;
  for (let i = 0; i < 2; i++) await saveCredential("cursor", {
    access: `fixture-access-${i}`, refresh: `fixture-refresh-${i}`,
    expires: Date.now() + 3_600_000, accountId: `fixture-${i}`,
  });
});
afterEach(() => {
  release?.();
  clearGenericFailoverHealth();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});
async function run(stream: boolean, retry = false, media?: "image" | "video", search = true, comboAttempt = false, extraTools: unknown[] = [], stallTimeoutSec?: number, abortSignal?: AbortSignal, onResponse?: (response: Response) => void, translatorBudget?: TranslatorBudget) {
  const config = {
    port: 0, defaultProvider: "cursor", emptyCompletionRetry: retry,
    ...(stallTimeoutSec !== undefined ? { stallTimeoutSec } : {}),
    webSearchSidecar: { backend: "exa", exaApiKey: "fixture-search-key" },
    ...(media ? { images: { bridgeEnabled: media === "image", videoBridgeEnabled: media === "video" } } : {}),
    providers: {
      cursor: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", authMode: "oauth", models: ["model"] },
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "fixture-xai-key", models: ["fixture"] },
    },
  } as OcxConfig;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "cursor/model", input: "answer", stream,
      tools: [...(search ? [{ type: "web_search" }] : []), ...(media === "image" ? [{ type: "image_generation" }] : []), ...extraTools] }),
  }), config, { model: "", provider: "" }, { comboAttempt, abortSignal, translatorBudget });
  onResponse?.(response);
  return response.text();
}
for (const streaming of [true, false]) {
  test(`combo preflight sees repaired nested exec calls (stream=${streaming})`, async () => {
    events = [[
      { type: "tool_call_start", id: "nested", name: "web__run" },
      { type: "tool_call_delta", arguments: '{"search_query":[{"q":"fixture"}]}' },
      { type: "tool_call_end" },
      { type: "done" },
    ]];
    const tools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Run JavaScript" }] }];
    const output = await run(streaming, false, undefined, false, true, tools);
    expect(output).toContain('"name":"exec"');
    expect(output).not.toContain("undeclared_tool_call");
    expect(attempts).toHaveLength(1);
  });
  test(`combo preflight rejects malformed nested exec calls (stream=${streaming})`, async () => {
    events = [[
      { type: "tool_call_start", id: "nested", name: "web__run" },
      { type: "tool_call_delta", arguments: "{" },
      { type: "tool_call_end" },
      { type: "done" },
    ]];
    const tools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Run JavaScript" }] }];
    const output = await run(streaming, false, undefined, false, true, tools);
    expect(output).toContain("undeclared client tool");
    expect(output).toContain("web__run");
    expect(attempts).toHaveLength(1);
  });
  if (streaming) test("combo preflight bounds a silent partial nested exec call and releases its barrier", async () => {
    events = [[
      { type: "tool_call_start", id: "nested", name: "web__run" },
      { type: "tool_call_delta", arguments: '{"search_query":' },
    ]];
    const tools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Run JavaScript" }] }];
    const caller = new AbortController();
    let released!: () => void;
    const attemptReleased = new Promise<void>(resolve => { released = resolve; });
    let budget: IncomingMeta["translatorBudget"];
    let bytesWhileHeld = 0;
    onAttempt = async (_index, _parsed, incoming, emit) => {
      budget = incoming.translatorBudget;
      await new Promise(resolve => setTimeout(resolve, 25));
      bytesWhileHeld = budget?.snapshot().currentBytes ?? 0;
      await new Promise<void>(resolve => {
        if (incoming.abortSignal?.aborted) resolve();
        else incoming.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      emit({ type: "text_delta", text: "late output must not leak" });
      released();
    };
    const fallback = setTimeout(() => caller.abort(), 2_500);
    const started = Date.now();
    const sharedBudget = createTranslatorBudget();
    let status = 0;
    let replayable = true;
    try {
      const output = await run(true, false, undefined, false, true, tools, 1, caller.signal, response => {
        status = response.status;
        replayable = !isNonReplayableResponse(response);
      }, sharedBudget);
      await attemptReleased;
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(status).toBe(504);
      expect(replayable).toBe(false);
      expect(output).toContain("upstream_stall_timeout");
      expect(output).not.toContain("late output must not leak");
      expect(attempts).toHaveLength(1);
      expect(bytesWhileHeld).toBeGreaterThan(0);
      expect(budget?.snapshot().currentBytes).toBeLessThan(bytesWhileHeld);
    } finally {
      clearTimeout(fallback);
      caller.abort();
      sharedBudget.dispose();
    }
  }, 5_000);
  if (streaming) test("caller cancellation ends a partial nested exec preflight before its stall deadline", async () => {
    events = [[{ type: "tool_call_start", id: "nested", name: "web__run" }]];
    const tools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Run JavaScript" }] }];
    const caller = new AbortController();
    onAttempt = async (_index, _parsed, incoming) => {
      await new Promise<void>(resolve => {
        if (incoming.abortSignal?.aborted) resolve();
        else incoming.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const cancellation = setTimeout(() => caller.abort(), 25);
    try {
      const started = Date.now();
      const output = await run(true, false, undefined, false, true, tools, 1, caller.signal);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(output).toContain('"code":"client_cancelled"');
      expect(output).not.toContain("upstream_stall_timeout");
      expect(attempts).toHaveLength(1);
    } finally {
      clearTimeout(cancellation);
      caller.abort();
    }
  }, 5_000);
  test(`combo preflight permits the injected search tool (stream=${streaming})`, async () => {
    events = [[{ type: "tool_call_start", id: "search", name: "web_search" },
      { type: "tool_call_delta", arguments: '{"query":"fixture"}' }, { type: "tool_call_end" },
      { type: "error", message: "fixture terminal failure" }]];
    expect(await run(streaming, false, undefined, true, true)).toContain("fixture terminal failure");
    expect(attempts).toHaveLength(1);
  });
  for (const media of ["image", "video"] as const) {
    test(`search takes priority over ${media} bridge (stream=${streaming})`, async () => {
      events = [[{ type: "text_delta", text: "search-enabled answer" }, { type: "done" }]];
      expect(await run(streaming, false, media)).toContain("search-enabled answer");
      expect(attempts).toHaveLength(1);
      expect(attempts[0].context.tools?.some(t => t.webSearch)).toBe(true);
      // Hosted image tools are already normalized by the request parser;
      // video_gen, in contrast, is injected only by the media bridge.
      expect(attempts[0].context.tools?.some(t => t.name === "video_gen")).toBe(false);
    });
  }
  test(`translation budget bounds accumulated UTF-8 output (stream=${streaming})`, async () => {
    events = [Array.from({ length: 6 }, () => ({ type: "text_delta" as const, text: "中".repeat(2_000_000) }))];
    events[0].push({ type: "done" });
    const output = await run(streaming);
    expect(output).toContain("translation_buffer_limit");
    expect(attempts).toHaveLength(1);
  });
  test(`429 replay retains synthetic search and refreshes route scope (stream=${streaming})`, async () => {
    events = [[{ type: "error", status: 429, message: "Cursor rate limit exceeded: resource_exhausted" }],
      [{ type: "text_delta", text: "alternate answer" }, { type: "done" }]];
    expect(await run(streaming)).toContain("alternate answer");
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) expect(attempt.context.tools?.some(t => t.webSearch)).toBe(true);
    expect(attempts[1]._providerContinuationOwner?.credentialIdentity)
      .not.toBe(attempts[0]._providerContinuationOwner?.credentialIdentity);
  });
  test(`search request honors empty retry (stream=${streaming})`, async () => {
    events = [[{ type: "done" }], [{ type: "text_delta", text: "retried answer" }, { type: "done" }]];
    expect(await run(streaming, true)).toContain("retried answer");
    expect(attempts).toHaveLength(2);
    expect(attempts[1].context.tools?.some(t => t.webSearch)).toBe(true);
  });
}

test.each(["image", "video"] as const)("media-only %s bridge still injects its tool", async media => {
  events = [[{ type: "text_delta", text: "media answer" }, { type: "done" }]];
  expect(await run(true, false, media, false)).toContain("media answer");
  expect(attempts[0].context.tools?.some(t => t.name === `${media}_gen`)).toBe(true);
  expect(attempts[0].context.tools?.some(t => t.webSearch)).toBe(false);
});

// Streaming only: a first-event 429 replays the turn while the superseded
// attempt is still in-flight (the buffered path awaits it before collecting
// events, so the race cannot exist there). When that attempt finally returns,
// its copy-back must not restore the failed account's route state over the
// rotation's rebind.
test("superseded 429 attempt cannot restore stale route state", async () => {
  let releaseAttempt0!: () => void;
  const attempt0Gate = new Promise<void>(resolve => { releaseAttempt0 = resolve; });
  let gateReleasedByHook = false;
  onAttempt = async (index, parsed) => {
    if (index !== 0) return;
    // Bounded wait: a broken pacing hook must fail the test, not hang the file.
    await Promise.race([attempt0Gate, new Promise(r => setTimeout(r, 15_000))]);
    parsed._providerContinuationOwner = {
      version: 1, providerName: "cursor", providerDestinationIdentity: "stale",
      adapterName: "cursor", modelId: "model", credentialIdentity: "stale-superseded",
    };
  };
  // The replay's pacing-slot wait is the last hookable point before its
  // copy-in reads parsed. Releasing the superseded attempt here is not enough
  // on its own — its copy-back is still a few microtasks out — so the hook
  // yields a macrotask: attempt 0's runTurn return and copy-back settle before
  // the replay resumes and copies route state in.
  onPacingSlotWait = async () => {
    if (attempts.length < 1) return;
    gateReleasedByHook = true;
    releaseAttempt0();
    await new Promise(r => setTimeout(r, 0));
  };
  events = [
    [{ type: "error", status: 429, message: "Cursor rate limit exceeded: resource_exhausted" }],
    [{ type: "text_delta", text: "rotated answer" }, { type: "done" }],
  ];
  try {
    expect(await run(true)).toContain("rotated answer");
  } finally {
    onAttempt = undefined;
    onPacingSlotWait = undefined;
    releaseAttempt0();
  }
  expect(attempts).toHaveLength(2);
  expect(gateReleasedByHook).toBe(true);
  const owner = (parsed: OcxParsedRequest) => parsed._providerContinuationOwner?.credentialIdentity;
  expect(owner(attempts[1])).not.toBe(owner(attempts[0]));
  expect(owner(attempts[1])).not.toBe("stale-superseded");
});

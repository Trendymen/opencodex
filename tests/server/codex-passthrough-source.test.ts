import type { RouteDecisionTraceV1 } from "../../src/routing/trace";
import type { OcxConfig } from "../../src/types";
import { handleResponsesWithPolicyFallback } from "../../src/server/responses/policy-fallback";
import { describe, expect, test } from "bun:test";
import { readBoundedJsonRequestBody, type DecodedJsonCapture } from "../../src/server/request-decompress";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { retainCodexRequestSource, materializeCodexRequestSource, bindCodexRequestHistory, bindCodexRequestSourceItems,
  linkCodexRequestReplay, replayCodexSourceRecovery, recordCodexSourceRecovery, type CodexRequestSource } from "../../src/fork/codex-passthrough-source";
import { prepareCanonicalCodexRequest } from "../../src/fork/codex-passthrough-request";
import { resolveCodexPassthroughPermissions } from "../../src/fork/codex-passthrough-contract";
import { isBodyNonPersistable } from "../../src/responses/state";
import { createCodexPassthroughFixture, disabledCodexPassthrough } from "../helpers/codex-passthrough-fixture";
import { codexHeaders, encryptedInput, recoverySse, routedConfig } from "../helpers/agent-task-recovery";
import { recoverEncryptedAgentTaskWithResult, replaceTimedOutEncryptedAgentTaskWithNotice, resetAgentTaskRecoveryState } from "../../src/server/responses/agent-task-recovery";
import { concreteComboRequestBody } from "../../src/combos";
import { finalizeAccountLease, finalizeOwnedTranslatorBudget } from "../../src/server/responses/core-lifetime";
import { handleResponses } from "../../src/server/responses/core";
import { CODEX_PASSTHROUGH_DEFAULTS } from "../../src/fork/codex-passthrough-contract";
import { markCodexPassthroughResponse, codexPassthroughResponsePermissions, captureCodexPassthroughTurn,
  retainCodexPassthroughTurnSource, materializeCodexPassthroughTurnSource, releaseCodexPassthroughTurnSource, resolveCodexPassthroughAttempt } from "../../src/fork/codex-passthrough-turn";
import { markResponseNonReplayable, isNonReplayableResponse, markReplayRefusalResponse, isReplayRefusalResponse } from "../../src/lib/upstream-retry";

describe("Codex decoded source ownership", () => {
  for (const kind of ["recovered", "notice"] as const) test(`protected ${kind} edits survive cache reset without restoring unrelated input changes`, async () => {
    resetAgentTaskRecoveryState();
    const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream: async () => new Response(recoverySse("exact recovered payload"),
      { headers: { "content-type": "text/event-stream" } }) });
    const budget = createTranslatorBudget(); let source!: CodexRequestSource;
    const config = routedConfig(); const headers = codexHeaders();
    const input = kind === "notice" ? JSON.parse(JSON.stringify(encryptedInput({ taskName: "/root", sender: "/root/worker" })).replace("Message Type: NEW_TASK", "Message Type: MESSAGE"))
      : encryptedInput();
    const raw = { model: "gpt-5.6-sol", input: [...structuredClone(input), ...structuredClone(input)], unknown: [3, 1, 2] };
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers, body: JSON.stringify(raw) });
    try {
      const body = await readBoundedJsonRequestBody(req, 100_000, budget, { onDecodedJson(capture) { source = retainCodexRequestSource(capture, budget); } }) as any;
      body.input[1].unrelated = "only the old prepared view"; const before = budget.snapshot().currentBytes;
      if (kind === "notice") expect(replaceTimedOutEncryptedAgentTaskWithNotice(req, body.input, {}, config)).toBe(true);
      else expect((await recoverEncryptedAgentTaskWithResult(req, body.input, {}, config)).recovered).toBe(true);
      expect(budget.snapshot().currentBytes).toBeGreaterThan(before);
      resetAgentTaskRecoveryState();
      const prepared = await prepareCanonicalCodexRequest(source, resolveCodexPassthroughPermissions(disabledCodexPassthrough()), {
        req, config, translatorBudget: budget, logCtx: { model: "", provider: "" },
        route: { provider: config.providers.openai!, providerName: "openai", modelId: raw.model } as any,
        skillsScopeKey: undefined, adoptParsedRequest() {},
      });
      const delivered = prepared.body as any;
      expect(delivered.input[0]).toEqual(raw.input[0]); expect(delivered.unknown).toEqual([3, 1, 2]);
      expect(delivered.input[1].type).toBe("message"); expect(delivered.input[1].role).toBe("user");
      expect(delivered.input[1]).not.toHaveProperty("unrelated");
      expect(JSON.stringify(delivered.input[1])).toContain(kind === "notice" ? "重新发送" : "exact recovered payload");
      expect(isBodyNonPersistable(prepared.body)).toBe(true);
      expect(fixture.seen.length).toBe(kind === "notice" ? 0 : 1);
      const lateTarget = (materializeCodexRequestSource(source, budget).body as any).input[1];
      source.release(); const afterRelease = budget.snapshot().currentBytes;
      recordCodexSourceRecovery(lateTarget, { retainedBytes: 100, apply: () => true });
      expect(budget.snapshot().currentBytes).toBe(afterRelease);
    } finally { source?.release(); budget.dispose(); resetAgentTaskRecoveryState(); await fixture.close(); }
  });

  test("combo decoded history retains provenance after filtering a raw compaction item", async () => {
    resetAgentTaskRecoveryState();
    const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream: async () => new Response(recoverySse("history recovery"),
      { headers: { "content-type": "text/event-stream" } }) });
    const budget = createTranslatorBudget(); let source!: CodexRequestSource; let otherSource!: CodexRequestSource;
    const raw = { model: "gpt-5.6-sol", previous_response_id: "resp_history_origin", input: [{ type: "compaction_trigger" }, ...encryptedInput()] };
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: codexHeaders(), body: JSON.stringify(raw) });
    try {
      const body = await readBoundedJsonRequestBody(req, 100_000, budget, { onDecodedJson(capture) { source = retainCodexRequestSource(capture, budget); } }) as any;
      const history = encryptedInput()[0]; const expanded = { ...body, input: [history, ...body.input] };
      bindCodexRequestHistory(source, expanded);
      const other = await readBoundedJsonRequestBody(new Request(req.url, { method: "POST", body: JSON.stringify(raw) }), 100_000, budget, {
        onDecodedJson(capture) { otherSource = retainCodexRequestSource(capture, budget); },
      }) as any;
      const otherExpanded = { ...other, input: [history, ...other.input] }; bindCodexRequestHistory(otherSource, otherExpanded);
      const childSource = { ...expanded, input: expanded.input.filter((item: any) => item.type !== "compaction_trigger") };
      const childBody = concreteComboRequestBody(childSource, { provider: "openai", model: raw.model }, null, undefined);
      const child = new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(childBody) });
      linkCodexRequestReplay(source, child, childSource);
      const decoded = await readBoundedJsonRequestBody(child, 100_000, budget, {
        onDecodedJson(capture) { bindCodexRequestSourceItems(source, capture.value, child); },
      }) as any;
      expect((await recoverEncryptedAgentTaskWithResult(child, [decoded.input[0]], {}, routedConfig())).recovered).toBe(true);
      expect((history as { type: string }).type).toBe("agent_message");
      expect(otherExpanded.input[0].type).toBe("agent_message");
      expect(replayCodexSourceRecovery(otherSource, otherExpanded, true)).toBe(false);
      resetAgentTaskRecoveryState();
      const unexpanded = materializeCodexRequestSource(source, budget);
      expect(replayCodexSourceRecovery(source, unexpanded.body, false)).toBe(false); expect(unexpanded.body).toEqual(raw);
      const replay = materializeCodexRequestSource(source, budget).body as any;
      replay.input = [structuredClone(history), ...replay.input]; bindCodexRequestHistory(source, replay);
      expect(replayCodexSourceRecovery(source, replay, true)).toBe(true);
      expect(JSON.stringify(replay.input[0])).toContain("history recovery");
      expect(replay.input.slice(1)).toEqual(raw.input); expect(fixture.seen).toHaveLength(1);
      const mismatched = materializeCodexRequestSource(source, budget).body;
      expect(() => replayCodexSourceRecovery(source, mismatched, true)).toThrow("Recovered Codex request input is unavailable");
    } finally { source?.release(); otherSource?.release(); budget.dispose(); resetAgentTaskRecoveryState(); await fixture.close(); }
  });

  for (const encoding of ["identity", "gzip", "zstd"]) {
    test(`decoded_text_lease_is_transferred_and_released_once (${encoding})`, async () => {
      const text = '{"input":[{"content":"原文"}],"n":1e-7,"unknown":{"order":[2,1]}}';
      const bytes = new TextEncoder().encode(text);
      const wire = encoding === "gzip" ? Bun.gzipSync(bytes) : encoding === "zstd" ? Bun.zstdCompressSync(bytes) : bytes;
      let reads = 0;
      const stream = new ReadableStream<Uint8Array>({ start(controller) { reads++; controller.enqueue(wire); controller.close(); } });
      const req = new Request("http://localhost/v1/responses", { method: "POST", body: stream, headers: { "content-encoding": encoding } });
      const budget = createTranslatorBudget();
      let source!: CodexRequestSource;
      let capture!: DecodedJsonCapture;
      const body = await readBoundedJsonRequestBody(req, 1024, budget, { onDecodedJson(value) { capture = value; source = retainCodexRequestSource(value, budget); } }) as { input: { content: string }[] };
      body.input[0]!.content = "mutated";
      expect(reads).toBe(1);
      expect(capture.jsonText).toBe(text);
      expect(capture.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(JSON.parse(text))));
      expect(budget.snapshot().currentBytes).toBe(capture.textBytes + capture.serializedBytes);
      const copy = materializeCodexRequestSource(source, budget);
      expect(copy.body).toEqual(JSON.parse(text));
      expect(budget.snapshot().currentBytes).toBe(capture.textBytes + 2 * capture.serializedBytes);
      copy.release(); copy.release(); source.release(); source.release();
      expect(budget.snapshot().currentBytes).toBe(capture.serializedBytes);
      budget.dispose();
    });
  }

  test("accepted source above 32 MiB keeps the existing admission limit", async () => {
    const text = JSON.stringify({ input: "x".repeat(33 * 1024 * 1024) });
    const budget = createTranslatorBudget();
    let source!: CodexRequestSource;
    try {
      await readBoundedJsonRequestBody(new Request("http://localhost/v1/responses", { method: "POST", body: text }), 40 * 1024 * 1024, budget, {
        onDecodedJson(capture) { source = retainCodexRequestSource(capture, budget); },
      });
      const copy = materializeCodexRequestSource(source, budget);
      expect((copy.body as { input: string }).input.length).toBe(33 * 1024 * 1024);
      expect(budget.snapshot().overflows).toBe(0);
      source.release();
      expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(text));
    } finally { source?.release(); budget.dispose(); }
  });

  test("callback and parse failures release reader leases; failed materialization returns its copy lease", async () => {
    const budget = createTranslatorBudget();
    await expect(readBoundedJsonRequestBody(new Request("http://localhost", { method: "POST", body: "{" }), 1024, budget)).rejects.toThrow();
    expect(budget.snapshot().currentBytes).toBe(0);
    let source!: CodexRequestSource;
    await expect(readBoundedJsonRequestBody(new Request("http://localhost", { method: "POST", body: "{}" }), 1024, budget, {
      onDecodedJson(capture) { source = retainCodexRequestSource(capture, budget); throw new Error("capture failed"); },
    })).rejects.toThrow("capture failed");
    source.release();
    expect(budget.snapshot().currentBytes).toBe(2);
    let releases = 0;
    const invalid = retainCodexRequestSource({ value: {}, jsonText: "{", textBytes: 1, serializedBytes: 2, takeTextLease: () => () => { releases++; } }, budget);
    const before = budget.snapshot().currentBytes;
    expect(() => materializeCodexRequestSource(invalid, budget)).toThrow();
    expect(budget.snapshot().currentBytes).toBe(before);
    invalid.release(); invalid.release(); expect(releases).toBe(1);
    budget.dispose();
  });

  test("turn source survives child reads and releases copies on exhausted fallback or cancellation", async () => {
    const budget = createTranslatorBudget();
    const turn = captureCodexPassthroughTurn({}, "responses");
    for (const text of ['{"original":true}', '{"child":true}']) {
      await readBoundedJsonRequestBody(new Request("http://localhost", { method: "POST", body: text }), 1024, budget, {
        onDecodedJson(capture) { retainCodexPassthroughTurnSource(turn, capture, budget); },
      });
    }
    const copy = materializeCodexPassthroughTurnSource(turn, budget);
    expect(copy.body).toEqual({ original: true });
    releaseCodexPassthroughTurnSource(turn); releaseCodexPassthroughTurnSource(turn);
    copy.release();
    expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength('{"original":true}') + Buffer.byteLength('{"child":true}'));
    expect(() => materializeCodexPassthroughTurnSource(turn, budget)).toThrow("Codex request source is unavailable");
    const cancelled = captureCodexPassthroughTurn({}, "responses");
    releaseCodexPassthroughTurnSource(cancelled);
    await readBoundedJsonRequestBody(new Request("http://localhost", { method: "POST", body: "{}" }), 1024, budget, {
      onDecodedJson(capture) { retainCodexPassthroughTurnSource(cancelled, capture, budget); },
    });
    expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength('{"original":true}') + Buffer.byteLength('{"child":true}') + 2);
    budget.dispose();
  });

  test("response EOF, reader errors and cancellation release ownership and preserve internal markers", async () => {
    for (const ending of ["eof", "error", "cancel"]) {
      let released = 0;
      const original = markCodexPassthroughResponse(new Response(new ReadableStream<Uint8Array>({
        pull(controller) { if (ending === "error") controller.error(new Error("reader failed")); else if (ending === "eof") controller.close(); },
      })), CODEX_PASSTHROUGH_DEFAULTS);
      markResponseNonReplayable(original); markReplayRefusalResponse(original);
      const budget = createTranslatorBudget();
      const wrapped = finalizeAccountLease(finalizeOwnedTranslatorBudget(original, budget), () => { released++; });
      expect(codexPassthroughResponsePermissions(wrapped)).toBe(CODEX_PASSTHROUGH_DEFAULTS);
      expect(isNonReplayableResponse(wrapped)).toBe(true);
      expect(isReplayRefusalResponse(wrapped)).toBe(true);
      if (ending === "cancel") await wrapped.body!.cancel();
      else if (ending === "error") await expect(wrapped.text()).rejects.toThrow("reader failed");
      else await wrapped.text();
      expect(released).toBe(1);
      budget.dispose();
    }
  });

  test("source cancel cleanup keeps the serving-account release after producer shutdown", async () => {
    let finish!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const cancellingStarted = new Promise<void>(resolve => { started = resolve; });
    let sourceReleases = 0;
    let accountReleases = 0;
    const response = finalizeAccountLease(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([120])); },
      cancel() { started(); return held; },
    })), () => { accountReleases++; }, () => { sourceReleases++; });
    await Bun.sleep(0);
    const cancelling = response.body!.cancel();
    try {
      await cancellingStarted;
      expect(sourceReleases).toBe(1);
      expect(accountReleases).toBe(0);
    } finally { finish(); await cancelling; }
    expect(accountReleases).toBe(1);
  });

  test("core releases its source after preparation refusal and abort with an externally owned budget", async () => {
    for (const ending of ["eof", "cancel", "abort"]) {
      const budget = createTranslatorBudget();
      const controller = new AbortController();
      const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", body: "{}", signal: controller.signal }),
        { port: 10100, defaultProvider: "missing", providers: {} }, { model: "", provider: "" }, { translatorBudget: budget });
      expect(response.status).toBe(400);
      if (ending === "eof") await response.text();
      else if (ending === "cancel") await response.body!.cancel();
      else { controller.abort(); await response.body!.cancel(); }
      expect(budget.snapshot().currentBytes).toBe(2);
      budget.dispose();
    }
  });
});

const policyCanonical = { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" };

test("same policy ingress keeps source and permission after paused first leg", async () => {
 const budget = createTranslatorBudget();
 const config: OcxConfig = { port: 0, defaultProvider: "third", providers: {
  third: { adapter: "openai-responses", authMode: "key", baseUrl: "https://third.example.test/v1" },
  renamed: { ...policyCanonical, codexPassthrough: { bridgeLiteMetadata: false } },
 }};
 const holders: unknown[] = []; const values: unknown[] = [];
 const trace = { version: 1, decisionId: "synthetic", createdAt: 1, requestedModel: "policy/daily", routeKind: "policy", profile: { id: "daily", revision: "1" }, requirements: [],
  candidates: [{ provider: "third", model: "model-a", eligible: true, exclusions: [], score: { total: 2, components: {} } }, { provider: "renamed", model: "gpt-5.6-sol", eligible: true, exclusions: [], score: { total: 1, components: {} } }],
  selected: { candidateIndex: 0, provider: "third", model: "model-a", reason: "highest-score" } };
 let calls = 0;
 try {
  const response = await handleResponsesWithPolicyFallback(new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "policy/daily", input: "original" }) }), config, { model: "", provider: "" }, { translatorBudget: budget }, {
   runCore: async (req, current, log, options = {}) => {
    calls++;
    const turn = options.codexPassthroughTurn ?? captureCodexPassthroughTurn(current.providers, "responses");
    holders.push(turn);
    const body = await readBoundedJsonRequestBody(req, 1024, budget, { onDecodedJson: capture => retainCodexPassthroughTurnSource(turn, capture, budget) });
    options.onRequestBodyParsed?.(body); log.routeDecision = trace as RouteDecisionTraceV1;
    values.push(resolveCodexPassthroughAttempt(turn, { providerName: "renamed", provider: current.providers.renamed!, inboundWire: "responses" })?.bridgeLiteMetadata);
    expect(materializeCodexPassthroughTurnSource(turn, budget).body).toEqual({ model: "policy/daily", input: "original" });
    if (calls === 1) { current.providers.renamed!.codexPassthrough!.bridgeLiteMetadata = true; return Response.json({ error: { code: "unsupported_model" } }, { status: 400 }); }
    return Response.json({ status: "completed" });
   },
  });
  await response.text();
  expect(calls).toBe(2); expect(holders[1]).toBe(holders[0]); expect(values).toEqual([false, false]);
 } finally { budget.dispose(); }
});

test("already aborted external signal does not retain decoded source", async () => {
 const budget=createTranslatorBudget(); const abort=new AbortController();abort.abort();
 try {
  const response=await handleResponses(new Request("http://localhost/v1/responses", {method:"POST",body:"{}"}), {port:0,defaultProvider:"missing",providers:{}}, {model:"",provider:""}, {translatorBudget:budget,abortSignal:abort.signal});
  expect(response.status).toBe(400);
  expect(budget.snapshot().currentBytes).toBe(2);
  await response.text();
 } finally { budget.dispose(); }
});

test("source release precedes a stalled producer cancel", async () => {
 const budget=createTranslatorBudget();let finish!:()=>void;let cancelStarted!:()=>void;
 const held=new Promise<void>(resolve=>{finish=resolve});const started=new Promise<void>(resolve=>{cancelStarted=resolve});
 let turn: ReturnType<typeof captureCodexPassthroughTurn>;
 let cancelling: Promise<void>|undefined;
 try {
  const response=await handleResponsesWithPolicyFallback(new Request("http://localhost/v1/responses",{method:"POST",body:"{}"}), {port:0,defaultProvider:"missing",providers:{}}, {model:"",provider:""}, {translatorBudget:budget}, {
   runCore:async(req,config,_log,options={})=>{
    turn=options.codexPassthroughTurn??captureCodexPassthroughTurn(config.providers,"responses");
    await readBoundedJsonRequestBody(req,1024,budget,{onDecodedJson:capture=>retainCodexPassthroughTurnSource(turn,capture,budget)});
    return new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([120]));},cancel(){cancelStarted();return held}}));
   },
  });
  cancelling=response.body!.cancel();await started;
  expect(budget.snapshot().currentBytes).toBe(2);
 } finally {finish();await cancelling;budget.dispose()}
});

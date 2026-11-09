/**
 * Codex 0.164 request compatibility (openai/codex 816fa702..af91f6ef2c).
 *
 * prompt_cache_key policy (openai/codex#55587): a host keeps the session-derived key, sends a
 * Custom key, or Omits the field. Session and thread headers do not change with the policy, and
 * sub-agents inherit it. The key is a cache hint only: an omitted or custom key must reach the
 * wire exactly as sent, and must not move conversation identity, lineage, or cache diagnostics.
 *
 * configuration_update (ResponseItem::ConfigurationUpdate): a positional reasoning-effort control.
 * OpenAI-operated destinations receive it verbatim and in order; other Responses gateways and
 * translated routes drop it without failing the request or turning it into a message.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexConversationIdentity } from "../../src/codex/lineage";
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
import { parseRequest } from "../../src/responses/parser";
import { handleResponses, hasUnreadableEncryptedAgentTask } from "../../src/server/responses";
import { createServeOptions } from "../../src/server/index/serve-options";
import { recoverEncryptedAgentTaskWithResult, resetAgentTaskRecoveryState } from "../../src/server/responses/agent-task-recovery";
import { addFinalRequestLog, clearRequestLogsForTests, getRequestLogEntries, type RequestLogContext } from "../../src/server/request-log";
import { readUsageEntries, usageLogPath } from "../../src/usage/log";
import { normalizeSessionEffortObservation, observeSessionEffort } from "../../src/usage/session-effort-observation";
import { clearResponseStateForTests, flushResponseState, rememberResponseState } from "../../src/responses/state";
import { appendFinalCacheDiagnostic, cacheDiagnosticPath } from "../../src/usage/cache-diagnostic";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { encryptedInput, routedConfig } from "../helpers/agent-task-recovery";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const CANONICAL = "https://chatgpt.com/backend-api/codex";
const SESSION = "sess-0164-root";
const ROOT_THREAD = "thread-0164-root";
const CHILD_THREAD = "thread-0164-child";
const CONFIG_UPDATE = { type: "configuration_update", reasoning: { effort: "high" } };
const IDENTITY_HEADERS = ["session-id", "session_id", "thread-id", "x-codex-parent-thread-id"];

let isolated: IsolatedCodexHome;
let home: string;
let previousHome: string | undefined;
let previousCacheDebug: string | undefined;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  isolated = installIsolatedCodexHome("ocx-0164-codex-");
  previousHome = process.env.OPENCODEX_HOME;
  previousCacheDebug = process.env.OPENCODEX_CACHE_DEBUG;
  home = mkdtempSync(join(tmpdir(), "ocx-0164-home-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearRequestLogsForTests();
  globalThis.fetch = originalFetch;
  isolated.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCacheDebug === undefined) delete process.env.OPENCODEX_CACHE_DEBUG;
  else process.env.OPENCODEX_CACHE_DEBUG = previousCacheDebug;
  removeTreeWithRetry(home);
});

interface Wire { url: string; headers: Headers; body: Record<string, unknown> }

const RESPONSES_SSE = "data: " + JSON.stringify({ type: "response.completed", response: {
  id: "resp_0164", object: "response", status: "completed", output: [],
  usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
} }) + "\n\ndata: [DONE]\n\n";
const CHAT_SSE = [
  { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
  { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } },
].map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n";

function captureWire(): Wire[] {
  const seen: Wire[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(url.includes("/chat/completions") ? CHAT_SSE : RESPONSES_SSE, {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return seen;
}

function config(provider: Partial<OcxProviderConfig>): OcxConfig {
  return {
    defaultProvider: "p",
    openaiProviderTierVersion: 2,
    providers: { p: { adapter: "openai-responses", models: ["gpt-5.6-luna"], ...provider } },
  } as unknown as OcxConfig;
}

const canonical = (): OcxConfig => config({ authMode: "forward", codexAccountMode: "direct", baseUrl: CANONICAL });

function user(text: string): Record<string, unknown> {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

async function drive(
  cfg: OcxConfig,
  model: string,
  input: unknown[],
  options: { headers?: Record<string, string>; promptCacheKey?: string; reasoning?: unknown; previousResponseId?: string; clientInitialResponses?: boolean; finalizeLog?: boolean } = {},
): Promise<{ status: number; logCtx: RequestLogContext; text: string }> {
  const token = fakeChatGptJwt({ chatgpt_account_id: "acct-0164", exp: Math.floor(Date.now() / 1000) + 86_400 });
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
      "chatgpt-account-id": "acct-0164",
      ...options.headers,
    },
    body: JSON.stringify({
      model, input, stream: true, store: false,
      ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      ...(options.previousResponseId === undefined ? {} : { previous_response_id: options.previousResponseId }),
      ...(options.promptCacheKey === undefined ? {} : { prompt_cache_key: options.promptCacheKey }),
    }),
  }), cfg, logCtx, { clientInitialResponses: options.clientInitialResponses });
  const text = await response.text();
  if (options.finalizeLog) addFinalRequestLog("initial-effort-fixture", Date.now(), logCtx, response.status);
  return { status: response.status, logCtx, text };
}

function httpRouter(cfg: OcxConfig) {
  const options = createServeOptions({
    config: cfg, deps: {}, managementApiDeps: {}, ingressForServer: () => "public",
    packageTreeIntegrity: { status: () => ({ ok: true }) },
    runAdmittedHttpTurn: (_req: Request, _policy: unknown, work: () => Promise<Response>) => work(),
  } as unknown as Parameters<typeof createServeOptions>[0]);
  const server = { timeout() {} } as unknown as Parameters<typeof options.fetch>[1];
  return (body: Record<string, unknown>) => options.fetch(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), server);
}

function identityOf(wire: Wire): Record<string, string | null> {
  return Object.fromEntries(IDENTITY_HEADERS.map(name => [name, wire.headers.get(name)]));
}

const rootHeaders = { "session-id": SESSION, "thread-id": ROOT_THREAD };
const childHeaders = { "session-id": SESSION, "thread-id": CHILD_THREAD, "x-codex-parent-thread-id": ROOT_THREAD };

describe("prompt_cache_key policy (openai/codex#55587)", () => {
  const policies = [
    { name: "SessionDerived", key: SESSION },
    { name: "Custom", key: "host-chosen-cache-key" },
    { name: "Omit", key: undefined },
  ] as const;

  test("native passthrough sends each policy verbatim and keeps session/thread identity", async () => {
    const seen = captureWire();
    const conversationIds: Array<string | undefined> = [];
    for (const policy of policies) {
      const { status, logCtx } = await drive(canonical(), "p/gpt-5.6-luna", [user("ping")], {
        headers: rootHeaders, promptCacheKey: policy.key,
      });
      expect(status).toBe(200);
      conversationIds.push(logCtx.conversationId);
    }
    expect(seen).toHaveLength(3);
    for (const [index, policy] of policies.entries()) {
      const wire = seen[index]!;
      expect(wire.url).toBe(CANONICAL + "/responses");
      expect(Object.hasOwn(wire.body, "prompt_cache_key")).toBe(policy.key !== undefined);
      expect(wire.body.prompt_cache_key).toBe(policy.key);
      // The policy controls the body only; the identity headers are the same on every request.
      expect(identityOf(wire)).toEqual(identityOf(seen[0]!));
    }
    expect(identityOf(seen[0]!)).toMatchObject({ "session-id": SESSION, "thread-id": ROOT_THREAD });
    // A custom or missing key is not a conversation change in Logs.
    expect(conversationIds[0]).toBeString();
    expect(new Set(conversationIds).size).toBe(1);
  }, 20_000);

  test("a sub-agent that inherits Omit keeps its headers, lineage cohort, and log identity", async () => {
    const seen = captureWire();
    const withKey = await drive(canonical(), "p/gpt-5.6-luna", [user("child task")], {
      headers: childHeaders, promptCacheKey: SESSION,
    });
    const omitted = await drive(canonical(), "p/gpt-5.6-luna", [user("child task")], { headers: childHeaders });
    expect([withKey.status, omitted.status]).toEqual([200, 200]);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body).not.toHaveProperty("prompt_cache_key");
    expect(identityOf(seen[1]!)).toEqual(identityOf(seen[0]!));
    expect(identityOf(seen[1]!)).toMatchObject({
      "session-id": SESSION, "thread-id": CHILD_THREAD, "x-codex-parent-thread-id": ROOT_THREAD,
    });
    expect(omitted.logCtx.conversationId).toBe(withKey.logCtx.conversationId);

    // Lineage and pool affinity read the headers the child actually sent; with the key omitted the
    // child still joins its root's cohort instead of splitting off.
    const root = new Headers(rootHeaders);
    const child = new Headers(childHeaders);
    expect(codexPoolAffinityKey(child)).toBe(codexPoolAffinityKey(root));
    expect(codexConversationIdentity(child)?.conversationKey)
      .toBe(codexConversationIdentity(root)?.conversationKey);
  }, 20_000);

  test("translated Chat route forwards Custom verbatim and omits the field under Omit", async () => {
    const seen = captureWire();
    const chat = config({
      adapter: "openai-chat", authMode: "key", apiKey: "chat-key", baseUrl: "https://chat.example/v1",
      promptCacheKey: true, models: ["m"],
    } as Partial<OcxProviderConfig>);
    for (const key of ["host-chosen-cache-key", undefined]) {
      const { status } = await drive(chat, "p/m", [user("ping")], { headers: rootHeaders, promptCacheKey: key });
      expect(status).toBe(200);
    }
    expect(seen.map(wire => wire.url)).toEqual(Array(2).fill("https://chat.example/v1/chat/completions"));
    expect(seen[0]!.body.prompt_cache_key).toBe("host-chosen-cache-key");
    expect(seen[1]!.body).not.toHaveProperty("prompt_cache_key");
  }, 20_000);

  test("cache diagnostics record an omitted key as absent, never as a mismatch", async () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    captureWire();
    for (const [index, policy] of policies.entries()) {
      const { logCtx } = await drive(canonical(), "p/gpt-5.6-luna", [user("ping")], {
        headers: rootHeaders, promptCacheKey: policy.key,
      });
      expect(logCtx.cacheDiagnosticDraft).toBeDefined();
      appendFinalCacheDiagnostic({
        requestId: "req-0164-" + index, protocol: "responses", provider: "p", model: "gpt-5.6-luna",
        cacheProvenance: "observed", draft: logCtx.cacheDiagnosticDraft,
      });
    }
    const records = readFileSync(cacheDiagnosticPath(), "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as { promptCacheKey: Record<string, unknown>; session: Record<string, unknown> });
    expect(records).toHaveLength(3);
    const [derived, custom, omitted] = records;
    for (const record of [derived!, custom!]) {
      expect(record.promptCacheKey).toMatchObject({
        inbound: { present: true, source: "caller" }, outbound: { present: true, source: "caller" }, equal: true,
      });
    }
    expect(omitted!.promptCacheKey).toEqual({ inbound: { present: false }, outbound: { present: false } });
    // The session header is the identity signal, and it is the same under every policy.
    expect(new Set(records.map(record => JSON.stringify(record.session))).size).toBe(1);
  }, 20_000);
});

describe("configuration_update input item", () => {
  const input = () => [user("one"), structuredClone(CONFIG_UPDATE), user("two")];
  const provenance = { content_item_metadata: [{ source: "user" }] };

  test("observation follows only direct updates in initial input, in order", () => {
    const update = (value: unknown) => ({ type: "configuration_update", reasoning: { effort: value } });
    const read = (input: unknown[], reasoning: unknown = { effort: "high" }) => observeSessionEffort({ input, reasoning });
    expect(read([update("low"), user("x"), update("max")])).toEqual({ clientEffort: "high", sessionEffort: "max", status: "visible" });
    expect(read([update("max"), { type: "configuration_update" }])).toEqual({ clientEffort: "high", sessionEffort: "unknown", status: "unrecognized" });
    expect(read([update("ultra"), update("low")])).toEqual({ clientEffort: "high", sessionEffort: "low", status: "visible" });
    for (const top of [undefined, null, { effort: "ultra" }, { effort: "private-canary" }]) {
      expect(observeSessionEffort({ input: [update("max")], reasoning: top })).toEqual({ clientEffort: "unknown", sessionEffort: "max", status: "visible" });
    }
    expect(observeSessionEffort({ input: [], reasoning: { effort: "high" } })).toBeUndefined();
    expect(observeSessionEffort({ previous_response_id: "fixture", input: [], reasoning: { effort: "high" } }))
      .toEqual({ clientEffort: "high", sessionEffort: "unknown", status: "not_in_input" });
    expect(observeSessionEffort({ input: [user(JSON.stringify(update("max")))] })).toBeUndefined();
    for (const value of [null, {}, { clientEffort: "secret", sessionEffort: "max", status: "visible" },
      { clientEffort: "high", sessionEffort: "unknown", status: "visible" },
      { clientEffort: "high", sessionEffort: "max", status: "not_in_input" }]) {
      expect(normalizeSessionEffortObservation(value)).toBeUndefined();
    }
    expect(normalizeSessionEffortObservation({ clientEffort: "high", sessionEffort: "max", status: "visible", secret: "private" }))
      .toEqual({ clientEffort: "high", sessionEffort: "max", status: "visible" });
  });

  test("conversation continuation requires a non-empty string ID and keeps update precedence", () => {
    const update = { type: "configuration_update", reasoning: { effort: "max" } };
    const unknown = { clientEffort: "high", sessionEffort: "unknown", status: "not_in_input" };
    const visible = { clientEffort: "high", sessionEffort: "max", status: "visible" };
    for (const conversation of [" fixture-conversation ", { id: " fixture-conversation " }]) {
      const body = { conversation, reasoning: { effort: "high" }, input: [user("hello")] };
      expect(observeSessionEffort(body)).toEqual(unknown);
      for (const previous_response_id of [null, "", " \t ", 0]) {
        expect(observeSessionEffort({ ...body, previous_response_id })).toEqual(unknown);
      }
      expect(observeSessionEffort({ ...body, input: [update, user("hello")] })).toEqual(visible);
      expect(observeSessionEffort({ ...body, input: [{ type: "configuration_update" }] })).toEqual({
        clientEffort: "high", sessionEffort: "unknown", status: "unrecognized",
      });
    }
    for (const conversation of [undefined, null, "", " \t ", false, 0, [], ["fixture"], {},
      { id: "" }, { id: " \n " }, { id: null }, { id: 0 }, { id: [] }, { id: {} }]) {
      const body = { conversation, reasoning: { effort: "high" }, input: [user("hello")] };
      expect(observeSessionEffort(body)).toBeUndefined();
      expect(observeSessionEffort({ ...body, input: [update] })).toEqual(visible);
      expect(observeSessionEffort({ ...body, previous_response_id: "previous-fixture" })).toEqual(unknown);
    }
  });

  test("existing previous response continuation does not read conversation", () => {
    const body = { previous_response_id: "previous-fixture", input: [],
      get conversation(): never { throw new Error("unexpected conversation read"); } };
    expect(observeSessionEffort(body)).toEqual({ clientEffort: "unknown", sessionEffort: "unknown", status: "not_in_input" });
  });

  for (const { name, conversation, valid } of [
    { name: "string", conversation: " fixture-conversation-string ", valid: true },
    { name: "object", conversation: { id: " fixture-conversation-object ", extra: "private-canary" }, valid: true },
    { name: "empty string", conversation: "  ", valid: false },
    { name: "empty object ID", conversation: { id: "  " }, valid: false },
    { name: "non-string object ID", conversation: { id: 7 }, valid: false },
    { name: "null", conversation: null, valid: false },
    { name: "array", conversation: ["fixture-conversation"], valid: false },
  ]) test(`HTTP conversation ${name} records only a bounded initial observation`, async () => {
    const seen = captureWire();
    const cfg = config({ authMode: "key", apiKey: "fixture-key", baseUrl: "https://api.openai.com/v1" });
    const post = httpRouter(cfg);
    for (const withUpdate of [false, true]) {
      const input = [...(withUpdate ? [{ type: "configuration_update", reasoning: { effort: "max" } }] : []), user("hello")];
      const body = { model: "p/gw-model", stream: true, store: false, input, reasoning: { effort: "high" }, conversation };
      const response = await post(body);
      expect(response.status).toBe(200);
      await response.text();
      const expected = withUpdate ? { clientEffort: "high", sessionEffort: "max", status: "visible" }
        : valid ? { clientEffort: "high", sessionEffort: "unknown", status: "not_in_input" } : undefined;
      expect(seen.at(-1)?.body.conversation).toEqual(conversation);
      expect(seen.at(-1)?.body.input).toEqual(input);
      const memory = getRequestLogEntries().at(-1)?.sessionEffortObservation;
      const persisted = readUsageEntries().at(-1)?.sessionEffortObservation;
      expect(memory).toEqual(expected);
      expect(persisted).toEqual(expected);
      expect(JSON.stringify([memory, persisted])).not.toContain("fixture-conversation");
      expect(JSON.stringify([memory, persisted])).not.toContain("private-canary");
      expect(JSON.stringify(getRequestLogEntries())).not.toContain("fixture-conversation");
      expect(readFileSync(usageLogPath(), "utf8")).not.toContain("fixture-conversation");
      expect(readFileSync(usageLogPath(), "utf8")).not.toContain("private-canary");
    }
  });

  for (const statelessResponses of [false, true]) test(`HTTP gateway observes conversation before stateless stripping=${statelessResponses}`, async () => {
    const seen = captureWire();
    const cfg = config({ authMode: "key", apiKey: "fixture-key", baseUrl: "https://gateway.example/v1", statelessResponses });
    const post = httpRouter(cfg);
    for (const conversation of ["fixture-conversation", { id: "fixture-conversation", extra: "private-canary" }]) {
      for (const withUpdate of [false, true]) {
        const input = [...(withUpdate ? [{ type: "configuration_update", reasoning: { effort: "max" } }] : []), user("hello")];
        const body = { model: "p/gw-model", stream: true, store: false, input, reasoning: { effort: "high" }, conversation };
        const original = structuredClone(body);
        const response = await post(body);
        expect(response.status).toBe(200);
        await response.text();
        expect(body).toEqual(original);
        expect(seen.at(-1)?.body.conversation).toEqual(statelessResponses ? undefined : conversation);
        expect(seen.at(-1)?.body.input).toEqual([user("hello")]);
        const expected = withUpdate ? { clientEffort: "high", sessionEffort: "max", status: "visible" }
          : { clientEffort: "high", sessionEffort: "unknown", status: "not_in_input" };
        const memory = getRequestLogEntries().at(-1)?.sessionEffortObservation;
        const persisted = readUsageEntries().at(-1)?.sessionEffortObservation;
        expect(memory).toEqual(expected);
        expect(persisted).toEqual(expected);
        expect(JSON.stringify([memory, persisted])).not.toContain("fixture-conversation");
        expect(JSON.stringify([memory, persisted])).not.toContain("private-canary");
      }
    }
  });

  test("the observation is client-owned for other destinations and absent on synthetic requests", async () => {
    captureWire();
    const cfg = config({ authMode: "key", apiKey: "gw-key", baseUrl: "https://gateway.example/v1" });
    const items = [{ type: "configuration_update", reasoning: { effort: "max" } }, user("hello")];
    const [client, concurrent, synthetic] = await Promise.all([
      drive(cfg, "p/gw-model", items, { reasoning: { effort: "high" }, clientInitialResponses: true }),
      drive(cfg, "p/gw-model", [{ type: "configuration_update", reasoning: { effort: "low" } }, user("other")], { reasoning: { effort: "medium" }, clientInitialResponses: true }),
      drive(cfg, "p/gw-model", items, { reasoning: { effort: "low" } }),
    ]);
    expect(client.logCtx.sessionEffortObservation).toEqual({ clientEffort: "high", sessionEffort: "max", status: "visible" });
    expect(concurrent.logCtx.sessionEffortObservation).toEqual({ clientEffort: "medium", sessionEffort: "low", status: "visible" });
    expect(synthetic.logCtx.sessionEffortObservation).toBeUndefined();
  });

  test("continuation replay never promotes cached updates into the initial observation", async () => {
    const seen = captureWire();
    const cfg = config({ authMode: "key", apiKey: "fixture-key", baseUrl: "https://api.openai.com/v1" });
    rememberResponseState({ input: [{ type: "configuration_update", reasoning: { effort: "max" } }, user("other-session-fixture")], store: true },
      { id: "fixture-history", status: "completed", output: [] }, undefined, { clientThreadId: "owner" });
    try {
      for (const [id, owner] of [["fixture-history", "owner"], ["missing-history", "owner"], ["fixture-history", "other"]]) {
        const result = await drive(cfg, "p/gw-model", [user("delta")], { previousResponseId: id, headers: { "x-codex-parent-thread-id": owner }, reasoning: { effort: "high" }, clientInitialResponses: true });
        expect(result.logCtx.sessionEffortObservation).toEqual({ clientEffort: "high", sessionEffort: "unknown", status: "not_in_input" });
        if (id === "fixture-history" && owner === "owner") {
          expect(result.status).toBe(200);
          expect(seen[0]!.body.input).toContainEqual({ type: "configuration_update", reasoning: { effort: "max" } });
          expect(JSON.stringify(seen[0]!.body.input)).toContain("other-session-fixture");
        } else {
          expect(result.text).not.toContain("other-session-fixture");
          if (id === "missing-history") expect(JSON.stringify(seen[1]!.body)).not.toContain("other-session-fixture");
          else { expect(result.status).toBe(400); expect(seen).toHaveLength(2); }
        }
      }
      const missing = await drive(canonical(), "p/gpt-5.6-luna", [user("delta")], { previousResponseId: "canonical-missing", headers: rootHeaders, reasoning: { effort: "high" }, clientInitialResponses: true });
      expect(missing.status).toBe(400);
      expect(missing.text).not.toContain("other-session-fixture");
      expect(missing.logCtx.sessionEffortObservation).toEqual({ clientEffort: "high", sessionEffort: "unknown", status: "not_in_input" });
    } finally { await flushResponseState(); clearResponseStateForTests(); }
  });

  test("logs the client's initial top-level effort and last visible session update", async () => {
    clearRequestLogsForTests();
    const seen = captureWire();
    const items = [user("one"), { type: "configuration_update", reasoning: { effort: "max" } }, user("two")];
    const { status, logCtx } = await drive(canonical(), "p/gpt-5.6-luna", items, {
      headers: rootHeaders, reasoning: { effort: "high" }, clientInitialResponses: true, finalizeLog: true,
    });
    expect(status).toBe(200);
    expect((logCtx as unknown as Record<string, unknown>).sessionEffortObservation).toEqual({
      clientEffort: "high", sessionEffort: "max", status: "visible",
    });
    expect(getRequestLogEntries().at(-1)?.sessionEffortObservation).toEqual({ clientEffort: "high", sessionEffort: "max", status: "visible" });
    expect(readUsageEntries().at(-1)?.sessionEffortObservation).toEqual({ clientEffort: "high", sessionEffort: "max", status: "visible" });
    expect(seen[0]!.body.input).toEqual(items);
    expect(seen[0]!.body.reasoning).toEqual({ effort: "high" });
  }, 20_000);

  test("OpenAI-operated destinations receive it verbatim and in order", async () => {
    const seen = captureWire();
    for (const cfg of [canonical(), config({ authMode: "key", apiKey: "sk-test", baseUrl: "https://api.openai.com/v1" })]) {
      const { status } = await drive(cfg, "p/gpt-5.6-luna", input(), { headers: rootHeaders });
      expect(status).toBe(200);
    }
    expect(seen).toHaveLength(2);
    for (const wire of seen) {
      const items = wire.body.input as Array<Record<string, unknown>>;
      const at = items.findIndex(item => item.type === "configuration_update");
      expect(items[at]).toEqual(CONFIG_UPDATE);
      expect(items[at - 1]).toMatchObject({ role: "user", content: [{ text: "one" }] });
      expect(items[at + 1]).toMatchObject({ role: "user", content: [{ text: "two" }] });
    }
  }, 20_000);

  test("a third-party Responses gateway gets the conversation without it or RLite provenance", async () => {
    const seen = captureWire();
    const items = input();
    items[0] = { ...items[0], internal_chat_message_metadata_passthrough: provenance };
    const { status } = await drive(
      config({ authMode: "key", apiKey: "gw-key", baseUrl: "https://gateway.example/v1" }), "p/gw-model", items,
      { headers: rootHeaders },
    );
    expect(status).toBe(200);
    const sent = seen[0]!.body.input as Array<Record<string, unknown>>;
    expect(sent.some(item => item.type === "configuration_update")).toBe(false);
    expect(sent.some(item => Object.hasOwn(item, "internal_chat_message_metadata_passthrough"))).toBe(false);
    expect(sent.filter(item => item.role === "user").map(item => (item.content as Array<{ text: string }>)[0]!.text))
      .toEqual(["one", "two"]);
  }, 20_000);

  test("a translated route drops it without failing or inventing a message", async () => {
    const seen = captureWire();
    const { status } = await drive(config({
      adapter: "openai-chat", authMode: "key", apiKey: "chat-key", baseUrl: "https://chat.example/v1", models: ["m"],
    } as Partial<OcxProviderConfig>), "p/m", input(), { headers: rootHeaders });
    expect(status).toBe(200);
    const messages = seen[0]!.body.messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(messages)).not.toContain("configuration_update");
    expect(messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)))
      .toEqual([expect.stringContaining("one"), expect.stringContaining("two")]);
  }, 20_000);

  test("the parser keeps pending reasoning attached across it", () => {
    const parsed = parseRequest({
      model: "p/m",
      input: [
        user("q"),
        { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
        structuredClone(CONFIG_UPDATE),
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    expect(parsed.context.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    const assistant = parsed.context.messages[1] as { content: Array<{ type: string }> };
    expect(assistant.content.map(part => part.type)).toEqual(["thinking", "text"]);
  });

  test("a trailing update does not hide the agent task before it", async () => {
    resetAgentTaskRecoveryState();
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; throw new Error("must-not-fetch"); }) as typeof fetch;
    const tailed = [...encryptedInput(), structuredClone(CONFIG_UPDATE)];
    expect(hasUnreadableEncryptedAgentTask(tailed)).toBe(true);
    // Without credentials the envelope is found and then refused; a missed envelope would read as
    // unsupported instead.
    expect(await recoverEncryptedAgentTaskWithResult(new Request("http://localhost/v1/responses"), tailed, {}, routedConfig()))
      .toEqual({ recovered: false, reason: "admission_denied" });
    expect(fetches).toBe(0);
    resetAgentTaskRecoveryState();
  });
});

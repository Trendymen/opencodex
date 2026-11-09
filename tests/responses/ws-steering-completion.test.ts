import { afterAll, expect, test as bunTest } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectionSocket as InjectionSocketType, Frame } from "../helpers/native-injection-fixture";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const isolatedChild = process.env.OCX_WS_ISOLATED_CHILD === "1";
const standaloneParent = !isolatedChild && process.env.OCX_TEST_PRELOAD_PID !== String(process.pid);

async function runStandalone(name: string) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-injection-fixture-")));
  const opencodexHome = join(root, "opencodex");
  const codexHome = join(root, "codex");
  const childTemp = join(root, "tmp");
  const cache = join(root, "bun-cache");
  for (const dir of [opencodexHome, codexHome, childTemp, cache]) mkdirSync(dir);
  if (process.platform === "win32") {
    mkdirSync(join(root, "AppData", "Local"), { recursive: true });
    mkdirSync(join(root, "AppData", "Roaming"), { recursive: true });
  }
  const env = { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: opencodexHome, CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: join(root, "claude"), GROK_HOME: join(root, "grok"),
    TMPDIR: childTemp, TMP: childTemp, TEMP: childTemp, BUN_RUNTIME_TRANSPILER_CACHE_PATH: cache,
    OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_OWNER_REGISTRY_DIR: join(opencodexHome, "ocx-homes"),
    OCX_REAL_CLAUDE_CONFIG_DIR: process.env.OCX_REAL_CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    OCX_TEST_HOME_GUARD: "1", OCX_WS_ISOLATED_CHILD: "1" };
  delete env.OCX_TEST_PRELOAD_PID;
  delete env.OPENCODEX_API_AUTH_TOKEN;
  delete env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete env.OCX_API_TOKEN_FILE;
  const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", pattern],
    { cwd: root, env, stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 15_000);
  let completed = false;
  try {
    const [exit, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`[test] retained ${root}: isolated test exited ${exit}: ${output}`);
    completed = true;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill(); await child.exited; }
    if (completed) await (await import("../helpers/remove-tree")).removeTreeAfterBackgroundWork(root);
  }
}

const test = standaloneParent
  ? ((name: string, _run: () => unknown, timeout?: number) => bunTest(name, () => runStandalone(name), timeout ?? 20_000)) as typeof bunTest
  : bunTest;
const { removeTreeAfterBackgroundWork } = (standaloneParent ? {} : await import("../helpers/remove-tree")) as typeof import("../helpers/remove-tree");
const { beginInjection, injectionConfig, installInjectionFixture, waitForInjection, InjectionSocket,
  advertiseInjection, savedResult } = (standaloneParent ? {} : await import("../helpers/native-injection-fixture")) as typeof import("../helpers/native-injection-fixture");
const fixture = standaloneParent ? undefined : installInjectionFixture();
if (isolatedChild) {
  const { settleBackgroundWork } = await import("../../src/lib/background-work");
  const { flushWindowsSecretAclReapsBeforeRemoval } = await import("../../src/lib/windows-secret-acl");
  afterAll(async () => {
    if (!fixture || fixture.teardownFailed()) throw new Error("injection teardown not proven");
    const result = await settleBackgroundWork({ timeoutMs: 15_000 });
    if (!result.settled) throw new Error(`background work still running: ${result.pending.join(", ")}`);
    await flushWindowsSecretAclReapsBeforeRemoval(process.env.OPENCODEX_HOME!);
  });
}
const { CODEX_HOME } = (standaloneParent ? {} : await import("../../src/codex/paths")) as typeof import("../../src/codex/paths");
const { NativeSteeringChannel } = (standaloneParent ? {} : await import("../../src/server/responses/native-steering")) as typeof import("../../src/server/responses/native-steering");
const { createSteeringSettingsNormalizer } = (standaloneParent ? {} : await import("../../src/server/responses/native-steering-policy")) as typeof import("../../src/server/responses/native-steering-policy");
const { validSteeringSettings } = (standaloneParent ? {} : await import("../../src/server/responses/native-steering-settings")) as typeof import("../../src/server/responses/native-steering-settings");
const { nativeResponseControlEligible } = (standaloneParent ? {} : await import("../../src/server/responses/native-response-control")) as typeof import("../../src/server/responses/native-response-control");
const { getRequestLogEntries } = (standaloneParent ? {} : await import("../../src/server/request-log")) as typeof import("../../src/server/request-log");
const { readUsageEntries, usageLogPath } = (standaloneParent ? {} : await import("../../src/usage/log")) as typeof import("../../src/usage/log");
const config = (api = false) => ({ ...injectionConfig(api), codexNativeSteering: true });
const begin = (api = false, fields: Frame = {}, settings = config(api)) =>
  beginInjection({ multi_agent: { enabled: false }, reasoning: { effort: "low" }, ...fields }, settings);
function accept(socket: InjectionSocketType, id: string, number = 1) {
  socket.emit({ type: "response.steer.accepted", steer: { id: `steer-${number}`, previous_response_id: id } });
}
function pending(socket: InjectionSocketType, id: string, number = 1) {
  const call = advertiseInjection(socket, `call-${number}`);
  socket.emit({ type: "response.completed", response: { id, status: "completed", output: [call] } });
  socket.emit({ type: "response.steer.pending", steer: { id: `steer-${number}`, previous_response_id: id },
    reason: "waiting_for_required_input", required_input: [{ type: "function_call_output", call_id: `call-${number}` }] });
}

for (const { name, conversation, valid } of [
  { name: "string", conversation: " fixture-conversation-string ", valid: true },
  { name: "object", conversation: { id: " fixture-conversation-object ", extra: "private-canary" }, valid: true },
  { name: "empty string", conversation: "  ", valid: false },
  { name: "empty object ID", conversation: { id: "  " }, valid: false },
  { name: "non-string object ID", conversation: { id: 7 }, valid: false },
  { name: "null", conversation: null, valid: false },
  { name: "array", conversation: ["fixture-conversation"], valid: false },
]) for (const withUpdate of [false, true]) {
  test(`WebSocket conversation ${name}, initial update=${withUpdate}`, async () => {
    if (process.env.OCX_EXPECT_NO_PRELOAD === "1") {
      expect(process.env.OCX_TEST_PRELOAD_PID).toBeUndefined();
      expect(process.env.CODEX_HOME).not.toBe(process.env.OCX_CALLER_CODEX_CANARY);
      expect(CODEX_HOME).toBe(process.env.CODEX_HOME);
    }
    const input = [...(withUpdate ? [{ type: "configuration_update", reasoning: { effort: "max" } }] : []),
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }];
    const c = await begin(true, { conversation, reasoning: { effort: "high" }, input });
    expect(c.socket.frames[0].conversation).toEqual(conversation);
    expect(c.socket.frames[0].input).toEqual(input);
    c.socket.emit({ type: "response.completed", response: { id: c.id, status: "completed", output: [] } });
    await waitForInjection(() => getRequestLogEntries().length > 0);
    const expected = withUpdate ? { clientEffort: "high", sessionEffort: "max", status: "visible" }
      : valid ? { clientEffort: "high", sessionEffort: "unknown", status: "not_in_input" } : undefined;
    const memory = getRequestLogEntries().at(-1)?.sessionEffortObservation;
    const persisted = readUsageEntries().at(-1)?.sessionEffortObservation;
    expect(memory).toEqual(expected);
    expect(persisted).toEqual(expected);
    expect(JSON.stringify([memory, persisted])).not.toContain("fixture-conversation");
    expect(JSON.stringify([memory, persisted])).not.toContain("private-canary");
    expect(JSON.stringify(getRequestLogEntries())).not.toContain("fixture-conversation");
    expect(readFileSync(usageLogPath(), "utf8")).not.toContain("fixture-conversation");
    expect(readFileSync(usageLogPath(), "utf8")).not.toContain("private-canary");
    if (process.env.OCX_FIXTURE_FAIL_TEARDOWN === "1") {
      const close = c.ws.close.bind(c.ws);
      c.ws.close = () => { close(); throw new Error("fixture-teardown-canary"); };
    }
  });
}

for (const teardownFails of [false, true]) test(`standalone WebSocket test leaves caller data untouched (teardown fails=${teardownFails})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-ws-standalone-canary-"));
  const canary = join(root, "caller-data");
  const childHome = join(root, "home");
  const childCodexHome = join(root, "codex");
  const childTemp = join(root, "temp");
  mkdirSync(canary); mkdirSync(childHome); mkdirSync(childCodexHome); mkdirSync(childTemp);
  writeFileSync(join(canary, "sentinel.txt"), "sentinel");
  writeFileSync(join(childCodexHome, "sentinel.txt"), "codex-sentinel");
  const probe = join(root, "cached-home-probe.test.ts");
  writeFileSync(probe, [
    'import { expect, test } from "bun:test";',
    'import { existsSync, realpathSync } from "node:fs";',
    `import { CODEX_HOME } from ${JSON.stringify(join(import.meta.dir, "../../src/codex/paths.ts"))};`,
    'test("cached Codex home after WS test", () => {',
    '  expect(existsSync(CODEX_HOME)).toBe(true);',
    '  expect(CODEX_HOME).toBe(realpathSync.native(process.env.CODEX_HOME!));',
    '});',
  ].join("\n"));
  const env = { ...process.env, HOME: childHome, CODEX_HOME: childCodexHome, OPENCODEX_HOME: canary,
    TMPDIR: childTemp, TMP: childTemp, TEMP: childTemp, OCX_EXPECT_NO_PRELOAD: "1",
    OCX_FIXTURE_FAIL_TEARDOWN: teardownFails ? "1" : "0", OCX_CALLER_CODEX_CANARY: childCodexHome };
  delete env.OCX_TEST_PRELOAD_PID;
  delete env.OCX_TEST_HOME_GUARD;
  delete env.OCX_WS_ISOLATED_CHILD;
  const child = Bun.spawn([process.execPath, "test", import.meta.path, probe, "--test-name-pattern",
    "WebSocket conversation string, initial update=false|cached Codex home after WS test"],
    { cwd: root, env, stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [exit, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (!teardownFails && exit !== 0) throw new Error(`standalone test exited ${exit}: ${output}`);
    expect(output).toContain("(pass) cached Codex home after WS test");
    if (teardownFails) {
      expect(exit).not.toBe(0);
      expect(output).toContain("fixture-teardown-canary");
      expect(output).toContain("injection teardown not proven");
    }
    expect(readdirSync(canary).sort()).toEqual(["sentinel.txt"]);
    expect(readFileSync(join(canary, "sentinel.txt"), "utf8")).toBe("sentinel");
    expect(readdirSync(childCodexHome).sort()).toEqual(["sentinel.txt"]);
    expect(readFileSync(join(childCodexHome, "sentinel.txt"), "utf8")).toBe("codex-sentinel");
    expect(readdirSync(childTemp).filter(name => name.startsWith("ocx-injection-fixture-"))).toHaveLength(teardownFails ? 1 : 0);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill(); await child.exited; }
    await removeTreeAfterBackgroundWork(root);
  }
}, 20_000);

test("public API steering is ineligible because retained successors bypass per-request admission", async () => {
  const c = await begin(true);
  c.send({ type: "response.steer", previous_response_id: c.id, input: "new constraint" });
  expect(c.sent.at(-1)?.error.code).toBe("steering_not_supported");
  expect(c.socket.url).toBe("wss://api.openai.com/v1/responses");
  expect(c.socket.options.headers.authorization).toBe("Bearer fixture-public-key");
  expect(c.socket.options.headers["chatgpt-account-id"]).toBeUndefined();
  expect(c.socket.options.headers["openai-beta"]).toContain("fixture_beta=v1");
  expect(c.socket.options.headers["openai-beta"]).not.toContain("responses_multi_agent");
  c.socket.emit({ type: "response.completed", response: { id: c.id, status: "completed", output: [] } });
  expect(InjectionSocket.all).toHaveLength(1);
  expect(c.socket.frames).toHaveLength(1);
});

test("explicit settings survive two same-socket subscription continuations", async () => {
  const api = false;
  const c = await begin(api);
  c.send({ type: "response.steer", previous_response_id: c.id, input: "update" });
  accept(c.socket, c.id); pending(c.socket, c.id);
  const override = { reasoning: { effort: "high", summary: "detailed" }, text: { verbosity: "low", format: { type: "json_object" } },
    ...(api ? { max_output_tokens: 256 } : {}) };
  c.send({ type: "response.create", previous_response_id: c.id, input: [savedResult()], ...override });
  await waitForInjection(() => c.socket.frames.length === 3);
  expect(c.socket.frames[2]).toMatchObject(override);
  expect(c.socket.frames[2].model).toBe("gpt-5.6-sol");
  expect(c.socket.frames[2].previous_response_id).toBe(c.id);
  c.socket.emit({ type: "response.created", response: { id: "second", previous_response_id: c.id } });
  c.send({ type: "response.steer", previous_response_id: "second", input: "another update" });
  accept(c.socket, "second", 2); pending(c.socket, "second", 2);
  c.send({ type: "response.create", previous_response_id: "second", input: [savedResult("call-2")] });
  await waitForInjection(() => c.socket.frames.length === 5);
  expect(c.socket.frames[4]).toMatchObject(override);
  expect(InjectionSocket.all).toHaveLength(1);
});

test("provider-pinned effort still wins over an explicit continuation override", async () => {
  const settings = config(); settings.providers.openai.pinnedReasoningEffort = "low";
  const c = await begin(false, {}, settings);
  c.send({ type: "response.steer", previous_response_id: c.id, input: "update" });
  accept(c.socket, c.id); pending(c.socket, c.id);
  c.send({ type: "response.create", previous_response_id: c.id, input: [savedResult()], reasoning: { effort: "high" } });
  await waitForInjection(() => c.socket.frames.length === 3);
  expect(c.socket.frames[2].reasoning.effort).toBe("low");
});

test("an unsupported subscription output limit fails before reservation, allowing correction", async () => {
  const c = await begin();
  c.send({ type: "response.steer", previous_response_id: c.id, input: "update" }); accept(c.socket, c.id); pending(c.socket, c.id);
  c.send({ type: "response.create", previous_response_id: c.id, input: [savedResult()], max_output_tokens: 50 });
  expect(c.sent.at(-1)?.error.code).toBe("steering_settings_unsupported");
  expect(c.socket.frames).toHaveLength(2);
  c.send({ type: "response.create", previous_response_id: c.id, input: [savedResult()], reasoning: { effort: "medium" } });
  await waitForInjection(() => c.socket.frames.length === 3);
  expect(c.socket.frames[2].reasoning.effort).toBe("medium");
});

for (const override of [
  { reasoning: { effort: "invented" } }, { reasoning: [] }, { reasoning: { injected: "no" } },
  { text: { verbosity: "huge" } }, { text: { format: { type: "json_schema", name: "invalid name", schema: {} } } },
  { max_output_tokens: 0 }, { max_output_tokens: 1.5 }, { stream_options: { include_usage: "yes" } },
]) test(`malformed generation override is rejected: ${JSON.stringify(override)}`, () => {
  expect(validSteeringSettings(override)).toBe(false);
});

for (const change of [{ model: "another-model" }, { tools: [] }, { service_tier: "priority" },
  { instructions: "replace policy" }, { multi_agent: { enabled: true } }, { conversation: "foreign" }]) {
  test(`immutable continuation setting stays pinned: ${Object.keys(change)[0]}`, async () => {
    const c = await begin();
    c.send({ type: "response.steer", previous_response_id: c.id, input: "update" }); accept(c.socket, c.id); pending(c.socket, c.id);
    c.send({ type: "response.create", previous_response_id: c.id, input: [savedResult()], ...change });
    expect(c.sent.at(-1)?.error.code).toBe("steering_settings_changed");
    expect(c.socket.frames).toHaveLength(2);
  });
}

test("normal policy retains subagent effort caps and configured capability exclusions", () => {
  const provider = { ...config().providers.openai, modelSupportsVerbosity: { "gpt-5.6-sol": false }, modelSupportsReasoningSummaries: { "gpt-5.6-sol": false } };
  const parsed = { modelId: "gpt-5.6-sol", options: {}, context: {}, _rawBody: {} } as unknown as OcxParsedRequest;
  const normalize = createSteeringSettingsNormalizer(parsed, { provider, modelId: parsed.modelId, providerName: "openai" },
    { ...config(), subagentEffortCap: "low" } as OcxConfig, new Headers({ "x-openai-subagent": "collab_spawn" }));
  const result = normalize({ reasoning: { effort: "high", summary: "detailed" }, text: { verbosity: "high", format: { type: "text" } } });
  expect(result.reasoning).toEqual({ effort: "low" });
  expect(result.text).toEqual({ format: { type: "text" } });
  expect(parsed._rawBody).toEqual({});
});

test("API effort mapping is the same as normal routed requests", () => {
  const provider = { ...config(true).providers.api, reasoningEfforts: ["low", "medium", "high"] };
  const parsed = { modelId: "gpt-5.6-sol", options: {}, context: {}, _rawBody: {} } as unknown as OcxParsedRequest;
  const normalize = createSteeringSettingsNormalizer(parsed, { provider, modelId: parsed.modelId, providerName: "api" }, config(true), new Headers());
  expect(normalize({ reasoning: { effort: "ultra" } }).reasoning).toEqual({ effort: "high" });
});

test("queued continuation owns a private copy of both result and settings", () => {
  const channel = new NativeSteeringChannel({ model: "fixture" });
  const sent: Frame[] = []; const detach = channel.attach(frame => sent.push(frame), () => {});
  try {
    channel.observe({ type: "response.created", response: { id: "r" } });
    channel.steer({ type: "response.steer", previous_response_id: "r", input: "update" });
    channel.observe({ type: "response.steer.accepted", steer: { id: "s", previous_response_id: "r" } });
    channel.observe({ type: "response.completed", response: { id: "r", output: [{ type: "function_call", call_id: "c" }] } });
    const frame = { type: "response.create", previous_response_id: "r", input: [savedResult("c")], reasoning: { effort: "high" } };
    channel.continue(frame); frame.reasoning.effort = "low"; frame.input[0].output = "modified";
    expect(sent[1].reasoning.effort).toBe("high"); expect(sent[1].input[0].output).toBe("saved result");
  } finally { detach(); }
});

test("public API eligibility excludes steering even when its WebSocket is explicitly enabled", () => {
  expect(nativeResponseControlEligible(config(true).providers.api, new NativeSteeringChannel({}))).toBe(false);
});

for (const override of [{ upstreamWebsocket: false }, { baseUrl: "https://gateway.example/v1" }, { authMode: "forward" }, { adapter: "openai-chat" }] as Partial<OcxProviderConfig>[]) {
  test(`public API eligibility does not widen other routes: ${Object.keys(override)[0]}`, () => {
    const provider = { ...config(true).providers.api, ...override };
    expect(nativeResponseControlEligible(provider, new NativeSteeringChannel({}))).toBe(false);
  });
}

for (const [fields, flags, reason] of [
  [{ conversation: "fixture-conversation" }, {}, "Conversation-bound"],
  [{ context_management: [{ type: "compaction" }] }, {}, "compaction"],
  [{ multi_agent: { enabled: true } }, { codexNativeInjection: false }, "Multi-agent"],
  [{}, { codexNativeSteering: false }, "disabled"],
] as Array<[Frame, Frame, string]>) test(`handler explains unavailable steering without cancelling normal output: ${reason}`, async () => {
  const c = await begin(false, fields, { ...config(), ...flags });
  c.send({ type: "response.steer", previous_response_id: c.id, input: "update" });
  expect(c.sent.at(-1)?.error.code).toBe("steering_not_supported");
  expect(c.sent.at(-1)?.error.message).toContain(reason);
  expect(c.socket.frames).toHaveLength(1); expect(c.socket.readyState).toBe(1);
});
for (const value of ["sequential", "sequential_cutoff", "concurrent", "concurrent_cutoff"]) {
  test(`summary delivery uses the repository-owned wire enum: ${value}`, () => {
    expect(validSteeringSettings({ stream_options: { reasoning_summary_delivery: value, include_obfuscation: true } })).toBe(true);
  });
}
test("invented summary-delivery enum is refused", () => {
  expect(validSteeringSettings({ stream_options: { reasoning_summary_delivery: "buffered" } })).toBe(false);
});

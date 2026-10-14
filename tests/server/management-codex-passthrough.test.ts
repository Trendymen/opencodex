import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, saveConfigPreservingClaudeCode } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { providerEditorConfigDTO } from "../../src/server/auth-cors";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const oldHome = process.env.OPENCODEX_HOME;
let home = "";
afterEach(() => {
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

function setup(): OcxConfig {
  home = mkdtempSync(join(tmpdir(), "ocx-codex-permissions-"));
  process.env.OPENCODEX_HOME = home;
  const config: OcxConfig = { port: 10100, hostname: "127.0.0.1", defaultProvider: "official", providers: {
    official: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward",
      codexPassthrough: { bridgeLiteMetadata: false, localErrorPolicies: { resetReplayRefusal: false } } },
  } };
  saveConfig(config);
  return config;
}

async function send(config: OcxConfig, path: string, method = "GET", body?: unknown,
  deps?: Parameters<typeof handleManagementAPI>[3]): Promise<Response> {
  const url = new URL(path, "http://127.0.0.1");
  const response = await handleManagementAPI(new ManagementRequest(url, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, config, deps);
  if (!response) throw new Error("Management route missing");
  return response;
}

test("provider GETs and nested PATCH preserve optional overrides", async () => {
  const config = setup();
  const before = readFileSync(join(home, "config.json"), "utf8");
  const publicConfig = await (await send(config, "/api/config")).json() as OcxConfig;
  expect(publicConfig.providers.official!.codexPassthrough).toEqual(config.providers.official!.codexPassthrough);
  const summary = await (await send(config, "/api/providers")).json() as Array<{ name: string; codexPassthrough?: unknown }>;
  expect(summary.find(row => row.name === "official")?.codexPassthrough).toEqual(config.providers.official!.codexPassthrough);
  expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  const patched = await send(config, "/api/providers?name=official", "PATCH", {
    codexPassthrough: { normalizeEncryptedContent: false, localErrorPolicies: { requestPacingAdmission: false } },
  });
  expect(patched.status).toBe(200);
  expect(loadConfig().providers.official!.codexPassthrough).toEqual({ bridgeLiteMetadata: false, normalizeEncryptedContent: false,
    localErrorPolicies: { resetReplayRefusal: false, requestPacingAdmission: false } });
  expect((await send(config, "/api/providers?name=official", "PATCH", { codexPassthrough: { bridgeLiteMetadata: null } })).status).toBe(200);
  expect(loadConfig().providers.official!.codexPassthrough).not.toHaveProperty("bridgeLiteMetadata");
});

test("strict writes and concurrent leaves do not lose existing state", async () => {
  const config = setup();
  const before = readFileSync(join(home, "config.json"), "utf8");
  expect((await send(config, "/api/providers?name=official", "PATCH", { codexPassthrough: { unsupported: false } })).status).toBe(400);
  expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  const results = await Promise.all([
    send(config, "/api/providers?name=official", "PATCH", { codexPassthrough: { backfillResponseFields: false } }),
    send(config, "/api/providers?name=official", "PATCH", { codexPassthrough: { redactUpstreamErrors: false } }),
  ]);
  expect(results.map(result => result.status)).toEqual([200, 200]);
  expect(loadConfig().providers.official!.codexPassthrough).toMatchObject({ backfillResponseFields: false, redactUpstreamErrors: false });
  expect((await send(config, "/api/providers?name=official", "PATCH", { codexPassthrough: { backfillResponseFields: true } })).status).toBe(200);
  expect(loadConfig().providers.official!.codexPassthrough).toMatchObject({ backfillResponseFields: true, redactUpstreamErrors: false });
});

test("permission save failure rolls back live and disk state", async () => {
  const config = setup();
  const before = structuredClone(config);
  const disk = readFileSync(join(home, "config.json"), "utf8");
  await expect(send(config, "/api/providers?name=official", "PATCH", { codexPassthrough: null }, {
    saveConfigPreservingClaudeCode() { throw new Error("synthetic permission save failure"); },
  })).rejects.toThrow("synthetic permission save failure");
  expect(config).toEqual(before);
  expect(readFileSync(join(home, "config.json"), "utf8")).toBe(disk);
});

test("concurrent same leaf follows actual lock saves and nested leaves merge", async () => {
  const config = setup();
  Object.assign(config.providers.official!, { authMode: "key", apiKey: "sk-concurrent-fixture", baseUrl: "https://concurrent.example.test/v1" });
  saveConfig(config);
  let releaseDns!: () => void;
  let startedDns!: () => void;
  const dnsHeld = new Promise<void>(resolve => { releaseDns = resolve; });
  const dnsStarted = new Promise<void>(resolve => { startedDns = resolve; });
  const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockImplementation(async () => {
    startedDns();
    await dnsHeld;
    return null;
  });
  const saves: boolean[] = [];
  const deps: Parameters<typeof handleManagementAPI>[3] = {
    saveConfigPreservingClaudeCode(next) {
      saves.push(next.providers.official!.codexPassthrough!.backfillResponseFields!);
      saveConfigPreservingClaudeCode(next);
    },
  };
  const first = send(config, "/api/providers?name=official", "PATCH", {
    note: "held before lock", codexPassthrough: { backfillResponseFields: false },
  }, deps);
  try {
    await dnsStarted;
    const second = await send(config, "/api/providers?name=official", "PATCH", {
      codexPassthrough: { backfillResponseFields: true },
    }, deps);
    expect(second.status).toBe(200);
    releaseDns();
    expect((await first).status).toBe(200);
    expect(saves).toEqual([true, false]);
    expect(config.providers.official!.codexPassthrough!.backfillResponseFields).toBe(saves.at(-1));
    expect(loadConfig().providers.official!.codexPassthrough!.backfillResponseFields).toBe(saves.at(-1));
    const nested = await Promise.all([
      send(config, "/api/providers?name=official", "PATCH", { codexPassthrough: { localErrorPolicies: { requestPacingAdmission: false } } }),
      send(config, "/api/providers?name=official", "PATCH", { codexPassthrough: { localErrorPolicies: { accountSoftPrecheck: false } } }),
    ]);
    expect(nested.map(response => response.status)).toEqual([200, 200]);
    const local = { resetReplayRefusal: false, requestPacingAdmission: false, accountSoftPrecheck: false };
    expect(config.providers.official!.codexPassthrough!.localErrorPolicies).toEqual(local);
    expect(loadConfig().providers.official!.codexPassthrough!.localErrorPolicies).toEqual(local);
  } finally { releaseDns(); resolved.mockRestore(); await first; }
});

test("JSON editor keeps overrides and rejects a stale baseline", async () => {
  const config = setup();
  Object.assign(config.providers.official!, { authMode: "key", apiKey: "sk-editor-fixture", baseUrl: "https://editor.example.test/v1" });
  saveConfig(config);
  const baseline = providerEditorConfigDTO(loadConfig());
  const next = structuredClone(baseline);
  next.providers.official!.note = "editor note";
  const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  try {
    expect((await send(config, "/api/providers", "PUT", { baseline, next })).status).toBe(200);
    expect(loadConfig().providers.official!.codexPassthrough).toEqual(baseline.providers.official!.codexPassthrough);
    const disk = readFileSync(join(home, "config.json"), "utf8");
    const stale = await send(config, "/api/providers", "PUT", { baseline, next });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale_provider_editor_baseline" });
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(disk);
  } finally { resolved.mockRestore(); }
});

test("POST carries omitted permissions only for the same destination", async () => {
  const config = setup();
  Object.assign(config.providers.official!, { authMode: "key", apiKey: "sk-carry-fixture", baseUrl: "https://carry.example.test/v1" });
  saveConfig(config);
  const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  try {
    const provider = { adapter: "openai-responses", baseUrl: "https://carry.example.test/v1", authMode: "key", apiKey: "sk-carry-fixture" };
    expect((await send(config, "/api/providers", "POST", { name: "official", provider })).status).toBe(200);
    expect(loadConfig().providers.official!.codexPassthrough).toMatchObject({ bridgeLiteMetadata: false });
    expect((await send(config, "/api/providers", "POST", { name: "official", provider: { ...provider, baseUrl: "https://other.example.test/v1" } })).status).toBe(200);
    expect(loadConfig().providers.official!.codexPassthrough).toBeUndefined();
  } finally { resolved.mockRestore(); }
});

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { getDefaultConfig } from "../../src/config";
import { AUTH_MATRIX } from "../../src/server/auth-cors";
import { getRequestLogEntries } from "../../src/server/request-log";
import { usageLogPath, type PersistedUsageEntry } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { connectForkModelApiSocket, startForkModelApiFixture, waitForForkModelApi } from "../helpers/fork-model-api-fixture";

const KEY = "ocx_data_fork_access_fixture";
const OTHER_KEY = "ocx_data_fork_other_fixture";
const createdAt = "2026-01-01T00:00:00Z";
const auth = { "x-opencodex-api-key": KEY };

function config(upstreamUrl: string, overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { ...getDefaultConfig(), hostname: "127.0.0.1", port: 10101, websockets: true,
    forkModelApiListener: { enabled: true }, claudeCode: { intercept: { enabled: false } },
    defaultProvider: "allowed", providers: {
      allowed: { adapter: "openai-chat", baseUrl: `${upstreamUrl}allowed/v1`, allowPrivateNetwork: true, apiKey: "fixture-allowed-key", models: ["small"] },
      forbidden: { adapter: "openai-chat", baseUrl: `${upstreamUrl}forbidden/v1`, allowPrivateNetwork: true, apiKey: "fixture-forbidden-key", models: ["large"] },
      "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key", apiKey: "fixture-platform-key" },
    }, apiKeys: [{ id: "scoped", name: "scoped", key: KEY, createdAt }, { id: "other", name: "other", key: OTHER_KEY, createdAt }], ...overrides };
}

function chatResponse(stream = false) {
  if (stream) return new Response([
    { id: "chat_access", object: "chat.completion.chunk", model: "small", choices: [{ index: 0, delta: { role: "assistant", content: "fixture accepted" }, finish_reason: null }] },
    { id: "chat_access", object: "chat.completion.chunk", model: "small", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  return Response.json({ id: "chat_access", object: "chat.completion", model: "small", choices: [{ index: 0, message: { role: "assistant", content: "fixture accepted" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
}

function rows(): PersistedUsageEntry[] {
  return existsSync(usageLogPath()) ? readFileSync(usageLogPath(), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

function textBody(model = "allowed/small") { return { model, messages: [{ role: "user", content: "fixture request" }] }; }

test("auxiliary credential carriers follow the native per-protocol admission matrix", async () => {
  let paid = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method === "GET") return Response.json({ object: "list", data: [{ id: "small", object: "model" }] });
    paid++;
    const path = new URL(req.url).pathname;
    if (path.endsWith("/transcriptions")) return Response.json({ text: "fixture accepted" });
    if (path.endsWith("/realtime/calls") || path.endsWith("/live")) return new Response("v=0\r\ns=fixture\r\n", { status: 201, headers: { location: "/v1/realtime/calls/rtc_access", "content-type": "application/sdp" } });
    const body = await req.json() as { stream?: boolean };
    return chatResponse(body.stream);
  } });
  try {
    for (const paths of [["/v1/responses", "/v1/chat/completions", "/v1/messages", "/v1/models", "/v1/catalog"], ["/v1/audio/transcriptions", "/v1/live", "/v1/realtime/calls"]]) {
      const cfg = config(upstream.url.toString());
      if (paths.includes("/v1/models")) delete cfg.providers["openai-apikey"];
      const fixture = await startForkModelApiFixture(cfg, { upstreamUrl: upstream.url.toString() });
      try {
        const carriers = ["dedicated", "bearer", "xApiKey"] as const;
        for (const path of paths) {
          const matrix = AUTH_MATRIX.find(row => row.endpoint === path)!;
          for (const carrier of carriers) {
            const headers = new Headers(carrier === "dedicated" ? auth : carrier === "bearer" ? { authorization: `Bearer ${KEY}` } : { "x-api-key": KEY });
            let body: BodyInit | undefined;
            if (path === "/v1/audio/transcriptions") {
              const form = new FormData(); form.set("file", new File(["RIFF-fixture"], "fixture.wav")); form.set("model", "gpt-4o-transcribe"); body = form;
            } else if (!["/v1/models", "/v1/catalog"].includes(path)) {
              headers.set("content-type", "application/json");
              body = JSON.stringify(path === "/v1/responses" ? { model: "allowed/small", input: "fixture request", stream: false }
                : path === "/v1/messages" ? { ...textBody(), max_tokens: 16 }
                : path === "/v1/live" || path === "/v1/realtime/calls" ? { sdp: "v=0", session: { model: "gpt-realtime" } } : textBody());
            }
            const before = paid;
            const response = await fetch(`${fixture.apiUrl}${path}`, { method: body ? "POST" : "GET", headers, body });
            if (matrix[carrier] === "rejected") {
              expect([path, carrier, response.status]).toEqual([path, carrier, 401]);
              expect(paid).toBe(before);
            } else if (path === "/v1/catalog") {
              expect(response.status).toBe(404);
              expect(await response.json()).toMatchObject({ error: { code: "catalog_not_found" } });
            } else {
              expect([path, carrier, response.status]).toEqual([path, carrier, path === "/v1/live" || path === "/v1/realtime/calls" ? 201 : 200]);
              await response.text();
              if (body) expect(paid).toBe(before + 1);
            }
          }
        }
      } finally { await fixture.close(); }
    }
  } finally { await upstream.stop(true); }
});

test("Direct OAuth needs OCX admission and never receives a substituted proxy key", async () => {
  const outbound: Array<{ authorization: string | null; account: string | null; key: string | null }> = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    outbound.push({ authorization: req.headers.get("authorization"), account: req.headers.get("chatgpt-account-id"), key: req.headers.get("x-opencodex-api-key") });
    return Response.json({ id: "resp_direct", object: "response", status: "completed", output: [{ type: "message", id: "msg_direct", role: "assistant", content: [{ type: "output_text", text: "direct accepted", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  } });
  let fixture: Awaited<ReturnType<typeof startForkModelApiFixture>> | undefined;
  try {
    fixture = await startForkModelApiFixture(config(upstream.url.toString(), { defaultProvider: "openai", providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct", models: ["gpt-5.5"] },
    } }), { upstreamUrl: upstream.url.toString() });
    const account = "fixture-direct-account";
    const oauth = fakeChatGptJwt({ "https://api.openai.com/auth": { chatgpt_account_id: account }, exp: Math.floor(Date.now() / 1000) + 3600 });
    const send = (headers: Record<string, string>) => fetch(`${fixture.apiUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "gpt-5.5", input: "fixture Direct", stream: false }) });
    expect((await send({ authorization: `Bearer ${oauth}`, "chatgpt-account-id": account })).status).toBe(401);
    expect(outbound).toEqual([]);
    const accepted = await send({ ...auth, authorization: `Bearer ${oauth}`, "chatgpt-account-id": account });
    expect(accepted.status).toBe(200); await accepted.text();
    expect(outbound).toEqual([{ authorization: `Bearer ${oauth}`, account, key: null }]);
    const missingOauth = await send(auth);
    expect(missingOauth.status).toBe(401);
    expect(outbound).toHaveLength(1);
  } finally { try { await fixture?.close(); } finally { await upstream.stop(true); } }
});

test("scoped keys allow their destination and refuse aliases and failover outside it", async () => {
  const sent: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { model: string; stream?: boolean; messages?: Array<{ content: string }> };
    sent.push(new URL(req.url).pathname);
    if (body.messages?.some(message => message.content === "fail primary")) return Response.json({ error: { type: "rate_limit_error", message: "fixture rate limit" } }, { status: 429, headers: { "retry-after": "1" } });
    return chatResponse(body.stream);
  } });
  const cfg = config(upstream.url.toString());
  cfg.apiKeys![0] = { ...cfg.apiKeys![0]!, allowedProviders: ["allowed"], allowedModels: ["small"] };
  cfg.providers.forbidden!.modelAliases = { large: "innocent-alias" };
  cfg.combos = { scoped: { strategy: "failover", targets: [{ provider: "allowed", model: "small" }, { provider: "forbidden", model: "large" }] } };
  let fixture: Awaited<ReturnType<typeof startForkModelApiFixture>> | undefined;
  try {
    fixture = await startForkModelApiFixture(cfg, { upstreamUrl: upstream.url.toString() });
    const send = (body: unknown) => fetch(`${fixture.apiUrl}/v1/responses`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    const accepted = await send({ model: "allowed/small", input: "allowed", stream: false });
    expect(accepted.status).toBe(200); await accepted.text();
    for (const model of ["forbidden/large", "innocent-alias"]) {
      const denied = await send({ model, input: "denied", stream: false });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: { type: "model_not_allowed_for_key", model } });
    }
    expect(sent).toEqual(["/allowed/v1/chat/completions"]);
    const ws = await connectForkModelApiSocket(fixture.apiUrl!, "/v1/responses", { headers: auth });
    try {
      ws.socket.send(JSON.stringify({ type: "response.create", model: "allowed/small", input: "socket allowed" }));
      await waitForForkModelApi(() => ws.frames.some(frame => JSON.parse(frame).type === "response.completed"), "allowed scoped WebSocket turn");
      const before = sent.length;
      ws.socket.send(JSON.stringify({ type: "response.create", model: "forbidden/large", input: "socket denied" }));
      await waitForForkModelApi(() => ws.frames.some(frame => frame.includes("model_not_allowed_for_key")), "scoped WebSocket refusal");
      expect(sent).toHaveLength(before);
    } finally { ws.socket.close(); }
    const beforeFallback = sent.length;
    const fallback = await send({ model: "combo/scoped", input: "fail primary", stream: false });
    const body = await fallback.json();
    expect(fallback.status).toBe(403);
    expect(body).toMatchObject({ error: { type: "model_not_allowed_for_key" } });
    expect(sent.every(path => path.startsWith("/allowed/"))).toBe(true);
    expect(sent).toHaveLength(beforeFallback + 1);
  } finally { try { await fixture?.close(); } finally { await upstream.stop(true); } }
});

test("rotation overlap, revocation and service tokens preserve request-log and usage attribution", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => chatResponse() });
  let fixture: Awaited<ReturnType<typeof startForkModelApiFixture>> | undefined;
  try {
    fixture = await startForkModelApiFixture(config(upstream.url.toString()), { upstreamUrl: upstream.url.toString(), prepare() { process.env.OPENCODEX_API_AUTH_TOKEN = "fixture-service-token"; } });
    const send = async (key: string) => {
      const response = await fetch(`${fixture.apiUrl}/v1/chat/completions`, { method: "POST", headers: { "x-opencodex-api-key": key, "content-type": "application/json" }, body: JSON.stringify(textBody()) });
      await response.text(); return response;
    };
    const manage = async (path: string, method: string, body: unknown) => {
      const response = await fetch(`${fixture.primaryUrl}${path}`, { method, headers: { "x-opencodex-api-key": fixture.adminToken, "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json(); return { response, payload };
    };
    expect((await send(KEY)).status).toBe(200);
    const rotate = await manage("/api/keys/rotate", "POST", { id: "scoped" });
    expect(rotate.response.status).toBe(201);
    const pending = rotate.payload.key as string;
    expect(pending).toBeString();
    for (const key of [KEY, pending]) {
      expect((await send(key)).status).toBe(200);
      const client = await connectForkModelApiSocket(fixture.apiUrl!, "/v1/responses", { headers: { "x-opencodex-api-key": key } });
      client.socket.close();
    }
    const commit = await manage("/api/keys/rotate/commit", "POST", { id: "scoped", rotationId: rotate.payload.rotationId });
    expect(commit.response.status).toBe(200);
    expect((await send(KEY)).status).toBe(401);
    expect((await send(pending)).status).toBe(200);
    await expect(connectForkModelApiSocket(fixture.apiUrl!, "/v1/responses", { headers: auth })).rejects.toThrow("upgrade failed");
    const revoke = await manage("/api/keys", "DELETE", { id: "scoped" });
    expect(revoke.response.status).toBe(200);
    expect((await send(pending)).status).toBe(401);
    await expect(connectForkModelApiSocket(fixture.apiUrl!, "/v1/responses", { headers: { "x-opencodex-api-key": pending } })).rejects.toThrow("upgrade failed");
    const configured = rows().filter(row => row.inboundProtocol === "chat" && row.admissionKind === "configured");
    expect(configured).toHaveLength(4);
    expect(configured.every(row => row.apiKeyId === "scoped")).toBe(true);
    const logged = getRequestLogEntries().filter(row => row.inboundProtocol === "chat" && row.admissionKind === "configured");
    expect(logged).toHaveLength(4);
    expect(logged.every(row => row.apiKeyId === "scoped")).toBe(true);
    expect((await send("fixture-service-token")).status).toBe(200);
    expect(rows().at(-1)).toMatchObject({ admissionKind: "environment", inboundProtocol: "chat" });
    expect(rows().at(-1)!.apiKeyId).toBeUndefined();
    expect(getRequestLogEntries().find(row => row.admissionKind === "environment")!.apiKeyId).toBeUndefined();
  } finally { try { await fixture?.close(); } finally { await upstream.stop(true); } }
});

test("native origin policy and local reveal permission are not widened by the auxiliary listener", async () => {
  let calls = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return chatResponse(); } });
  let fixture: Awaited<ReturnType<typeof startForkModelApiFixture>> | undefined;
  try {
    fixture = await startForkModelApiFixture(config(upstream.url.toString(), { corsAllowOrigins: ["https://fixture-allowed.test"] }), { upstreamUrl: upstream.url.toString() });
    const send = (origin: string) => fetch(`${fixture.apiUrl}/v1/chat/completions`, { method: "POST", headers: { ...auth, origin, "content-type": "application/json" }, body: JSON.stringify(textBody()) });
    const blocked = await send("https://fixture-blocked.test");
    expect(blocked.status).toBe(403); expect(calls).toBe(0);
    expect(blocked.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(blocked.headers.get("access-control-allow-origin")).not.toBe("https://fixture-blocked.test");
    const allowed = await send("https://fixture-allowed.test");
    expect(allowed.status).toBe(200); await allowed.text();
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://fixture-allowed.test");
    expect(calls).toBe(1);
    for (const [url, status] of [[fixture.primaryUrl, 403], [fixture.apiUrl, 404]] as const) {
      const reveal = await fetch(`${url}/api/keys/reveal`, { method: "POST", headers: { "x-opencodex-api-key": fixture.adminToken, "content-type": "application/json" }, body: JSON.stringify({ id: "scoped" }) });
      expect(reveal.status).toBe(status);
      expect(await reveal.text()).not.toContain(KEY);
    }
    await waitForForkModelApi(() => fixture.server.pendingRequests === 0, "origin request release");
  } finally { try { await fixture?.close(); } finally { await upstream.stop(true); } }
});

import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/config";
import { resetContextRelayActivationForTests } from "../../src/codex/context-compat";
import { clearContextSessionOwnersForTests } from "../../src/codex/context-owner";
import { artifactHttpUrl, createImageBudget, materializeInlineImage } from "../../src/images/artifacts";
import { getActiveTurnCount } from "../../src/server/lifecycle";
import * as eagerRelay from "../../src/server/relay-eager";
import { setRelayPlatformForTests } from "../../src/server/responses/passthrough-delivery";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { connectForkModelApiSocket, startForkModelApiFixture, waitForForkModelApi } from "../helpers/fork-model-api-fixture";

const KEY = "ocx_data_fork_protocol_fixture";
const auth = { "x-opencodex-api-key": KEY };
const jsonHeaders = { ...auth, "content-type": "application/json" };
const account = "fixture-chatgpt-account";
const oauth = fakeChatGptJwt({ "https://api.openai.com/auth": { chatgpt_account_id: account }, exp: Math.floor(Date.now() / 1000) + 3600 });
const directHeaders = { ...jsonHeaders, authorization: `Bearer ${oauth}`, "chatgpt-account-id": account };

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { ...getDefaultConfig(), hostname: "127.0.0.1", port: 10101,
    forkModelApiListener: { enabled: true }, websockets: true,
    claudeCode: { intercept: { enabled: false } },
    defaultProvider: "openai-apikey",
    apiKeys: [{ id: "protocols", name: "protocols", key: KEY, createdAt: "2026-01-01T00:00:00Z" },
      { id: "other", name: "other", key: "ocx_data_fork_context_other", createdAt: "2026-01-01T00:00:00Z" }],
    providers: {
      "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-platform-key", authMode: "key", models: ["fixture-model"] },
    }, ...overrides };
}

function responsePayload(id = "resp_fixture") {
  return { id, object: "response", model: "fixture-model", status: "completed",
    output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "你好 fixture", annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
}

function responseEvents() {
  return [
    { type: "response.created", sequence_number: 0, response: { ...responsePayload(), status: "in_progress", output: [] } },
    { type: "response.output_text.delta", sequence_number: 1, output_index: 0, content_index: 0, item_id: "msg_fixture", delta: "你好 fixture" },
    { type: "response.completed", sequence_number: 2, response: responsePayload() },
  ];
}

function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("auxiliary Responses HTTP, compact and WebSocket retain native fields and event order", async () => {
  const received: Array<{ path: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as Record<string, unknown>;
    const path = new URL(req.url).pathname;
    received.push({ path, body, authorization: req.headers.get("authorization") });
    if (path.endsWith("/compact")) return Response.json({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "fixture-ciphertext" }], usage: { input_tokens: 3, output_tokens: 1 } });
    return body.stream ? sse(responseEvents()) : Response.json(responsePayload());
  } });
  let fixture: Awaited<ReturnType<typeof startForkModelApiFixture>> | undefined;
  let socket: WebSocket | undefined;
  try {
    fixture = await startForkModelApiFixture(config(), { upstreamUrl: upstream.url.toString() });
    const body = { model: "fixture-model", input: "native input", stream: false, metadata: { fixture: "kept" } };
    const response = await fetch(`${fixture.apiUrl}/v1/responses`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: "response", output: [{ content: [{ text: "你好 fixture" }] }] });
    expect(received[0]).toMatchObject({ path: "/v1/responses", body: { model: "fixture-model", input: "native input", metadata: { fixture: "kept" } }, authorization: "Bearer fixture-platform-key" });
    const compact = await fetch(`${fixture.apiUrl}/v1/responses/compact`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ model: "fixture-model", input: [] }) });
    expect(compact.status).toBe(200);
    expect(await compact.json()).toMatchObject({ object: "response.compaction", output: [{ encrypted_content: "fixture-ciphertext" }] });
    expect(received.at(-1)!.path).toBe("/v1/responses/compact");
    expect(received.at(-1)!.body).toMatchObject({ model: "fixture-model", input: [] });
    const connected = await connectForkModelApiSocket(fixture.apiUrl!, "/v1/responses", { headers: auth });
    socket = connected.socket;
    socket.send(JSON.stringify({ type: "response.create", model: "fixture-model", input: "ws input", metadata: { fixture: "socket" } }));
    await waitForForkModelApi(() => connected.frames.some(frame => JSON.parse(frame).type === "response.completed"), "Responses completion");
    const frames = connected.frames.map(frame => JSON.parse(frame));
    expect(frames.map(frame => frame.type)).toEqual(["response.created", "response.output_text.delta", "response.completed"]);
    expect(frames[1].delta).toBe("你好 fixture");
    expect(received.at(-1)!.body).toMatchObject({ model: "fixture-model", input: "ws input", metadata: { fixture: "socket" } });
    socket.close();
    await waitForForkModelApi(() => getActiveTurnCount() === 0, "Responses turn release");
  } finally { socket?.close(); try { await fixture?.close(); } finally { await upstream.stop(true); } }
});

test("native Messages/count preserve query, body and upstream errors; Chat keeps its own wire shape", async () => {
  const received: Array<{ path: string; query: string; body: unknown; credential: string | null }> = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "fixture-chat", object: "model" }] });
    received.push({ path: url.pathname, query: url.search, body: await req.json(), credential: req.headers.get("x-api-key") });
    if (url.searchParams.has("fail")) return Response.json({ type: "error", error: { type: "overloaded_error", message: "fixture overload" } }, { status: 529 });
    if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 17 });
    if (url.pathname.endsWith("/messages")) return Response.json({ id: "msg_native", type: "message", role: "assistant", model: "claude-fixture", content: [{ type: "text", text: "native message" }], stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 2 } });
    return Response.json({ id: "chat_fixture", object: "chat.completion", model: "fixture-chat", choices: [{ index: 0, message: { role: "assistant", content: "native chat" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  } });
  let fixture: Awaited<ReturnType<typeof startForkModelApiFixture>> | undefined;
  try {
    fixture = await startForkModelApiFixture(config({ defaultProvider: "chat", providers: {
      chat: { adapter: "openai-chat", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true, apiKey: "fixture-chat-key", models: ["fixture-chat"] },
    } }), { upstreamUrl: upstream.url.toString() });
    const body = { model: "claude-fixture", max_tokens: 64, messages: [{ role: "user", content: "hello native" }], metadata: { user_id: "fixture-user" } };
    const headers = { ...jsonHeaders, "x-api-key": "sk-ant-test-upstream", "anthropic-version": "2023-06-01" };
    for (const [path, expected] of [["/v1/messages?beta=true", { type: "message", content: [{ text: "native message" }] }], ["/v1/messages/count_tokens?beta=true", { input_tokens: 17 }]] as const) {
      const response = await fetch(`${fixture.apiUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject(expected);
      expect(received.at(-1)).toMatchObject({ query: "?beta=true", body, credential: "sk-ant-test-upstream" });
    }
    const failed = await fetch(`${fixture.apiUrl}/v1/messages?fail=1`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(failed.status).toBe(529);
    expect(await failed.json()).toMatchObject({ error: { type: "overloaded_error", message: "fixture overload" } });
    const chat = await fetch(`${fixture.apiUrl}/v1/chat/completions`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ model: "chat/fixture-chat", messages: body.messages, temperature: 0.3 }) });
    expect(chat.status).toBe(200);
    expect(await chat.json()).toMatchObject({ object: "chat.completion", choices: [{ message: { content: "native chat" } }] });
    expect(received.at(-1)).toMatchObject({ path: "/v1/chat/completions", body: { model: "fixture-chat", messages: body.messages, temperature: 0.3 } });
    const models = await fetch(`${fixture.apiUrl}/v1/models`, { headers: auth });
    expect(models.status).toBe(200);
    expect(JSON.stringify(await models.json())).toContain("fixture-chat");
    const missing = await fetch(`${fixture.apiUrl}/v1/catalog`, { headers: auth });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "catalog_not_found" } });
    writeFileSync(join(fixture.codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture-chat", display_name: "Fixture Chat" }] }));
    const catalog = await fetch(`${fixture.apiUrl}/v1/catalog`, { headers: auth });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ models: [{ slug: "fixture-chat" }] });
  } finally { try { await fixture?.close(); } finally { await upstream.stop(true); } }
});

test("images and transcription use native sidecars and return usable relative artifacts", async () => {
  const received: Array<{ path: string; body: unknown; authorization: string | null }> = [];
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/transcriptions")) {
      const form = await req.formData();
      received.push({ path, body: { model: form.get("model"), language: form.get("language"), file: await (form.get("file") as File).text() }, authorization: req.headers.get("authorization") });
      return Response.json({ text: "你好 transcript" });
    }
    received.push({ path, body: await req.json(), authorization: req.headers.get("authorization") });
    return Response.json({ created: 42, data: [{ b64_json: image }] });
  } });
  let fixture: Awaited<ReturnType<typeof startForkModelApiFixture>> | undefined;
  try {
    fixture = await startForkModelApiFixture(config(), { upstreamUrl: upstream.url.toString() });
    const generated = await fetch(`${fixture.apiUrl}/v1/images/generations`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ model: "gpt-image-1", prompt: "fixture cat", response_format: "url" }) });
    expect(generated.status).toBe(200);
    const payload = await generated.json() as { data: Array<{ url?: string; b64_json?: string }> };
    expect(received[0]).toMatchObject({ path: "/v1/images/generations", body: { model: "gpt-image-1", prompt: "fixture cat" }, authorization: "Bearer fixture-platform-key" });
    expect(payload.data[0]!.b64_json).toBe(image);
    const artifactUrl = artifactHttpUrl(await materializeInlineImage(payload.data[0]!.b64_json!, createImageBudget()));
    expect(artifactUrl).toMatch(/^\/v1\/opencodex\/artifacts\//);
    const artifact = await fetch(`${fixture.apiUrl}${artifactUrl}`, { headers: auth });
    expect(artifact.status).toBe(200);
    expect(Buffer.from(await artifact.arrayBuffer()).toString("base64")).toBe(image);
    expect((await fetch(`${fixture.apiUrl}${artifactUrl}`)).status).toBe(401);
    const form = new FormData();
    form.set("file", new File(["RIFF-fixture"], "fixture.wav", { type: "audio/wav" }));
    form.set("model", "gpt-4o-transcribe"); form.set("language", "zh");
    const transcript = await fetch(`${fixture.apiUrl}/v1/audio/transcriptions`, { method: "POST", headers: auth, body: form });
    expect(transcript.status).toBe(200);
    expect(await transcript.json()).toEqual({ text: "你好 transcript" });
    expect(received.at(-1)).toMatchObject({ path: "/v1/audio/transcriptions", body: { model: "gpt-4o-transcribe", language: "zh", file: "RIFF-fixture" }, authorization: "Bearer fixture-platform-key" });
    const oversized = new FormData();
    oversized.set("file", new File([new Uint8Array(25_000_001)], "large.wav", { type: "audio/wav" }));
    oversized.set("model", "gpt-4o-transcribe");
    const denied = await fetch(`${fixture.apiUrl}/v1/audio/transcriptions`, { method: "POST", headers: auth, body: oversized });
    expect(denied.status).toBe(413);
    expect(received).toHaveLength(2);
  } finally { try { await fixture?.close(); } finally { await upstream.stop(true); } }
});

test.each(["/v1/realtime/calls", "/v1/live"])("%s creation, Location, sideband and stop use the auxiliary socket", async path => {
  const offers: Array<{ path: string; sdp: string; session: unknown }> = [];
  const joins: Array<{ path: string; query: string; authorization: string | null }> = [];
  const incoming: string[] = [];
  let closed = false;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req, server) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") {
      joins.push({ path: url.pathname, query: url.search, authorization: req.headers.get("authorization") });
      if (server.upgrade(req)) return;
      return new Response("upgrade failed", { status: 400 });
    }
    const form = await req.formData();
    offers.push({ path: url.pathname, sdp: String(form.get("sdp")), session: JSON.parse(String(form.get("session"))) });
    return new Response("v=0\r\ns=fixture-answer\r\n", { status: 201, headers: { "content-type": "application/sdp", location: "/v1/realtime/calls/rtc_fixture" } });
  }, websocket: {
    open(ws) { ws.send(JSON.stringify({ type: "session.created", session: { id: "session_fixture" } })); },
    message(ws, message) { incoming.push(String(message)); ws.send(String(message)); },
    close() { closed = true; },
  } });
  let fixture: Awaited<ReturnType<typeof startForkModelApiFixture>> | undefined;
  let socket: WebSocket | undefined;
  try {
    fixture = await startForkModelApiFixture(config({ experimentalRealtimeWsBaseUrl: `ws://127.0.0.1:${upstream.port}/v1` }), { upstreamUrl: upstream.url.toString() });
    const created = await fetch(`${fixture.apiUrl}${path}`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ sdp: "v=0\r\ns=fixture-offer\r\n", session: { model: "gpt-realtime", instructions: "native session" } }) });
    expect(created.status).toBe(201);
    expect(await created.text()).toContain("fixture-answer");
    expect(offers).toEqual([{ path, sdp: "v=0\r\ns=fixture-offer\r\n", session: { model: "gpt-realtime", instructions: "native session" } }]);
    const location = created.headers.get("location")!;
    expect(location).toMatch(path === "/v1/live" ? /^\/v1\/live\/[^/]+$/ : /^\/v1\/realtime\/calls\/[^/]+$/);
    const client = await connectForkModelApiSocket(fixture.apiUrl!, location, { headers: auth });
    socket = client.socket;
    const frame = JSON.stringify({ type: "input_audio_buffer.append", audio: "AAEC" });
    socket.send(frame);
    await waitForForkModelApi(() => client.frames.includes(frame), `${path} round trip`);
    expect(incoming).toEqual([frame]);
    expect(JSON.parse(client.frames[0]!)).toMatchObject({ type: "session.created", session: { id: "session_fixture" } });
    expect(joins).toEqual([path === "/v1/live"
      ? { path: "/v1/live/rtc_fixture", query: "", authorization: "Bearer fixture-platform-key" }
      : { path: "/v1/realtime", query: "?intent=quicksilver&call_id=rtc_fixture", authorization: "Bearer fixture-platform-key" }]);
    await fixture.server.stop(true);
    await waitForForkModelApi(() => closed && socket!.readyState === WebSocket.CLOSED && getActiveTurnCount() === 0, `${path} stop release`);
  } finally { socket?.close(); try { await fixture?.close(); } finally { await upstream.stop(true); } }
});

test("Direct search, dictation carrier and context ownership preserve independent native credentials", async () => {
  const sent: Array<{ path: string; body: unknown; authorization: string | null }> = [];
  const socketProtocols: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (req.headers.get("upgrade") === "websocket") {
      socketProtocols.push(req.headers.get("sec-websocket-protocol") ?? "");
      if (server.upgrade(req, { headers: { "sec-websocket-protocol": "chatgpt-dictation" } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    sent.push({ path, body: await req.json(), authorization: req.headers.get("authorization") });
    if (path.endsWith("/alpha/search")) return Response.json({ encrypted_output: "fixture-search-cipher", output: "fixture search result" });
    if (path.includes("/alpha/notes/")) return Response.json({ value: "fixture owned note" });
    return Response.json(responsePayload());
  }, websocket: { message(ws, message) { ws.send(String(message)); } } });
  let fixture: Awaited<ReturnType<typeof startForkModelApiFixture>> | undefined;
  let socket: WebSocket | undefined;
  try {
    fixture = await startForkModelApiFixture(config({ defaultProvider: "openai", providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct", models: ["gpt-5.5"] },
    } }), { upstreamUrl: upstream.url.toString(), prepare({ codexHome }) {
      writeFileSync(join(codexHome, "config.toml"), "[features]\ncontext_management.experimental_mode = true\n");
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: oauth, account_id: account } }));
      resetContextRelayActivationForTests(); clearContextSessionOwnersForTests();
    } });
    const searchBody = { id: "fixture-search", model: "gpt-5.5", commands: { search_query: [{ q: "fixture query" }] } };
    const search = await fetch(`${fixture.apiUrl}/v1/alpha/search`, { method: "POST", headers: directHeaders, body: JSON.stringify(searchBody) });
    expect(search.status).toBe(200);
    expect(await search.json()).toEqual({ encrypted_output: "fixture-search-cipher", output: "fixture search result" });
    expect(sent.at(-1)).toMatchObject({ path: "/backend-api/codex/alpha/search", body: searchBody, authorization: `Bearer ${oauth}` });
    const sessionHeaders = { ...directHeaders, "session-id": "fixture-context", "thread-id": "fixture-context" };
    const model = await fetch(`${fixture.apiUrl}/v1/responses`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ model: "gpt-5.5", input: "context turn", stream: false }) });
    expect(model.status).toBe(200); await model.text();
    const notesBody = { context: { session_id: "fixture-context" }, path: "fixture-note" };
    const notes = await fetch(`${fixture.apiUrl}/v1/alpha/notes/v2/read_file`, { method: "POST", headers: sessionHeaders, body: JSON.stringify(notesBody) });
    expect(notes.status).toBe(200);
    expect(await notes.json()).toEqual({ value: "fixture owned note" });
    expect(sent.at(-1)).toMatchObject({ path: "/backend-api/codex/alpha/notes/v2/read_file", body: notesBody, authorization: `Bearer ${oauth}` });
    const before = sent.length;
    const wrongRoot = await fetch(`${fixture.apiUrl}/v1/alpha/notes/v2/read_file`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ context: { session_id: "another-root" } }) });
    expect(wrongRoot.status).toBe(409); expect(sent).toHaveLength(before);
    const wrongPrincipal = await fetch(`${fixture.apiUrl}/v1/alpha/notes/v2/read_file`, { method: "POST", headers: { ...sessionHeaders, "x-opencodex-api-key": "ocx_data_fork_context_other" }, body: JSON.stringify(notesBody) });
    expect(wrongPrincipal.status).toBe(409); expect(sent).toHaveLength(before);
    const protocols = ["opencodex-audio", `opencodex-key.${Buffer.from(KEY).toString("base64url")}`];
    const client = await connectForkModelApiSocket(fixture.apiUrl!, "/v1/audio/transcriptions/stream", protocols);
    socket = client.socket;
    expect(socket.protocol).toBe("opencodex-audio");
    expect(socket.protocol).not.toContain(KEY);
    const start = JSON.stringify({ type: "session.start", config: { input_audio_format: "pcm16", sample_rate_hz: 24000, num_channels: 1,
      max_buffer_size_bytes: 65536, max_utterance_duration_ms: 30000, session_ttl_ms: 300000, provider_mode: "buffered", transcript_delivery_mode: "final_only",
      vad: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 } } });
    const frame = JSON.stringify({ type: "audio.append", audio: "AAECBA==" });
    socket.send(start); socket.send(frame);
    await waitForForkModelApi(() => client.frames.includes(frame), "dictation audio round trip");
    expect(socketProtocols).toEqual([`chatgpt-dictation, openai-bearer.${oauth}, codex-desktop`]);
    expect(socketProtocols[0]).not.toContain(KEY);
  } finally {
    socket?.close(); try { await fixture?.close(); } finally { await upstream.stop(true); }
    resetContextRelayActivationForTests(); clearContextSessionOwnersForTests();
  }
});

test.each(["native", "win32"] as const)("SSE EOF, native failure and client cancellation release their admitted turns (%s)", async relayPlatform => {
  let upstreamCanceled = false;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { input: string };
    if (body.input === "failure") return sse([{ type: "response.created", response: { id: "resp_failed", status: "in_progress" } }, { type: "response.failed", response: { id: "resp_failed", status: "failed", error: { code: "fixture_error", message: "fixture stream failure" } } }]);
    if (body.input !== "cancel") return sse(responseEvents());
    req.signal.addEventListener("abort", () => { upstreamCanceled = true; });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(responseEvents()[0])}\n\n`)); }, cancel() { upstreamCanceled = true; } }), { headers: { "content-type": "text/event-stream" } });
  } });
  let fixture: Awaited<ReturnType<typeof startForkModelApiFixture>> | undefined;
  let restoreRelay: (() => void) | undefined;
  try {
    setRelayPlatformForTests(relayPlatform === "win32" ? "win32" : undefined);
    const originalRelay = eagerRelay.relaySseEagerBounded;
    // Production drains for up to 15s; this fixture retains its 2s cancellation deadline.
    const relaySpy = spyOn(eagerRelay, "relaySseEagerBounded").mockImplementation((body, upstream, hooks, options) =>
      originalRelay(body, upstream, hooks, { ...options, postCancelDrainMs: 30 }));
    restoreRelay = () => relaySpy.mockRestore();
    fixture = await startForkModelApiFixture(config(), { upstreamUrl: upstream.url.toString() });
    for (const input of ["success", "failure"]) {
      const response = await fetch(`${fixture.apiUrl}/v1/responses`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ model: "fixture-model", input, stream: true }) });
      expect(response.status).toBe(200);
      const events = (await response.text()).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      expect(events[0].type).toBe("response.created");
      expect(events.at(-1).type).toBe(input === "success" ? "response.completed" : "response.failed");
      if (input === "failure") expect(events.at(-1).response.error.code).toBe("fixture_error");
      await waitForForkModelApi(() => getActiveTurnCount() === 0, "SSE EOF release");
    }
    const abort = new AbortController();
    const response = await fetch(`${fixture.apiUrl}/v1/responses`, { method: "POST", headers: jsonHeaders, signal: abort.signal, body: JSON.stringify({ model: "fixture-model", input: "cancel", stream: true }) });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    abort.abort(); await reader.cancel().catch(error => { if (!(error instanceof DOMException && error.name === "AbortError")) throw error; });
    await waitForForkModelApi(() => upstreamCanceled && getActiveTurnCount() === 0, "SSE cancellation release");
    upstreamCanceled = false;
    const ws = await connectForkModelApiSocket(fixture.apiUrl!, "/v1/responses", { headers: auth });
    try {
      ws.socket.send(JSON.stringify({ type: "response.create", model: "fixture-model", input: "cancel" }));
      await waitForForkModelApi(() => ws.frames.some(frame => JSON.parse(frame).type === "response.created"), "in-flight WebSocket response");
      const cancellationDeadline = performance.now() + 2_000;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          ws.socket.removeEventListener("close", onClose);
          ws.socket.removeEventListener("error", onError);
        };
        const onClose = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("WebSocket close handshake failed")); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for WebSocket close handshake")); }, 2_000);
        ws.socket.addEventListener("close", onClose, { once: true });
        ws.socket.addEventListener("error", onError, { once: true });
        try { ws.socket.close(); } catch (error) { cleanup(); reject(error); }
      });
      expect(ws.socket.readyState).toBe(WebSocket.CLOSED);
      await waitForForkModelApi(() => upstreamCanceled, "WebSocket upstream cancellation", Math.max(0, cancellationDeadline - performance.now()));
      await waitForForkModelApi(() => getActiveTurnCount() === 0, "WebSocket admitted turn release", Math.max(0, cancellationDeadline - performance.now()));
    } finally { ws.socket.close(); }
  } finally {
    try { try { await fixture?.close(); } finally { await upstream.stop(true); } }
    finally { setRelayPlatformForTests(undefined); restoreRelay?.(); }
  }
});

test("missing native capability credentials and disabled context retain their native refusals", async () => {
  const fixture = await startForkModelApiFixture(config({ providers: { local: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, models: ["fixture"] } }, defaultProvider: "local" }));
  try {
    for (const path of ["/v1/images/generations", "/v1/alpha/search", "/v1/realtime/calls"]) {
      const response = await fetch(`${fixture.apiUrl}${path}`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ model: "gpt-image-1", prompt: "fixture", sdp: "v=0", commands: { search_query: [{ q: "fixture" }] } }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty("error");
    }
    const context = await fetch(`${fixture.apiUrl}/v1/alpha/notes/v2/read_file`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ context: { session_id: "fixture-disabled" } }) });
    expect(context.status).toBe(404);
  } finally { await fixture.close(); }
});

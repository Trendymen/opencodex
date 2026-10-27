import { describe, expect, test } from "bun:test";
import { createCodexPassthroughFixture, disabledCodexPassthrough } from "../helpers/codex-passthrough-fixture";
import { resetSkillsSnapshotCacheForTests } from "../../src/server/responses/skills-snapshot";
import { prepareCodexHttpInit, prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import { resolveCodexPassthroughPermissions } from "../../src/fork/codex-passthrough-contract";
import { rememberResponseState, clearResponseStateForTests } from "../../src/responses/state";
import { encodeCompactionSummary } from "../../src/responses/compaction";
import { getArtifactsDir, artifactHttpUrl } from "../../src/images/artifacts";
import { join } from "node:path";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { buildToolBridgeMaps } from "../../src/server/responses/collaboration";
import { parseRequest } from "../../src/responses/parser";
import { handleResponses } from "../../src/server/responses/core";
import { ACCESS } from "../helpers/reserve-ingress-fixture";
import type { OcxConfig } from "../../src/types";
import type { CodexPassthroughConfig } from "../../src/fork/codex-passthrough-contract";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses/passthrough";

const upstream = async () => Response.json({ id: "resp_passthrough", status: "completed", model: "gpt-5.6-sol",
  output: [{ id: "msg_passthrough", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
const body = { model: "gpt-5.6-sol", stream: false, temperature: 0.2, max_output_tokens: 47,
  metadata: { caller: "keep" }, client_metadata: { caller_field: "keep", ws_request_header_x_openai_internal_codex_responses_lite: "false" },
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "original" }] }],
  unknown_valid_field: { order: [3, 1, 2], annotations: [{ type: "custom", field: "keep" }] } };

describe("official request permission controls", () => {
  test("hosted history automatic projection follows only the parameter permission", () => {
    const history = [{ type: "web_search_call", id: "synthetic-search", status: "completed", action: { type: "search", query: "synthetic", queries: ["synthetic"] } }];
    for (const nativeCompaction of [false, true]) for (const declared of ["none", "tools", "additional_tools"] as const) {
      for (const mode of ["off", "normalize", "expand", "default", "opt-in", "noncanonical"] as const) {
        const raw = { model: body.model, stream: true, tools: declared === "tools" ? [{ type: "web_search" }] : [],
          input: [...history, ...(declared === "additional_tools" ? [{ type: "additional_tools", tools: [{ type: "web_search" }] }] : [])] };
        const parsed = parseRequest(raw); parsed._compactionRequest = nativeCompaction;
        const permissions = mode === "default" ? undefined : resolveCodexPassthroughPermissions({ ...disabledCodexPassthrough(),
          ...(mode === "normalize" ? { normalizeRequestParameters: true } : {}), ...(mode === "expand" ? { expandRequestHistory: true } : {}) });
        const provider = { adapter: "openai-responses" as const, authMode: mode === "noncanonical" ? "key" as const : "forward" as const,
          baseUrl: mode === "noncanonical" ? "https://gateway.example.test/v1" : "https://chatgpt.com/backend-api/codex",
          ...(mode === "opt-in" ? { projectResponsesLiteHostedSearchHistory: true } : {}) };
        const budget = createTranslatorBudget();
        try {
          const request = createResponsesPassthroughAdapter(provider).buildRequest(parsed, { translatorBudget: budget,
            headers: new Headers({ "x-openai-internal-codex-responses-lite": "true" }), codexPassthroughPermissions: permissions });
          const sent = JSON.parse(request.body as string);
          const projected = mode === "opt-in" || mode === "noncanonical" && nativeCompaction
            || declared === "none" && ["normalize", "default", "noncanonical"].includes(mode);
          expect(sent.input.some((item: { type: string }) => item.type === "web_search_call"), JSON.stringify({ nativeCompaction, declared, mode })).toBe(!projected);
          expect(raw.input[0]).toEqual(history[0]); request.releaseBodyObservation?.();
        } finally { budget.dispose(); }
      }
    }
  });

  for (const stream of [true, undefined]) test(`all-off preserves stream presence despite a registry streaming policy (${stream})`, async () => {
    const entry = getProviderRegistryEntry("openai")!; const previous = entry.modelResponsesUpstreamStreaming;
    entry.modelResponsesUpstreamStreaming = { [body.model]: false };
    let fixture: Awaited<ReturnType<typeof createCodexPassthroughFixture>> | undefined;
    try {
      fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
        config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
      } });
      const request: Record<string, unknown> = { ...body };
      if (stream === undefined) delete request.stream; else request.stream = stream;
      const response = await fixture.request(request); await response.text();
      expect(response.status).toBe(200); expect(fixture.seen[0]!.body).toEqual(request);
    } finally { if (previous === undefined) delete entry.modelResponsesUpstreamStreaming; else entry.modelResponsesUpstreamStreaming = previous; await fixture?.close(); }
  });

  const variants: Array<[string, CodexPassthroughConfig | undefined]> = [["unset", undefined], ["empty", {}],
    ["all true", resolveCodexPassthroughPermissions(undefined)], ["parameters disabled", { normalizeRequestParameters: false }]];
  for (const [label, permissions] of variants) for (const mode of ["guidance", "plaintext"] as const) {
    test(`${label}: original ${mode} opt-in retains its guards`, async () => {
      const normalize = permissions?.normalizeRequestParameters !== false;
        const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
          config.providers.openai!.codexPassthrough = permissions as CodexPassthroughConfig | undefined;
          config.plaintextV2AgentMessages = mode === "plaintext";
          config.multiAgentGuidanceEnabled = mode === "guidance";
        } });
        try {
          const tools = mode === "guidance"
            ? [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }, { type: "function", name: "send_input", parameters: { type: "object" } }]
            : [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }] }];
          const response = await fixture.request({ ...body, tools, reasoning: { effort: "max" } });
          await response.text(); expect(response.status).toBe(200);
          const sent = fixture.seen[0]!.body as { input: Array<{ role?: string; content?: Array<{ text?: string }> }>; tools: Array<{ name?: string; tools?: Array<{ name?: string }> }> };
          if (mode === "guidance") {
            expect(sent.input.filter(item => item.role === "developer" && item.content?.some(part => part.text?.includes("<multi_agent_mode>")))).toHaveLength(normalize ? 1 : 0);
          } else {
            expect(sent.tools[0]!.name).toBe(normalize ? "collaboration-optimize" : "collaboration");
            expect(sent.tools[0]!.tools![0]!.name).toBe(normalize ? "start_delegated_task" : "spawn_agent");
          }
        } finally { await fixture.close(); }
    });
  }
  for (const mode of ["direct", "pool"] as const) {
    test(`all_off_preserves_unknown_json_and_existing_metadata (${mode})`, async () => {
      const fixture = await createCodexPassthroughFixture({ mode, upstream, configure(config) {
        config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
      } });
      try {
        const response = await fixture.request(body, { "x-codex-routing-hint": "caller-hint", "x-openai-internal-codex-responses-lite": "true", "thread-id": "caller-thread" });
        expect(response.status).toBe(200); await response.text();
        expect(fixture.seen).toHaveLength(1);
        expect(fixture.seen[0]!.body).toEqual(body);
        expect(fixture.seen[0]!.headers.get("x-codex-routing-hint")).toBe("caller-hint");
        expect(fixture.seen[0]!.headers.get("session_id")).toBeNull();
      } finally { await fixture.close(); }
    });
  }

  for (const mode of ["direct", "pool"] as const) for (const row of [
    { label: "default synthesis", synthesizeRoutingHint: undefined, want: "model=gpt-5.6-sol" },
    { label: "disabled synthesis", synthesizeRoutingHint: false, want: "provider-hint" },
    { label: "enabled synthesis", synthesizeRoutingHint: true, want: "model=gpt-5.6-sol" },
  ]) test(`static routing hint respects ${row.label} and independent Lite permission (${mode})`, async () => {
    for (const bridgeLiteMetadata of [false, true]) {
      const fixture = await createCodexPassthroughFixture({ mode, upstream, configure(config) {
        config.providers.openai!.headers = { "X-CoDeX-RoUtInG-HiNt": "provider-hint", "X-OpenAI-Internal-Codex-Responses-Lite": "false" };
        config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), synthesizeRoutingHint: row.synthesizeRoutingHint, bridgeLiteMetadata };
      } });
      try {
        const input = { ...body, client_metadata: { caller_field: "keep" } };
        const response = await fixture.request(input, { "x-codex-routing-hint": "caller-hint", "x-openai-internal-codex-responses-lite": "true" });
        await response.text(); expect(response.status).toBe(200);
        expect(fixture.seen).toHaveLength(1);
        expect(fixture.seen[0]!.headers.get("x-codex-routing-hint")).toBe(row.want);
        expect(fixture.seen[0]!.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
        expect(fixture.seen[0]!.body).toEqual({ ...input, client_metadata: bridgeLiteMetadata
          ? { caller_field: "keep", ws_request_header_x_openai_internal_codex_responses_lite: "true" } : input.client_metadata });
      } finally { await fixture.close(); }
    }
  });

  test("only_lite_permission_can_restore_lite_bridge", async () => {
    for (const bridgeLiteMetadata of [false, true]) {
      const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
        config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), bridgeLiteMetadata };
      } });
      try {
        const input = { ...body, client_metadata: { caller_field: "keep" } };
        const response = await fixture.request(input, { "x-openai-internal-codex-responses-lite": "true" });
        await response.text(); expect(response.status).toBe(200);
        expect(fixture.seen[0]!.body).toEqual({ ...input, client_metadata: bridgeLiteMetadata
          ? { caller_field: "keep", ws_request_header_x_openai_internal_codex_responses_lite: "true" } : input.client_metadata });
        expect(fixture.seen[0]!.headers.get("x-codex-routing-hint")).toBeNull();
      } finally { await fixture.close(); }
    }
  });

  test("continuation_cache_miss_is_optional_but_scope_mismatch_is_protected", async () => {
    for (const expandRequestHistory of [false, true]) {
      const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
        config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), expandRequestHistory };
      } });
      try {
        const input = { ...body, previous_response_id: "resp_unknown_caller_continuation" };
        const response = await fixture.request(input);
        const text = await response.text();
        expect(response.status).toBe(expandRequestHistory ? 400 : 200);
        if (expandRequestHistory) { expect(text).toContain("previous_response_not_found"); expect(fixture.seen).toHaveLength(0); }
        else { expect(fixture.seen).toHaveLength(1); expect(fixture.seen[0]!.body).toEqual(input); }
      } finally { await fixture.close(); }
    }
  });

  test("disabled official skill snapshot does not pin or replace later catalogs", async () => {
    resetSkillsSnapshotCacheForTests();
    const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
      config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
    } });
    try {
      for (const catalog of ["first catalog", "second catalog"]) {
        const input = { ...body, instructions: `<skills_instructions>${catalog}</skills_instructions>` };
        const response = await fixture.request(input, { "thread-id": "skills-thread" }); await response.text();
        expect(fixture.seen.at(-1)!.body).toEqual(input);
      }
    } finally { await fixture.close(); resetSkillsSnapshotCacheForTests(); }
  });

  test("HTTP and WS preparation cannot re-add disabled routing, Lite or other metadata", () => {
    const permissions = resolveCodexPassthroughPermissions(disabledCodexPassthrough());
    const init = { method: "POST", headers: { "x-codex-routing-hint": "caller-hint", "x-openai-internal-codex-responses-lite": "true", "x-codex-turn-state": "caller-state" }, body: JSON.stringify(body) };
    const url = "https://chatgpt.com/backend-api/codex/responses";
    const http = prepareCodexHttpInit(url, init, permissions);
    expect(new Headers(http.headers).get("x-codex-routing-hint")).toBe("caller-hint");
    const ws = prepareCodexWsRequest(url, init, permissions)!;
    const { stream: _stream, ...withoutStream } = body;
    expect(JSON.parse(ws.frameText)).toEqual({ ...withoutStream, type: "response.create" });
    expect(ws.headers["x-codex-routing-hint"]).toBe("caller-hint");
  });

  test("scope mismatch still refuses even with history expansion disabled", async () => {
    const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
      config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
    } });
    try {
      rememberResponseState(body, { id: "resp_other_task", status: "completed", output: [] }, undefined, { force: true, clientThreadId: "other-parent" });
      const response = await fixture.request({ ...body, previous_response_id: "resp_other_task" }, { "x-codex-parent-thread-id": "caller-parent" });
      expect(response.status).toBe(400); expect(await response.text()).toContain("previous_response_not_found");
      expect(fixture.seen).toHaveLength(0);
    } finally { clearResponseStateForTests(); await fixture.close(); }
  });

  test("each content permission restores its own processing with the others disabled", async () => {
    const annotation = '# Response annotations:\nEach item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. For every annotation you address, include its inline directive `:codex-annotation{index="N"}`, where N is its one-based array position (for example, `:codex-annotation{index="1"}`). Do not use unstructured annotation labels.';
    for (const permission of ["normalizeRequestParameters", "expandRequestHistory", "normalizeEncryptedContent", "rewriteAnnotationInstructions", "normalizeHostedImages"] as const) {
      const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
        config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), [permission]: true };
      } });
      try {
        let input: unknown = body;
        if (permission === "expandRequestHistory") {
          rememberResponseState({ ...body, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "prior history" }] }] },
            { id: "resp_owned_history", status: "completed", output: [] }, undefined, { force: true, clientThreadId: "caller-parent" });
          input = { ...body, previous_response_id: "resp_owned_history" };
        }
        if (permission === "normalizeEncryptedContent") input = { ...body, input: [{ type: "message", role: "user", content: [{ type: "encrypted_content", encrypted_content: "plain worker instruction" }] }] };
        if (permission === "rewriteAnnotationInstructions") input = { ...body, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: annotation }] }] };
        const filename = "img-codex-11111111-2222-3333-4444-555555555555.png";
        if (permission === "normalizeHostedImages") input = { ...body, input: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `![Generated image](<${join(getArtifactsDir(), filename)}>)` }] }] };
        const response = await fixture.request(input, { "x-codex-parent-thread-id": "caller-parent" }); await response.text();
        expect(response.status).toBe(200);
        const sent = fixture.seen[0]!.body as typeof body;
        if (permission === "normalizeRequestParameters") {
          const { temperature: _temperature, max_output_tokens: _max, metadata: _metadata, ...rest } = body;
          expect(sent).toEqual({ ...rest, stream: true, store: false });
        } else {
          expect(sent.stream).toBe(false); expect(sent.temperature).toBe(body.temperature); expect(sent.max_output_tokens).toBe(body.max_output_tokens);
          expect(sent.metadata).toEqual(body.metadata); expect(sent.client_metadata).toEqual(body.client_metadata);
          if (permission === "expandRequestHistory") { expect(JSON.stringify(sent.input)).toContain("prior history"); expect(sent).not.toHaveProperty("previous_response_id"); }
          if (permission === "normalizeEncryptedContent") expect(sent.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "plain worker instruction" }] }]);
          if (permission === "rewriteAnnotationInstructions") { expect(JSON.stringify(sent.input)).not.toContain('`'); expect(JSON.stringify(sent.input)).toContain('bare, unescaped text'); }
          if (permission === "normalizeHostedImages") expect(sent.input).toEqual([{ type: "message", role: "assistant", content: [{ type: "output_text", text: `![Generated image](<${artifactHttpUrl(filename)}>)` }] }]);
        }
        expect(fixture.seen[0]!.headers.get("x-codex-routing-hint")).toBeNull();
      } finally { clearResponseStateForTests(); await fixture.close(); }
    }
  });

  test("encrypted compatibility leaves reasoning strings alone and gates OCX compaction decoding", async () => {
    for (const normalizeEncryptedContent of [false, true]) {
      const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
        config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), normalizeEncryptedContent };
      } });
      try {
        const input = { ...body, input: [
          { type: "reasoning", id: "rs_opaque", summary: [], encrypted_content: "opaque-reasoning-string" },
          { type: "compaction", encrypted_content: encodeCompactionSummary("synthetic compaction summary") },
          { type: "message", role: "user", content: [{ type: "encrypted_content", encrypted_content: "plaintext typed block" }] },
        ] };
        const response = await fixture.request(input); await response.text(); expect(response.status).toBe(200);
        const sent = fixture.seen[0]!.body as { input: unknown[] };
        expect(sent.input[0]).toEqual(input.input[0]);
        if (!normalizeEncryptedContent) expect(sent).toEqual(input);
        else { expect(JSON.stringify(sent.input)).toContain("synthetic compaction summary"); expect(JSON.stringify(sent.input)).not.toContain("ocx1:"); }
      } finally { await fixture.close(); }
    }
  });

  for (const normalizeEncryptedContent of [undefined, false, true]) for (const identity of [
    { label: "same identity", native: false, reasoning: false, strip: false },
    { label: "native compaction mismatch", native: true, reasoning: false, strip: true },
    { label: "reasoning identity mismatch", native: false, reasoning: true, strip: true },
    { label: "both identity flags", native: true, reasoning: true, strip: true },
  ]) test(`compaction ciphertext permission ${normalizeEncryptedContent} with ${identity.label}`, async () => {
    for (const normalizeRequestParameters of [false, true]) {
      const native = { type: "compaction", encrypted_content: "native-cross-fixture" };
      const ocx = { type: "compaction", encrypted_content: "ocx1:Y29tcGFjdGlvbiBjcm9zcyBzdW1tYXJ5" };
      const input = { model: "gpt-5.6-sol", stream: true, input: [native, ocx] };
      const budget = createTranslatorBudget();
      try {
        const request = await createResponsesPassthroughAdapter({ adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" }).buildRequest({
          ...parseRequest(input), _stripNativeCompactionEncryptedContent: identity.native, _stripReasoningEncryptedContent: identity.reasoning,
        }, { headers: new Headers(), translatorBudget: budget, codexPassthroughPermissions: resolveCodexPassthroughPermissions({
          ...disabledCodexPassthrough(), normalizeRequestParameters, normalizeEncryptedContent,
        }) });
        expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
        const sent = JSON.parse(request.body);
        expect(sent.input[0]).toEqual(normalizeEncryptedContent !== false && identity.strip ? {
          type: "message", role: "user", content: [{ type: "input_text", text: "[earlier conversation was compacted; the summary is stored in a format this model cannot read]" }],
        } : { type: "compaction", encrypted_content: "native-cross-fixture" });
        if (normalizeEncryptedContent === false) expect(sent.input).toEqual([
          { type: "compaction", encrypted_content: "native-cross-fixture" },
          { type: "compaction", encrypted_content: "ocx1:Y29tcGFjdGlvbiBjcm9zcyBzdW1tYXJ5" },
        ]);
        else expect(sent.input[1]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: expect.stringContaining("compaction cross summary") }] });
        expect(input.input).toEqual([
          { type: "compaction", encrypted_content: "native-cross-fixture" },
          { type: "compaction", encrypted_content: "ocx1:Y29tcGFjdGlvbiBjcm9zcyBzdW1tYXJ5" },
        ]);
      } finally { budget.dispose(); }
    }
  });

  test("skill snapshot permission respects per-turn refresh and does not overwrite other processing", async () => {
    for (const catalog_refresh of ["per_session", "per_turn"] as const) {
      resetSkillsSnapshotCacheForTests();
      const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
        config.skills = { catalog_refresh };
        config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), snapshotSkillsCatalog: true };
      } });
      try {
        for (const catalog of ["first", "second"]) {
          const input = { ...body, instructions: `<skills_instructions>${catalog}</skills_instructions>` };
          const response = await fixture.request(input, { "thread-id": "snapshot-thread" }); await response.text();
          expect(fixture.seen.at(-1)!.body).toEqual({ ...input, instructions: `<skills_instructions>${catalog_refresh === "per_session" ? "first" : catalog}</skills_instructions>` });
        }
      } finally { await fixture.close(); resetSkillsSnapshotCacheForTests(); }
    }
  });

  test("caller session and static routing headers keep their precedence when synthesis is disabled", async () => {
    const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
      config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
      config.providers.openai!.headers = { "X-Codex-Routing-Hint": "static-hint" };
    } });
    try {
      for (const headers of [{ session_id: "caller-session" }, { "x-session-id": "caller-alias" }]) {
        const response = await fixture.request(body, { ...headers, "x-codex-routing-hint": "caller-hint" }); await response.text();
        const sent = fixture.seen.at(-1)!;
        expect(sent.body).toEqual(body);
        expect(sent.headers.get("session_id")).toBe("session_id" in headers ? "caller-session" : null);
        expect(sent.headers.get("x-codex-routing-hint")).toBe("static-hint");
      }
    } finally { await fixture.close(); }
  });

  test("all-off keeps typed content, OCX blobs, tools and nested metadata exactly", async () => {
    const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
      config.providers.openai!.codexPassthrough = disabledCodexPassthrough();
    } });
    try {
      const filename = "img-codex-11111111-2222-3333-4444-555555555555.png";
      const input = { ...body, instructions: "<skills_instructions>caller catalog</skills_instructions>",
        tools: [{ type: "function", name: "caller_tool", parameters: { type: "object", properties: { encrypted_content: { type: "string" } }, custom_schema_field: true } }],
        client_metadata: { caller_field: "keep", numeric_future_field: 7 },
        input: [
          { type: "reasoning", id: "rs_opaque", summary: [], encrypted_content: "opaque-reasoning-string" },
          { type: "compaction", encrypted_content: encodeCompactionSummary("synthetic summary") },
          { type: "message", id: "caller_custom_id", role: "assistant", content: [{ type: "output_text", text: `![Generated image](<${join(getArtifactsDir(), filename)}>)` }] },
          { type: "message", role: "user", content: [{ type: "encrypted_content", encrypted_content: "plain worker instruction" }] },
        ] };
      const response = await fixture.request(input); await response.text(); expect(response.status).toBe(200);
      expect(fixture.seen[0]!.body).toEqual(input);
      const permissions = resolveCodexPassthroughPermissions(disabledCodexPassthrough());
      const { stream: _stream, ...frameInput } = input;
      const ws = prepareCodexWsRequest("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: JSON.stringify(input) }, permissions)!;
      expect(JSON.parse(ws.frameText)).toEqual({ ...frameInput, type: "response.create" });
    } finally { await fixture.close(); }
  });

  test("Fernet shapes remain protected while split and plaintext conversions use only their permission", async () => {
    const raw = Buffer.alloc(73, 0x5a); raw[0] = 0x80; raw.writeBigUInt64BE(1_720_000_000n, 1);
    const token = raw.toString("base64url");
    const fernet = token + "=".repeat((4 - token.length % 4) % 4);
    for (const normalizeEncryptedContent of [false, true]) {
      for (const normalizeRequestParameters of [false, true]) {
        const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
          config.providers.openai!.codexPassthrough = { ...disabledCodexPassthrough(), normalizeEncryptedContent, normalizeRequestParameters };
        } });
        try {
          const input = { ...body, input: [{ type: "message", role: "user", content: [
            { type: "encrypted_content", encrypted_content: fernet + "\n" + fernet },
            { type: "encrypted_content", encrypted_content: "plain worker instruction" },
          ] }] };
          const response = await fixture.request(input); await response.text(); expect(response.status).toBe(200);
          const sent = fixture.seen[0]!.body as typeof input;
          expect(sent.input[0]!.content).toEqual(normalizeEncryptedContent ? [
            { type: "encrypted_content", encrypted_content: fernet }, { type: "encrypted_content", encrypted_content: fernet },
            { type: "input_text", text: "plain worker instruction" },
          ] : input.input[0]!.content);
        } finally { await fixture.close(); }
      }
    }
  });

  test("renamed provider with a model wire override still uses official permissions", async () => {
    const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(config) {
      config.providers.renamed = { ...config.providers.openai!, adapter: "openai-chat", modelAdapters: { "gpt-5.6-sol": "openai-responses" },
        codexPassthrough: disabledCodexPassthrough() };
      delete config.providers.renamed.codexAccountMode;
      config.defaultProvider = "renamed";
    } });
    try {
      const response = await fixture.request({ ...body, model: "renamed/gpt-5.6-sol" }); await response.text(); expect(response.status).toBe(200);
      expect(fixture.seen[0]!.body).toEqual(body);
      expect(fixture.seen[0]!.headers.get("x-codex-routing-hint")).toBeNull();
    } finally { await fixture.close(); }
  });

  test("disabled parameter normalization does not fold an upstream SSE into JSON", async () => {
    const event = { type: "response.completed", response: { id: "resp_raw_sse", status: "completed", output: [] } };
    const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream: async () => new Response(`data: ${JSON.stringify(event)}\n\n`,
      { headers: { "content-type": "text/event-stream" } }), configure(config) { config.providers.openai!.codexPassthrough = disabledCodexPassthrough(); } });
    try {
      const response = await fixture.request(body);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(await response.text()).toContain("data:");
      expect(fixture.seen[0]!.body).toEqual(body);
    } finally { await fixture.close(); }
  });

  test("canonical reparse replaces tool-map accounting instead of charging both views", async () => {
    const input = { ...body, tools: [{ type: "function", name: "synthetic_tool", parameters: { type: "object" } }] };
    const measured = createTranslatorBudget();
    buildToolBridgeMaps(parseRequest(input), measured);
    const existingMapCost = measured.snapshot().currentBytes;
    measured.dispose();
    expect(existingMapCost).toBeGreaterThan(0);
    let config!: OcxConfig;
    const fixture = await createCodexPassthroughFixture({ mode: "direct", upstream, configure(value) { config = value; } });
    const budget = createTranslatorBudget({ maxTurnBytes: existingMapCost });
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { authorization: `Bearer ${ACCESS}` }, body: JSON.stringify(input) }),
        config, { model: "", provider: "" }, { translatorBudget: budget });
      await response.text();
      expect(response.status).toBe(200);
      expect(fixture.seen).toHaveLength(1);
      expect(budget.snapshot().overflows).toBe(0);
    } finally { budget.dispose(); await fixture.close(); }
  });
});

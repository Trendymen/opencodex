import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

const message = {
  type: "message",
  id: "msg_final",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "最终回答", annotations: [] }],
};

const upstreamSse = [
  { type: "response.created", response: { id: "resp_phase", status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
  { type: "response.content_part.added", item_id: "msg_final", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
  { type: "response.output_text.delta", item_id: "msg_final", output_index: 0, content_index: 0, delta: "最终回答" },
  { type: "response.output_text.done", item_id: "msg_final", output_index: 0, content_index: 0, text: "最终回答" },
  { type: "response.content_part.done", item_id: "msg_final", output_index: 0, content_index: 0, part: message.content[0] },
  { type: "response.output_item.done", output_index: 0, item: message },
  { type: "response.completed", response: { id: "resp_phase", status: "completed", output: [message] } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");

afterEach(() => { globalThis.fetch = originalFetch; });

describe("provider-configured native Responses message phase repair", () => {
  test("labels a configured provider's terminal message final_answer in the streamed item and snapshot", async () => {
    globalThis.fetch = (async () => new Response(upstreamSse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    const config = {
      defaultProvider: "phase",
      providers: {
        phase: {
          adapter: "openai-responses",
          baseUrl: "https://phase.example.test/v1",
          authMode: "key",
          apiKey: "test-key",
          inferResponsesMessagePhaseModels: ["glm-5.3"],
        },
      },
    } as OcxConfig;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    const text = await response.text();
    const done = JSON.parse(text.split("\n").find(line => line.includes('"response.output_item.done"'))!.slice(6));
    const completed = JSON.parse(text.split("\n").find(line => line.includes('"response.completed"'))!.slice(6));

    expect(done.item.phase).toBe("final_answer");
    expect(completed.response.output[0].phase).toBe("final_answer");
  });

  test("labels a configured provider's terminal message final_answer in a non-stream response", async () => {
    globalThis.fetch = (async () => Response.json({
      id: "resp_phase_json",
      status: "completed",
      output: [message],
    })) as typeof fetch;
    const config = {
      defaultProvider: "phase",
      providers: {
        phase: {
          adapter: "openai-responses",
          baseUrl: "https://phase.example.test/v1",
          authMode: "key",
          apiKey: "test-key",
          inferResponsesMessagePhaseModels: ["glm-5.3"],
        },
      },
    } as OcxConfig;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", input: "ping", stream: false }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );

    expect((await response.json() as { output: Array<{ phase?: string }> }).output[0]?.phase)
      .toBe("final_answer");
  });

  test("does not infer phase from an assistant role introduced by JSON snapshot repair", async () => {
    globalThis.fetch = (async () => Response.json({
      id: "resp_user_snapshot",
      status: "completed",
      output: [{
        type: "message",
        id: "msg_user_snapshot",
        role: "user",
        status: "completed",
        content: [{ type: "output_text", text: "上游用户项" }],
      }],
    })) as typeof fetch;
    const config = {
      defaultProvider: "phase",
      providers: {
        phase: {
          adapter: "openai-responses",
          baseUrl: "https://phase.example.test/v1",
          authMode: "key",
          apiKey: "test-key",
          inferResponsesMessagePhaseModels: ["glm-5.3"],
          responsesSnapshotRepair: true,
        },
      },
    } as OcxConfig;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", input: "ping", stream: false }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    const body = await response.json() as { output: Array<{ phase?: string }> };

    expect(body.output[0]?.phase).toBeUndefined();
  });

  test("labels configured text before a native tool call commentary", async () => {
    const preamble = {
      type: "message",
      id: "msg_preamble",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "我先检查。", annotations: [] }],
    };
    const toolCall = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "exec",
      status: "completed",
      arguments: "{}",
    };
    const frames = [
      { type: "response.created", response: { id: "resp_tool", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...preamble, status: "in_progress", content: [] } },
      { type: "response.output_item.done", output_index: 0, item: preamble },
      { type: "response.output_item.added", output_index: 1, item: { ...toolCall, status: "in_progress" } },
      { type: "response.output_item.done", output_index: 1, item: toolCall },
      { type: "response.completed", response: { id: "resp_tool", status: "completed", output: [preamble, toolCall] } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    globalThis.fetch = (async () => new Response(frames, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    const config = {
      defaultProvider: "phase",
      providers: {
        phase: {
          adapter: "openai-responses",
          baseUrl: "https://phase.example.test/v1",
          authMode: "key",
          apiKey: "test-key",
          inferResponsesMessagePhaseModels: ["glm-5.3"],
        },
      },
    } as OcxConfig;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    const text = await response.text();
    const done = JSON.parse(text.split("\n").find(line => line.includes('"response.output_item.done"') && line.includes('"msg_preamble"'))!.slice(6));
    const completed = JSON.parse(text.split("\n").find(line => line.includes('"response.completed"'))!.slice(6));

    expect(done.item.phase).toBe("commentary");
    expect(completed.response.output[0].phase).toBe("commentary");
  });

  test("never repairs a GPT-named model even when its provider lists it", async () => {
    globalThis.fetch = (async () => new Response(upstreamSse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    const config = {
      defaultProvider: "phase",
      providers: {
        phase: {
          adapter: "openai-responses",
          baseUrl: "https://phase.example.test/v1",
          authMode: "key",
          apiKey: "test-key",
          inferResponsesMessagePhaseModels: ["gpt-compatible"],
        },
      },
    } as OcxConfig;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "phase/gpt-compatible", input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    const text = await response.text();
    const done = JSON.parse(text.split("\n").find(line => line.includes('"response.output_item.done"'))!.slice(6));

    expect(done.item.phase).toBeUndefined();
  });

  test("flushes an unclassified terminal item before [DONE] when completed is missing", async () => {
    const truncatedUpstream = [
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: message })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    globalThis.fetch = (async () => new Response(truncatedUpstream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    const config = {
      defaultProvider: "phase",
      providers: {
        phase: {
          adapter: "openai-responses",
          baseUrl: "https://phase.example.test/v1",
          authMode: "key",
          apiKey: "test-key",
          inferResponsesMessagePhaseModels: ["glm-5.3"],
        },
      },
    } as OcxConfig;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    const text = await response.text();
    const done = JSON.parse(text.split("\n").find(line => line.includes('"response.output_item.done"'))!.slice(6));

    expect(done.item).toEqual(message);
    expect(text.indexOf('"response.output_item.done"')).toBeLessThan(text.indexOf("data: [DONE]"));
  });

  test("frames an unclassified terminal item at clean EOF when completed is missing", async () => {
    const cleanEofUpstream = `data: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: message,
    })}\n\n`;
    globalThis.fetch = (async () => new Response(cleanEofUpstream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    const config = {
      defaultProvider: "phase",
      providers: {
        phase: {
          adapter: "openai-responses",
          baseUrl: "https://phase.example.test/v1",
          authMode: "key",
          apiKey: "test-key",
          inferResponsesMessagePhaseModels: ["glm-5.3"],
        },
      },
    } as OcxConfig;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    const text = await response.text();
    const frames = text.split(/\n\n/).filter(frame => frame.length > 0);

    expect(frames).toHaveLength(3);
    expect(JSON.parse(frames[0]!.split("\n").find(line => line.startsWith("data: "))!.slice(6)).item).toEqual(message);
    const incomplete = JSON.parse(frames[1]!.split("\n").find(line => line.startsWith("data: "))!.slice(6));
    expect(incomplete).toMatchObject({ type: "response.incomplete", response: { incomplete_details: { reason: "adapter_eof" } } });
    expect(frames[2]).toBe("data: [DONE]");
    expect(text.endsWith("\n\n")).toBe(true);
  });

  test("flushes an unclassified terminal item before a synthetic failed response on reader reset", async () => {
    const encoder = new TextEncoder();
    let reads = 0;
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: 0,
            item: message,
          })}\n\n`));
          return;
        }
        controller.error(new Error("upstream reset"));
      },
    });
    globalThis.fetch = (async () => new Response(upstreamBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    const config = {
      defaultProvider: "phase",
      providers: {
        phase: {
          adapter: "openai-responses",
          baseUrl: "https://phase.example.test/v1",
          authMode: "key",
          apiKey: "test-key",
          inferResponsesMessagePhaseModels: ["glm-5.3"],
        },
      },
    } as OcxConfig;

    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    const text = await response.text();
    expect(text).toContain('"response.output_item.done"');
    const done = JSON.parse(text.split("\n").find(line => line.includes('"response.output_item.done"'))!.slice(6));

    expect(done.item).toEqual(message);
    expect(text.indexOf('"response.output_item.done"')).toBeLessThan(text.indexOf('"response.failed"'));
  });
});

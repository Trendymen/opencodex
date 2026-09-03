import { describe, expect, test } from "bun:test";

import { consumeForInspection, relaySseWithFailedTail } from "../src/server/relay";
import { relaySseEagerBounded, type EagerRelayHooks } from "../src/server/relay-eager";

const encoder = new TextEncoder();

function sse(event: string, payload: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const OVERLOAD = {
  type: "error",
  error: {
    type: "server_error",
    code: "server_is_overloaded",
    message: "Our servers are currently overloaded. Please try again later.",
  },
};

function eagerHooks(synthetics: string[] = []): EagerRelayHooks {
  return {
    inspectChunk: () => {},
    finishInspection: () => {},
    sawTerminal: () => false,
    onSynthetic: kind => synthetics.push(kind),
    onClientCancel: () => {},
    onDone: () => {},
  };
}

function failedPayload(text: string): Record<string, unknown> {
  const payload = text.split("event: response.failed\ndata: ")[1]?.split("\n\n")[0];
  if (!payload) throw new Error("missing response.failed payload");
  return JSON.parse(payload) as Record<string, unknown>;
}

function assertOverloadFailure(text: string): void {
  expect(count(text, "event: response.failed")).toBe(1);
  expect(text).not.toContain('"reason":"adapter_eof"');
  expect(text).toContain('"type":"server_error"');
  expect(text).toContain('"code":"server_is_overloaded"');
  expect(text).toContain(OVERLOAD.error.message);
  expect(text).not.toContain("event: error");
  expect(text).not.toContain('"type":"error"');
  expect(count(text, "data: [DONE]")).toBe(1);
}

describe("fork overload error clean-EOF fidelity", () => {
  test("pull relay preserves an upstream overload error as response.failed at clean EOF", async () => {
    const text = await readAll(relaySseWithFailedTail(streamFromChunks([
      sse("response.created", { type: "response.created", response: { id: "resp_pull", status: "in_progress" } }),
      sse("error", OVERLOAD),
    ]), new AbortController()));

    assertOverloadFailure(text);
  });

  test("eager relay preserves an upstream overload error as response.failed at clean EOF", async () => {
    const synthetics: string[] = [];
    const text = await readAll(relaySseEagerBounded(streamFromChunks([
      sse("response.created", { type: "response.created", response: { id: "resp_eager", status: "in_progress" } }),
      sse("error", OVERLOAD),
    ]), new AbortController(), eagerHooks(synthetics)));

    assertOverloadFailure(text);
    expect(synthetics).toEqual(["upstream-error"]);
  });

  test.each([
    ["pull", () => relaySseWithFailedTail(streamFromChunks([sse("response.created", { type: "response.created" })]), new AbortController())],
    ["eager", () => relaySseEagerBounded(streamFromChunks([sse("response.created", { type: "response.created" })]), new AbortController(), eagerHooks())],
  ])("%s relay keeps adapter_eof when clean EOF has no usable error", async (_lane, relay) => {
    const text = await readAll(relay());

    expect(count(text, "event: response.incomplete")).toBe(1);
    expect(text).toContain('"reason":"adapter_eof"');
    expect(count(text, "data: [DONE]")).toBe(1);
  });

  test.each([
    ["pull", "response.completed", () => relaySseWithFailedTail(streamFromChunks([sse("error", OVERLOAD), sse("response.completed", { type: "response.completed", response: { status: "completed", output: [] } })]), new AbortController())],
    ["eager", "response.completed", () => relaySseEagerBounded(streamFromChunks([sse("error", OVERLOAD), sse("response.completed", { type: "response.completed", response: { status: "completed", output: [] } })]), new AbortController(), eagerHooks())],
    ["pull", "response.failed", () => relaySseWithFailedTail(streamFromChunks([sse("error", OVERLOAD), sse("response.failed", { type: "response.failed", response: { status: "failed", error: { code: "real_failure" } } })]), new AbortController())],
    ["eager", "response.failed", () => relaySseEagerBounded(streamFromChunks([sse("error", OVERLOAD), sse("response.failed", { type: "response.failed", response: { status: "failed", error: { code: "real_failure" } } })]), new AbortController(), eagerHooks())],
    ["pull", "response.incomplete", () => relaySseWithFailedTail(streamFromChunks([sse("error", OVERLOAD), sse("response.incomplete", { type: "response.incomplete", response: { status: "incomplete" } })]), new AbortController())],
    ["eager", "response.incomplete", () => relaySseEagerBounded(streamFromChunks([sse("error", OVERLOAD), sse("response.incomplete", { type: "response.incomplete", response: { status: "incomplete" } })]), new AbortController(), eagerHooks())],
  ])("%s relay defers to an explicit %s terminal", async (_lane, terminalType, relay) => {
    const text = await readAll(relay());

    expect(count(text, `event: ${terminalType}`)).toBe(1);
    expect(text).not.toContain("event: error");
    expect(text).not.toContain('"type":"error"');
    expect(text).not.toContain('"reason":"adapter_eof"');
    expect(count(text, "data: [DONE]")).toBe(1);
  });

  test("tee inspection classifies overload clean EOF as failed 503", async () => {
    const terminals: Array<[string, number | undefined]> = [];
    const done = Promise.withResolvers<void>();
    consumeForInspection(
      streamFromChunks([sse("error", OVERLOAD)]),
      (status, httpStatus) => terminals.push([status, httpStatus]),
      undefined,
      () => done.resolve(),
    );

    await done.promise;
    expect(terminals).toEqual([["failed", 503]]);
  });

  test("clean-EOF failure envelope redacts, bounds, and drops unrelated upstream fields", async () => {
    const typeSecret = "Authorization: Bearer type-secret-abcdef";
    const codeSecret = "x-api-key: code-secret-abcdef";
    const messageSecret = "Authorization: Bearer message-secret-abcdef";
    const text = await readAll(relaySseWithFailedTail(streamFromChunks([sse("error", {
      type: "error",
      trace: "x".repeat(128 * 1024),
      response: { id: "must-not-copy", output: ["must-not-copy"] },
      error: {
        type: `${typeSecret}${"t".repeat(1024)}`,
        code: `${codeSecret}${"c".repeat(1024)}`,
        message: `${messageSecret}${"m".repeat(4096)}`,
      },
    })]), new AbortController()));
    const payload = failedPayload(text);
    const response = payload.response as { status?: string; error?: Record<string, string>; last_error?: Record<string, string> };

    expect(payload).toEqual({ type: "response.failed", response: expect.any(Object) });
    expect(response.status).toBe("failed");
    expect(response.error).toEqual(response.last_error);
    expect(response.error?.type.length).toBeLessThanOrEqual(128);
    expect(response.error?.code.length).toBeLessThanOrEqual(128);
    expect(response.error?.message.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(payload).length).toBeLessThan(2_048);
    expect(JSON.stringify(payload)).not.toContain("must-not-copy");
    expect(JSON.stringify(payload)).not.toContain(typeSecret);
    expect(JSON.stringify(payload)).not.toContain(codeSecret);
    expect(JSON.stringify(payload)).not.toContain(messageSecret);
  });
});

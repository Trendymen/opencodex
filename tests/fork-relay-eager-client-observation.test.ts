import { describe, expect, test } from "bun:test";
import { relaySseEagerBounded } from "../src/server/relay-eager";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function readText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  let output = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return output + decoder.decode();
    output += decoder.decode(value, { stream: true });
  }
}

describe("eager relay client-bound observation", () => {
  test("observes the synthetic EOF incomplete frame delivered to the client", async () => {
    const observed: string[] = [];
    const relay = relaySseEagerBounded(
      streamFrom('data: {"type":"response.created","response":{"status":"in_progress"}}\n\n'),
      new AbortController(),
      {
        inspectChunk: () => {},
        finishInspection: () => {},
        sawTerminal: () => false,
        onSynthetic: () => {},
        onClientCancel: () => {},
        onDone: () => {},
        onClientChunk: chunk => observed.push(decoder.decode(chunk)),
      },
    );

    const delivered = await readText(relay);
    expect(delivered).toContain("response.incomplete");
    expect(observed.join("")).toContain("response.incomplete");
  });

  test("observes the safe failure tail delivered after a client rewrite error", async () => {
    const observed: string[] = [];
    const relay = relaySseEagerBounded(
      streamFrom('data: {"type":"response.output_text.delta","delta":"x"}\n\n'),
      new AbortController(),
      {
        inspectChunk: () => {},
        finishInspection: () => {},
        sawTerminal: () => false,
        onSynthetic: () => {},
        onClientCancel: () => {},
        onDone: () => {},
        onClientChunk: chunk => observed.push(decoder.decode(chunk)),
        rewriteBlocks: () => {
          throw new Error("rewrite failed");
        },
      },
    );

    const delivered = await readText(relay);
    expect(delivered).toContain("response.failed");
    expect(observed.join("")).toContain("response.failed");
  });
});

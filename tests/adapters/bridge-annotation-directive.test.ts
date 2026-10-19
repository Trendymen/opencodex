import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

describe("annotation directive code spans reach the client bare", () => {
  const TICK = "`";
  const DIRECTIVE = ':codex-annotation{index="1"}';
  const SPAN = TICK + DIRECTIVE + TICK;

  test("a directive the model wrapped in backticks is delivered unquoted", async () => {
    // End-to-end through the real bridge, not just the filter: closeCurrentMessage re-sends the
    // accumulated text in output_text.done, content_part.done and output_item.done, so a filter
    // that rewrote only the deltas would leave the backticks in the saved transcript — and a
    // directive inside a code span is exactly what the client's chip builder skips.
    const events = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "问题出在 " },
      { type: "text_delta", text: SPAN },
      { type: "text_delta", text: " 这一层。" },
      { type: "done" },
    ]), "routed/model"));

    const answer = "问题出在 " + DIRECTIVE + " 这一层。";
    const streamed = events
      .filter(e => e.event === "response.output_text.delta")
      .map(e => e.data.delta as string)
      .join("");
    expect(streamed).toBe(answer);
    // The deltas and the closing text have to agree, or a reconnecting client renders one
    // answer while the transcript keeps the other (#3843).
    expect(events.find(e => e.event === "response.output_text.done")?.data.text).toBe(answer);
    expect(events.find(e => e.event === "response.content_part.done")?.data.part)
      .toMatchObject({ text: answer });
    const item = events.find(e => e.event === "response.output_item.done")?.data.item as {
      content: { text: string }[];
    };
    expect(item.content[0].text).toBe(answer);
  });

  test("the non-streaming path unwraps it too", () => {
    const json = buildResponseJSON([
      { type: "text_delta", text: "见 " + SPAN },
      { type: "done" },
    ], "routed/model");
    const output = json.output as { content: { text: string }[] }[];
    expect(output[0].content[0].text).toBe("见 " + DIRECTIVE);
  });

  test("a fenced block that exhibits the syntax keeps its span", async () => {
    const text = "```\n" + SPAN + "\n```\n";
    const events = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text },
      { type: "done" },
    ]), "routed/model"));
    expect(events.find(e => e.event === "response.output_text.done")?.data.text).toBe(text);
  });

  test("ordinary inline code is untouched", async () => {
    const events = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "run `ocx status` first" },
      { type: "done" },
    ]), "routed/model"));
    expect(events.find(e => e.event === "response.output_text.done")?.data.text)
      .toBe("run `ocx status` first");
  });

  test("a citation span and a directive span in one stream keep deltas and text equal", async () => {
    // Both filters hold text back and release it at close, so the composite path is the one that
    // has to keep the deltas equal to the closing text.
    const S = "\uE200";
    const P = "\uE202";
    const E = "\uE201";
    const events = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "见 " + SPAN + " 与引用" + S + "cite" + P },
      { type: "text_delta", text: "turn1view0" + E + "。" },
      { type: "done" },
    ]), "routed/model"));
    const answer = "见 " + DIRECTIVE + " 与引用。";
    const streamed = events
      .filter(e => e.event === "response.output_text.delta")
      .map(e => e.data.delta as string)
      .join("");
    expect(streamed).toBe(answer);
    expect(events.find(e => e.event === "response.output_text.done")?.data.text).toBe(answer);
  });
});

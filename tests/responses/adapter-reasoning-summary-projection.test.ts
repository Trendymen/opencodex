import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import {
  createReasoningSummaryChannelBlockRewrite,
  rewriteReasoningSummaryInJson,
  shouldProjectContentChannelReasoning,
} from "../../src/server/responses-reasoning-summary-rewrite";
import { relaySseWithBlockRewrite } from "../../src/server/sse-payload-rewrite";
import type { AdapterEvent } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { readAll, streamFromText } from "../helpers/sse-stream";

const chatProvider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };
const contentChannelRoute = { preserveReasoningContentModels: ["fixture-model"] };

async function readPayloads(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const text = await readAll(stream);
  return text.split("\n\n")
    .flatMap(frame => frame.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? [])
    .filter(data => data !== "[DONE]")
    .map(data => JSON.parse(data) as Record<string, unknown>);
}

async function bridgeChatReasoning(): Promise<string> {
  const budget = createTestTranslatorBudget();
  const adapter = createOpenAIChatAdapter(chatProvider);
  const response = new Response([
    'data: {"choices":[{"delta":{"reasoning_content":"Inspect the files first."}}]}\n\n',
    "data: [DONE]\n\n",
  ].join(""));
  return readAll(bridgeToResponsesSSE(adapter.parseStream(response, budget), "fixture-model", undefined, undefined, undefined, undefined, 2_000, {
    translatorBudget: budget,
  }));
}

async function project(raw: string): Promise<Record<string, unknown>[]> {
  const budget = createTestTranslatorBudget();
  return readPayloads(relaySseWithBlockRewrite(
    streamFromText(raw),
    createReasoningSummaryChannelBlockRewrite({ translatorBudget: budget }),
    budget,
  ));
}

async function* events(values: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  yield* values;
}

describe("adapter reasoning summary projection", () => {
  test("projects chat-adapter reasoning_content through the bridge into summary events and the terminal snapshot", async () => {
    const raw = await bridgeChatReasoning();
    expect(shouldProjectContentChannelReasoning({ reasoning: { summary: "detailed" } }, contentChannelRoute, "fixture-model")).toBe(true);

    const payloads = await project(raw);
    expect(payloads.some(payload => payload.type === "response.reasoning_summary_part.added")).toBe(true);
    expect(payloads.some(payload => payload.type === "response.reasoning_summary_text.delta")).toBe(true);
    const completed = payloads.find(payload => payload.type === "response.completed")?.response as { output: Record<string, unknown>[] };
    const reasoning = completed.output.find(item => item.type === "reasoning");
    expect(reasoning).toMatchObject({
      content: [{ type: "reasoning_text", text: "Inspect the files first." }],
      summary: [{ type: "summary_text" }],
    });
  });

  test("keeps the bridged bytes unchanged when the summary is none or the route has no content channel", async () => {
    const raw = await bridgeChatReasoning();
    const disabled = [
      { rawBody: { reasoning: { summary: "none" } }, provider: contentChannelRoute },
      { rawBody: { reasoning: { summary: "detailed" } }, provider: {} },
    ];

    for (const { rawBody, provider } of disabled) {
      expect(shouldProjectContentChannelReasoning(rawBody, provider, "fixture-model")).toBe(false);
      const mounted = shouldProjectContentChannelReasoning(rawBody, provider, "fixture-model")
        ? relaySseWithBlockRewrite(streamFromText(raw), createReasoningSummaryChannelBlockRewrite(), createTestTranslatorBudget())
        : streamFromText(raw);
      expect(await readAll(mounted)).toBe(raw);
    }
  });

  test("leaves Anthropic-style summary-channel bridge output unchanged at the mount point", async () => {
    const budget = createTestTranslatorBudget();
    const raw = await readAll(bridgeToResponsesSSE(events([
      { type: "thinking_delta", thinking: "Already summarized." },
      { type: "done" },
    ]), "fixture-model", undefined, undefined, undefined, undefined, 2_000, { translatorBudget: budget }));

    const projected = await readAll(relaySseWithBlockRewrite(
      streamFromText(raw),
      createReasoningSummaryChannelBlockRewrite({ translatorBudget: budget }),
      budget,
    ));
    expect(projected).toBe(raw);
    expect(projected).toContain("response.reasoning_summary_text.delta");
  });

  test("projects the served non-streaming JSON without changing the response retained for storage", () => {
    const stored = buildResponseJSON([
      { type: "reasoning_raw_delta", text: "Keep the raw reasoning." },
      { type: "done" },
    ], "fixture-model");
    const served = shouldProjectContentChannelReasoning(
      { reasoning: { summary: "detailed" } }, contentChannelRoute, "fixture-model",
    ) ? rewriteReasoningSummaryInJson(stored) as Record<string, unknown> : stored;
    const storedReasoning = (stored.output as Record<string, unknown>[]).find(item => item.type === "reasoning");
    const servedReasoning = (served.output as Record<string, unknown>[]).find(item => item.type === "reasoning");

    expect(storedReasoning).toMatchObject({ summary: [], content: [{ type: "reasoning_text", text: "Keep the raw reasoning." }] });
    expect(servedReasoning).toMatchObject({
      content: [{ type: "reasoning_text", text: "Keep the raw reasoning." }],
      summary: [{ type: "summary_text", text: "Keep the raw reasoning." }],
    });
  });
});

import { describe, expect, test } from "bun:test";
import {
  createReasoningSummaryChannelBlockRewrite,
} from "../src/server/responses-reasoning-summary-rewrite";
import { sseDataPayload } from "../src/server/sse-payload-rewrite";

function block(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function payloads(blocks: readonly string[]): Record<string, unknown>[] {
  return blocks.map(value => JSON.parse(sseDataPayload(value)!) as Record<string, unknown>);
}

describe("content-channel reasoning display projection", () => {
  test("buffers raw deltas until the first sentence can become a bold summary title", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const added = rewrite(block({
      type: "response.content_part.added",
      item_id: "rs_glm",
      output_index: 0,
      content_index: 0,
      part: { type: "reasoning_text", text: "" },
    }));
    expect(payloads(added)).toEqual([{
      type: "response.reasoning_summary_part.added",
      item_id: "rs_glm",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }]);

    expect(rewrite(block({
      type: "response.reasoning_text.delta",
      item_id: "rs_glm",
      output_index: 0,
      content_index: 0,
      delta: "Search GPT ",
    }))).toEqual([]);

    expect(payloads(rewrite(block({
      type: "response.reasoning_text.delta",
      item_id: "rs_glm",
      output_index: 0,
      content_index: 0,
      delta: "news. Then collect sources.",
    })))).toEqual([{
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_glm",
      output_index: 0,
      summary_index: 0,
      delta: "**Search GPT news.**\n\nSearch GPT news. Then collect sources.",
    }]);

    const terminal = payloads(rewrite(block({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_glm",
        status: "completed",
        content: [{ type: "reasoning_text", text: "Search GPT news. Then collect sources." }],
        summary: [],
      },
    })));
    const projected = "**Search GPT news.**\n\nSearch GPT news. Then collect sources.";
    expect(terminal).toEqual([
      {
        type: "response.reasoning_summary_text.done",
        item_id: "rs_glm",
        output_index: 0,
        summary_index: 0,
        text: projected,
      },
      {
        type: "response.reasoning_summary_part.done",
        item_id: "rs_glm",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: projected },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_glm",
          status: "completed",
          content: [{ type: "reasoning_text", text: "Search GPT news. Then collect sources." }],
          summary: [{ type: "summary_text", text: projected }],
        },
      },
    ]);
  });

  test("leaves a native GPT summary event byte-for-byte unchanged", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const native = block({
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_gpt",
      output_index: 0,
      summary_index: 0,
      delta: "**Searching for August 2026 GPT news**",
    });
    expect(rewrite(native)).toEqual([native]);
  });

  test("uses a Chinese sentence terminator for the bold title", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    expect(rewrite(block({
      type: "response.reasoning_text.delta",
      item_id: "rs_zh",
      output_index: 0,
      content_index: 0,
      delta: "检查最新 GPT 新闻。再整理来源。",
    }))).toEqual(expect.arrayContaining([
      expect.stringContaining('"delta":"**检查最新 GPT 新闻。**\\n\\n检查最新 GPT 新闻。再整理来源。"'),
    ]));
  });
});

import { describe, expect, test } from "bun:test";
import { createReasoningSummaryChannelBlockRewrite } from "../src/server/responses-reasoning-summary-rewrite";
import { sseDataPayload } from "../src/server/sse-payload-rewrite";

function block(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function payloads(blocks: readonly string[]): Record<string, unknown>[] {
  return blocks.map(value => JSON.parse(sseDataPayload(value)!) as Record<string, unknown>);
}

describe("content-channel reasoning block lifecycle", () => {
  test("closes a short single-part summary with the same projected text used by its terminal snapshot", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const itemId = "rs_short";
    const raw = "检查服务";
    const projected = "**检查服务**\n\n检查服务";
    const events = [
      ...rewrite(block({
        type: "response.content_part.added",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "reasoning_text", text: "" },
      })),
      ...rewrite(block({
        type: "response.reasoning_text.delta",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: raw,
      })),
      ...rewrite(block({
        type: "response.reasoning_text.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text: raw,
      })),
      ...rewrite(block({
        type: "response.content_part.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "reasoning_text", text: raw },
      })),
      ...rewrite(block({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: itemId,
          status: "completed",
          content: [{ type: "reasoning_text", text: raw }],
          summary: [],
        },
      })),
    ];

    expect(payloads(events)).toEqual([
      {
        type: "response.reasoning_summary_part.added",
        item_id: itemId,
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: itemId,
        output_index: 0,
        summary_index: 0,
        delta: projected,
      },
      {
        type: "response.reasoning_summary_text.done",
        item_id: itemId,
        output_index: 0,
        summary_index: 0,
        text: projected,
      },
      {
        type: "response.reasoning_summary_part.done",
        item_id: itemId,
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: projected },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: itemId,
          status: "completed",
          content: [{ type: "reasoning_text", text: raw }],
          summary: [{ type: "summary_text", text: projected }],
        },
      },
    ]);
  });
});

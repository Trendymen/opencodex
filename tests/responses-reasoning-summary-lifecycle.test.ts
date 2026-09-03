import { describe, expect, test } from "bun:test";
import { createReasoningSummaryChannelPayloadRewrite } from "../src/server/responses-reasoning-summary-rewrite";

const rewrite = createReasoningSummaryChannelPayloadRewrite();

function apply(payload: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(rewrite(JSON.stringify(payload))) as Record<string, unknown>;
}

describe("content-channel reasoning summary lifecycle", () => {
  test("maps the complete raw reasoning lifecycle into the summary lifecycle", () => {
    const rawLifecycle = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_glm", status: "in_progress", content: [], summary: [] },
      },
      {
        type: "response.content_part.added",
        item_id: "rs_glm",
        output_index: 0,
        content_index: 0,
        part: { type: "reasoning_text", text: "" },
      },
      {
        type: "response.reasoning_text.delta",
        item_id: "rs_glm",
        output_index: 0,
        content_index: 0,
        delta: "检查服务",
      },
      {
        type: "response.reasoning_text.done",
        item_id: "rs_glm",
        output_index: 0,
        content_index: 0,
        text: "检查服务",
      },
      {
        type: "response.content_part.done",
        item_id: "rs_glm",
        output_index: 0,
        content_index: 0,
        part: { type: "reasoning_text", text: "检查服务" },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_glm",
          status: "completed",
          content: [{ type: "reasoning_text", text: "检查服务" }],
          summary: [],
        },
      },
    ];

    const rewritten = rawLifecycle.map(apply);

    expect(rewritten[0]).toEqual(rawLifecycle[0]);
    expect(rewritten[1]).toEqual({
      type: "response.reasoning_summary_part.added",
      item_id: "rs_glm",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
    expect(rewritten[2]).toEqual({
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_glm",
      output_index: 0,
      summary_index: 0,
      delta: "检查服务",
    });
    expect(rewritten[3]).toEqual({
      type: "response.reasoning_summary_text.done",
      item_id: "rs_glm",
      output_index: 0,
      summary_index: 0,
      text: "检查服务",
    });
    expect(rewritten[4]).toEqual({
      type: "response.reasoning_summary_part.done",
      item_id: "rs_glm",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "检查服务" },
    });
    expect(rewritten[5]).toEqual({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_glm",
        status: "completed",
        content: [{ type: "reasoning_text", text: "检查服务" }],
        summary: [{ type: "summary_text", text: "检查服务" }],
      },
    });
  });

  test("leaves a native GPT summary lifecycle untouched", () => {
    const nativeSummaryEvents = [
      {
        type: "response.reasoning_summary_part.added",
        item_id: "rs_gpt",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_gpt",
        output_index: 0,
        summary_index: 0,
        delta: "Checking service state",
      },
      {
        type: "response.reasoning_summary_text.done",
        item_id: "rs_gpt",
        output_index: 0,
        summary_index: 0,
        text: "Checking service state",
      },
      {
        type: "response.reasoning_summary_part.done",
        item_id: "rs_gpt",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "Checking service state" },
      },
    ];

    expect(nativeSummaryEvents.map(apply)).toEqual(nativeSummaryEvents);
  });
});

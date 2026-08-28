import { describe, expect, test } from "bun:test";
import { createResponsesMessagePhaseBlockRewrite } from "../src/fork/responses-message-phase";
import { createReasoningSummaryChannelPayloadRewrite } from "../src/server/responses-reasoning-summary-rewrite";
import { sseDataPayload } from "../src/server/sse-payload-rewrite";

function sse(payload: Record<string, unknown>): string {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}`;
}

function payloads(blocks: readonly string[]): Record<string, unknown>[] {
  return blocks.map(block => JSON.parse(sseDataPayload(block)!) as Record<string, unknown>);
}

describe("provider conversion original-field preservation", () => {
  test("summary conversion retains raw reasoning content while adding summary", () => {
    const rewrite = createReasoningSummaryChannelPayloadRewrite();
    const item = {
      type: "reasoning",
      id: "rs_preserve",
      status: "completed",
      content: [{ type: "reasoning_text", text: "原始推理" }],
      summary: [],
      provider_metadata: { source: "provider" },
    };

    const done = JSON.parse(rewrite(JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item,
    })));
    expect(done).toEqual({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        ...item,
        summary: [{ type: "summary_text", text: "原始推理" }],
      },
    });
  });

  test("phase conversion retains every message field while adding commentary", () => {
    const rewrite = createResponsesMessagePhaseBlockRewrite();
    const item = {
      type: "message",
      id: "msg_preserve",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "我先检查。", annotations: [{ type: "file_citation" }] }],
      provider_metadata: { source: "provider" },
    };

    expect(rewrite(sse({ type: "response.output_item.done", output_index: 0, item }))).toEqual([]);
    const emitted = payloads(rewrite(sse({
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec", status: "in_progress", arguments: "{}" },
    })));
    expect(emitted.at(0)).toEqual({
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, phase: "commentary" },
    });
  });
});

import { describe, expect, test } from "bun:test";
import { createReasoningSummaryChannelBlockRewrite } from "../src/server/responses-reasoning-summary-rewrite";
import { sseDataPayload } from "../src/server/sse-payload-rewrite";

/**
 * Streaming aggregation for content-channel reasoning: after the bold first
 * part, raw reasoning is buffered and re-emitted as additional summary parts
 * (3 sentences or 500 code points, whichever comes first) so the Desktop
 * preview refreshes in GPT-like bursts instead of one monolithic item.
 */

function block(payload: Record<string, unknown>): string {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

function payloads(blocks: readonly string[]): Record<string, unknown>[] {
  return blocks.map(value => JSON.parse(sseDataPayload(value)!) as Record<string, unknown>);
}

const partAdded = "response.reasoning_summary_part.added";
const textDelta = "response.reasoning_summary_text.delta";
const textDone = "response.reasoning_summary_text.done";
const partDone = "response.reasoning_summary_part.done";

function added(item_id: string): string {
  return block({
    type: "response.content_part.added",
    item_id,
    output_index: 0,
    content_index: 0,
    part: { type: "reasoning_text", text: "" },
  });
}

function delta(item_id: string, text: string): string {
  return block({
    type: "response.reasoning_text.delta",
    item_id,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
}

describe("reasoning summary multi-part aggregation", () => {
  test("aggregates three sentences per part after the bold first part", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    rewrite(added("rs_a"));

    const first = "先检查服务状态。";
    const part0Text = "**" + first + "**\n\n" + first;
    expect(payloads(rewrite(delta("rs_a", first)))).toEqual([
      { type: textDelta, item_id: "rs_a", output_index: 0, summary_index: 0, delta: part0Text },
    ]);

    const second = "然后检查端口占用情况和进程列表。接着分析日志中的异常模式并定位可疑条目。最后汇总结论并给出修复建议。";
    expect(payloads(rewrite(delta("rs_a", second)))).toEqual([
      { type: textDone, item_id: "rs_a", output_index: 0, summary_index: 0, text: part0Text },
      { type: partDone, item_id: "rs_a", output_index: 0, summary_index: 0, part: { type: "summary_text", text: part0Text } },
      { type: partAdded, item_id: "rs_a", output_index: 0, summary_index: 1, part: { type: "summary_text", text: "" } },
      { type: textDelta, item_id: "rs_a", output_index: 0, summary_index: 1, delta: second },
      { type: textDone, item_id: "rs_a", output_index: 0, summary_index: 1, text: second },
      { type: partDone, item_id: "rs_a", output_index: 0, summary_index: 1, part: { type: "summary_text", text: second } },
    ]);

    expect(rewrite(delta("rs_a", "再补一句"))).toEqual([]);

    const fullText = "先检查服务状态。" + second + "再补一句";
    const terminal = payloads(rewrite(block({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_a",
        status: "completed",
        content: [{ type: "reasoning_text", text: fullText }],
        summary: [],
      },
    })));
    expect(terminal).toEqual([
      { type: partAdded, item_id: "rs_a", output_index: 0, summary_index: 2, part: { type: "summary_text", text: "" } },
      { type: textDelta, item_id: "rs_a", output_index: 0, summary_index: 2, delta: "再补一句" },
      { type: textDone, item_id: "rs_a", output_index: 0, summary_index: 2, text: "再补一句" },
      { type: partDone, item_id: "rs_a", output_index: 0, summary_index: 2, part: { type: "summary_text", text: "再补一句" } },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_a",
          status: "completed",
          content: [{ type: "reasoning_text", text: fullText }],
          summary: [
            { type: "summary_text", text: part0Text },
            { type: "summary_text", text: second },
            { type: "summary_text", text: "再补一句" },
          ],
        },
      },
    ]);
  });

  test("splits at 500 code points when the sentence threshold is not met", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    rewrite(added("rs_b"));
    rewrite(delta("rs_b", "第一句。"));

    const long = "x".repeat(600);
    const events = payloads(rewrite(delta("rs_b", long)));
    expect(events).toEqual([
      { type: textDone, item_id: "rs_b", output_index: 0, summary_index: 0, text: "**第一句。**\n\n第一句。" },
      { type: partDone, item_id: "rs_b", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "**第一句。**\n\n第一句。" } },
      { type: partAdded, item_id: "rs_b", output_index: 0, summary_index: 1, part: { type: "summary_text", text: "" } },
      { type: textDelta, item_id: "rs_b", output_index: 0, summary_index: 1, delta: "x".repeat(500) },
      { type: textDone, item_id: "rs_b", output_index: 0, summary_index: 1, text: "x".repeat(500) },
      { type: partDone, item_id: "rs_b", output_index: 0, summary_index: 1, part: { type: "summary_text", text: "x".repeat(500) } },
    ]);

    const doneEvents = payloads(rewrite(block({
      type: "response.reasoning_text.done",
      item_id: "rs_b",
      output_index: 0,
      content_index: 0,
      text: "第一句。" + long,
    })));
    expect(doneEvents).toEqual([
      { type: partAdded, item_id: "rs_b", output_index: 0, summary_index: 2, part: { type: "summary_text", text: "" } },
      { type: textDelta, item_id: "rs_b", output_index: 0, summary_index: 2, delta: "x".repeat(100) },
      { type: textDone, item_id: "rs_b", output_index: 0, summary_index: 2, text: "x".repeat(100) },
      { type: partDone, item_id: "rs_b", output_index: 0, summary_index: 2, part: { type: "summary_text", text: "x".repeat(100) } },
    ]);
  });

  test("caps a summary part at the third sentence even when one delta contains four", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    rewrite(added("rs_limit"));
    rewrite(delta("rs_limit", "标题。"));
    const events = payloads(rewrite(delta("rs_limit", "一。二。三。四。")));
    expect(events.find(event => event.type === textDelta && event.summary_index === 1)?.delta).toBe("一。二。三。");
  });

  test("flushes the residual buffer on done and reuses parts for the terminal state", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    rewrite(added("rs_c"));
    rewrite(delta("rs_c", "首句。"));
    rewrite(delta("rs_c", "第二句还没完"));

    const flushEvents = payloads(rewrite(block({
      type: "response.reasoning_text.done",
      item_id: "rs_c",
      output_index: 0,
      content_index: 0,
      text: "首句。第二句还没完",
    })));
    expect(flushEvents).toEqual([
      { type: textDone, item_id: "rs_c", output_index: 0, summary_index: 0, text: "**首句。**\n\n首句。" },
      { type: partDone, item_id: "rs_c", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "**首句。**\n\n首句。" } },
      { type: partAdded, item_id: "rs_c", output_index: 0, summary_index: 1, part: { type: "summary_text", text: "" } },
      { type: textDelta, item_id: "rs_c", output_index: 0, summary_index: 1, delta: "第二句还没完" },
      { type: textDone, item_id: "rs_c", output_index: 0, summary_index: 1, text: "第二句还没完" },
      { type: partDone, item_id: "rs_c", output_index: 0, summary_index: 1, part: { type: "summary_text", text: "第二句还没完" } },
    ]);

    expect(rewrite(block({
      type: "response.content_part.done",
      item_id: "rs_c",
      output_index: 0,
      content_index: 0,
      part: { type: "reasoning_text", text: "首句。第二句还没完" },
    }))).toEqual([]);

    const completed = payloads(rewrite(block({
      type: "response.completed",
      response: {
        id: "resp_c",
        status: "completed",
        output: [{
          type: "reasoning",
          id: "rs_c",
          status: "completed",
          content: [{ type: "reasoning_text", text: "首句。第二句还没完" }],
          summary: [],
        }],
      },
    })));
    const doneItem = completed[0].response as { output: Array<{ summary: unknown[] }> };
    expect(doneItem.output[0].summary).toEqual([
      { type: "summary_text", text: "**首句。**\n\n首句。" },
      { type: "summary_text", text: "第二句还没完" },
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import { createReasoningSummaryChannelBlockRewrite } from "../src/server/responses-reasoning-summary-rewrite";
import { sseDataPayload } from "../src/server/sse-payload-rewrite";

function block(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function namedBlock(payload: Record<string, unknown>): string {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function payloads(blocks: readonly string[]): Record<string, unknown>[] {
  return blocks.map(value => JSON.parse(sseDataPayload(value)!) as Record<string, unknown>);
}

function added(itemId: string): string {
  return block({
    type: "response.content_part.added",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "reasoning_text", text: "" },
  });
}

function delta(itemId: string, text: string): string {
  return block({
    type: "response.reasoning_text.delta",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
}

function lifecycle(events: Record<string, unknown>[], summaryIndex: number): string[] {
  return events
    .filter(event => event.summary_index === summaryIndex)
    .map(event => String(event.type));
}

describe("content-channel reasoning edge lifecycles", () => {
  test("closes every multi-part index once and never joins all parts into one text.done", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const itemId = "rs_multi";
    const first = "首句。";
    const later = "第二句。第三句。第四句。";
    const output = [
      ...payloads(rewrite(added(itemId))),
      ...payloads(rewrite(delta(itemId, first))),
      ...payloads(rewrite(delta(itemId, later))),
      ...payloads(rewrite(block({
        type: "response.reasoning_text.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text: first + later,
      }))),
      ...payloads(rewrite(block({
        type: "response.content_part.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "reasoning_text", text: first + later },
      }))),
    ];

    expect(lifecycle(output, 0)).toEqual([
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]);
    expect(lifecycle(output, 1)).toEqual([
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]);
    const indexOneDone = output.find(event =>
      event.type === "response.reasoning_summary_text.done" && event.summary_index === 1
    );
    expect(indexOneDone?.text).toBe(later);
  });

  test("EOF closes a short first part and a title-ready residual part before clearing state", () => {
    const short = createReasoningSummaryChannelBlockRewrite();
    payloads(short(added("rs_short_eof")));
    expect(short(delta("rs_short_eof", "短"))).toEqual([]);
    const shortFlush = payloads(short.flush!());
    expect(lifecycle(shortFlush, 0)).toEqual([
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]);
    expect(short.flush!()).toEqual([]);

    const residual = createReasoningSummaryChannelBlockRewrite();
    payloads(residual(added("rs_residual_eof")));
    payloads(residual(delta("rs_residual_eof", "首句。")));
    expect(residual(delta("rs_residual_eof", "残余"))).toEqual([]);
    const residualFlush = payloads(residual.flush!());
    expect(lifecycle(residualFlush, 0).slice(-2)).toEqual([
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]);
    expect(lifecycle(residualFlush, 1)).toEqual([
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]);
    expect(residualFlush.find(event => event.summary_index === 1 && event.type.endsWith("text.done"))?.text)
      .toBe("残余");
  });

  test("terminal-before-reasoning-done closes the item before its terminal snapshot", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const itemId = "rs_terminal_first";
    payloads(rewrite(added(itemId)));
    expect(rewrite(delta(itemId, "短"))).toEqual([]);
    const events = payloads(rewrite(block({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: itemId,
        status: "completed",
        encrypted_content: "opaque",
        content: [{ type: "reasoning_text", text: "短" }],
        summary: [],
      },
    })));

    expect(events.map(event => event.type)).toEqual([
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
    ]);
    const terminal = events.at(-1)!.item as Record<string, unknown>;
    expect(terminal.encrypted_content).toBe("opaque");
    expect(terminal.content).toEqual([{ type: "reasoning_text", text: "短" }]);
    expect(terminal.summary).toEqual([{ type: "summary_text", text: "**短**\n\n短" }]);
    expect(rewrite.flush!()).toEqual([]);
  });

  test("adds and closes summary part zero when upstream omits content_part events", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const itemId = "rs_sparse";
    expect(rewrite(delta(itemId, "think"))).toEqual([]);
    const events = payloads(rewrite(block({
      type: "response.reasoning_text.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: "think",
    })));
    expect(lifecycle(events, 0)).toEqual([
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]);
  });

  test("keeps text that appears only in reasoning_text.done as a residual part", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const itemId = "rs_done_suffix";
    payloads(rewrite(added(itemId)));
    payloads(rewrite(delta(itemId, "首句。")));
    const events = payloads(rewrite(block({
      type: "response.reasoning_text.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: "首句。只在 done 出现的尾文",
    })));
    expect(events.find(event => event.summary_index === 1 && event.type === "response.reasoning_summary_text.delta")?.delta)
      .toBe("只在 done 出现的尾文");
  });

  test("projects each reasoning item in response.completed from its own pending state", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    expect(rewrite(delta("rs_one", "第一项"))).toEqual([]);
    expect(rewrite(delta("rs_two", "第二项"))).toEqual([]);
    const events = payloads(rewrite(block({
      type: "response.completed",
      response: {
        id: "resp_two_items",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_one", content: [{ type: "reasoning_text", text: "第一项" }], summary: [] },
          { type: "reasoning", id: "rs_two", content: [{ type: "reasoning_text", text: "第二项" }], summary: [] },
        ],
      },
    })));
    const terminal = events.at(-1)!.response as { output: Array<{ summary: Array<{ text: string }> }> };
    expect(terminal.output[0].summary[0].text).toBe("**第一项**\n\n第一项");
    expect(terminal.output[1].summary[0].text).toBe("**第二项**\n\n第二项");
    expect(rewrite.flush!()).toEqual([]);
  });

  test("maps an empty content part done instead of swallowing its close event", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const itemId = "rs_empty";
    payloads(rewrite(added(itemId)));
    expect(payloads(rewrite(block({
      type: "response.content_part.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "reasoning_text", text: "" },
    })))).toEqual([{
      type: "response.reasoning_summary_part.done",
      item_id: itemId,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }]);
  });

  test("suppresses late raw close events after the output item terminal", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const itemId = "rs_late_close";
    payloads(rewrite(added(itemId)));
    expect(rewrite(delta(itemId, "短"))).toEqual([]);
    payloads(rewrite(block({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: itemId,
        content: [{ type: "reasoning_text", text: "短" }],
        summary: [],
      },
    })));

    expect(rewrite(block({
      type: "response.reasoning_text.done",
      item_id: itemId,
      output_index: 0,
      text: "短",
    }))).toEqual([]);
    expect(rewrite(block({
      type: "response.content_part.done",
      item_id: itemId,
      output_index: 0,
      part: { type: "reasoning_text", text: "短" },
    }))).toEqual([]);
  });

  test("reuses multipart projection in response.completed after output_item.done", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const itemId = "rs_terminal_then_completed";
    const first = "首句。";
    const later = "二句。三句。四句。";
    payloads(rewrite(added(itemId)));
    payloads(rewrite(delta(itemId, first)));
    payloads(rewrite(delta(itemId, later)));
    const item = {
      type: "reasoning",
      id: itemId,
      content: [{ type: "reasoning_text", text: first + later }],
      summary: [],
    };
    const outputTerminal = payloads(rewrite(block({
      type: "response.output_item.done",
      output_index: 0,
      item,
    }))).at(-1)!.item as { summary: Array<{ text: string }> };

    const completed = payloads(rewrite(block({
      type: "response.completed",
      response: { status: "completed", output: [item] },
    }))).at(-1)!.response as { output: Array<{ summary: Array<{ text: string }> }> };
    expect(completed.output[0].summary).toEqual(outputTerminal.summary);
    expect(completed.output[0].summary).toHaveLength(2);
  });

  test("closes buffered part zero before a content_part.done and suppresses its late text done", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const itemId = "rs_part_done_first";
    payloads(rewrite(added(itemId)));
    expect(rewrite(delta(itemId, "短"))).toEqual([]);
    const closed = payloads(rewrite(block({
      type: "response.content_part.done",
      item_id: itemId,
      output_index: 0,
      part: { type: "reasoning_text", text: "短" },
    })));
    expect(lifecycle(closed, 0)).toEqual([
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]);
    expect(rewrite(block({
      type: "response.reasoning_text.done",
      item_id: itemId,
      output_index: 0,
      text: "短",
    }))).toEqual([]);
  });

  test("flushes pending reasoning before a sparse response.completed terminal", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    expect(rewrite(delta("rs_sparse_completed", "短"))).toEqual([]);
    const events = payloads(rewrite(block({
      type: "response.completed",
      response: { status: "completed", output: [] },
    })));
    expect(events.slice(0, -1).map(event => event.type)).toEqual([
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]);
    expect(events.at(-1)?.type).toBe("response.completed");
    expect(rewrite.flush!()).toEqual([]);
  });

  test("closes an empty added part at EOF without inventing a Thinking summary", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    payloads(rewrite(added("rs_empty_eof")));
    const events = payloads(rewrite.flush!());
    expect(events).toEqual([{
      type: "response.reasoning_summary_part.done",
      item_id: "rs_empty_eof",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }]);
  });

  test("does not invent a Thinking summary when an empty part reaches output_item.done", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    payloads(rewrite(added("rs_empty_terminal")));
    const events = payloads(rewrite(block({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_empty_terminal",
        content: [],
        summary: [],
      },
    })));
    expect(events.map(event => event.type)).toEqual([
      "response.reasoning_summary_part.done",
      "response.output_item.done",
    ]);
    expect(JSON.stringify(events)).not.toContain("Thinking");
  });

  test("flushes pending reasoning before response.completed without an output array", () => {
    for (const response of [{ status: "completed" }, { status: "completed", output: null }]) {
      const rewrite = createReasoningSummaryChannelBlockRewrite();
      expect(rewrite(delta("rs_missing_output", "短"))).toEqual([]);
      const events = payloads(rewrite(block({ type: "response.completed", response })));
      expect(events.slice(0, -1).map(event => event.type)).toEqual([
        "response.reasoning_summary_part.added",
        "response.reasoning_summary_text.delta",
        "response.reasoning_summary_text.done",
        "response.reasoning_summary_part.done",
      ]);
      expect(events.at(-1)?.type).toBe("response.completed");
      expect(rewrite.flush!()).toEqual([]);
    }
  });

  test("does not reopen an empty part at response.completed", () => {
    for (const response of [
      { status: "completed", output: [] },
      { status: "completed" },
    ]) {
      const rewrite = createReasoningSummaryChannelBlockRewrite();
      payloads(rewrite(added("rs_empty_completed")));
      const close = payloads(rewrite(block({
        type: "response.content_part.done",
        item_id: "rs_empty_completed",
        output_index: 0,
        part: { type: "reasoning_text", text: "" },
      })));
      expect(close.map(event => event.type)).toEqual(["response.reasoning_summary_part.done"]);
      const terminal = payloads(rewrite(block({ type: "response.completed", response })));
      expect(JSON.stringify(terminal)).not.toContain("Thinking");
      expect(terminal.at(-1)?.type).toBe("response.completed");
    }
  });

  test("keeps the SSE event field aligned with each rewritten payload type", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const source = {
      type: "response.reasoning_text.delta",
      item_id: "rs_named_event",
      output_index: 0,
      delta: "首句。",
    };
    const events = rewrite(namedBlock(source));
    expect(events).toHaveLength(2);
    for (const event of events) {
      const payload = JSON.parse(sseDataPayload(event)!) as { type: string };
      expect(event).toStartWith(`event: ${payload.type}\n`);
    }
  });

  test("uses the 500-code-point boundary when it precedes the third sentence", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    payloads(rewrite(added("rs_first_boundary")));
    payloads(rewrite(delta("rs_first_boundary", "标题。")));
    const long = `${"x".repeat(600)}。${"y".repeat(600)}。${"z".repeat(600)}。`;
    const events = payloads(rewrite(delta("rs_first_boundary", long)));
    expect(events.find(event =>
      event.type === "response.reasoning_summary_text.delta" && event.summary_index === 1
    )?.delta).toBe("x".repeat(500));
  });

  test("maps a sparse reasoning_text.done without prior state", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const events = payloads(rewrite(block({
      type: "response.reasoning_text.done",
      item_id: "rs_done_only",
      output_index: 0,
      text: "仅终态文本",
    })));
    expect(events).toEqual([{
      type: "response.reasoning_summary_text.done",
      item_id: "rs_done_only",
      output_index: 0,
      summary_index: 0,
      text: "仅终态文本",
    }]);
  });

  test("does not invent Thinking for an empty reasoning_text.done", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    payloads(rewrite(added("rs_empty_text_done")));
    const events = payloads(rewrite(block({
      type: "response.reasoning_text.done",
      item_id: "rs_empty_text_done",
      output_index: 0,
      text: "",
    })));
    expect(events.map(event => event.type)).toEqual(["response.reasoning_summary_part.done"]);
    expect(JSON.stringify(events)).not.toContain("Thinking");
  });

  test("uses content_part.done text when it is the only reasoning text", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    payloads(rewrite(added("rs_part_text_only")));
    const events = payloads(rewrite(block({
      type: "response.content_part.done",
      item_id: "rs_part_text_only",
      output_index: 0,
      part: { type: "reasoning_text", text: "直接终态" },
    })));
    expect(events.map(event => event.type)).toEqual([
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]);
    expect(events.find(event => event.type === "response.reasoning_summary_text.done")?.text)
      .toBe("**直接终态**\n\n直接终态");
  });
});

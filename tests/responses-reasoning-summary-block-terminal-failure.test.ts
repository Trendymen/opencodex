import { describe, expect, test } from "bun:test";
import { createReasoningSummaryChannelBlockRewrite } from "../src/server/responses-reasoning-summary-rewrite";
import { relaySseWithBlockRewrite, sseDataPayload } from "../src/server/sse-payload-rewrite";
import { relaySseWithFailedTail } from "../src/server/relay";
import { relaySseEagerBounded } from "../src/server/relay-eager";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

function block(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
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

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("content-channel reasoning unsuccessful terminal lifecycle", () => {
  for (const terminalType of ["response.failed", "response.incomplete"] as const) {
    test(`${terminalType} closes pending summary before the terminal`, () => {
      const rewrite = createReasoningSummaryChannelBlockRewrite();
      const itemId = `rs_${terminalType}`;
      payloads(rewrite(added(itemId)));
      payloads(rewrite(delta(itemId, "首句。")));
      const terminal = {
        type: terminalType,
        response: {
          id: "resp_terminal",
          status: terminalType === "response.failed" ? "failed" : "incomplete",
          error: terminalType === "response.failed" ? { code: "upstream_failed" } : null,
          incomplete_details: terminalType === "response.incomplete" ? { reason: "max_output_chars" } : null,
          output: [],
        },
      };

      const events = payloads(rewrite(block(terminal)));
      expect(events.map(event => event.type)).toEqual([
        "response.reasoning_summary_text.done",
        "response.reasoning_summary_part.done",
        terminalType,
      ]);
      expect(events.at(-1)).toEqual(terminal);
      expect(rewrite(block({
        type: "response.content_part.done",
        item_id: itemId,
        output_index: 0,
        part: { type: "reasoning_text", text: "首句。" },
      }))).toEqual([]);
      expect(rewrite.flush!()).toEqual([]);
    });

    test(`${terminalType} closes sparse pending summary without an output array`, () => {
      const rewrite = createReasoningSummaryChannelBlockRewrite();
      const itemId = `rs_sparse_${terminalType}`;
      expect(rewrite(delta(itemId, "短"))).toEqual([]);
      const terminal = {
        type: terminalType,
        response: { status: terminalType === "response.failed" ? "failed" : "incomplete" },
      };

      const events = payloads(rewrite(block(terminal)));
      expect(events.map(event => event.type)).toEqual([
        "response.reasoning_summary_part.added",
        "response.reasoning_summary_text.delta",
        "response.reasoning_summary_text.done",
        "response.reasoning_summary_part.done",
        terminalType,
      ]);
      expect(events.at(-1)).toEqual(terminal);
      expect(rewrite.flush!()).toEqual([]);
    });

    test(`${terminalType} includes reasoning text that appears only in terminal output`, () => {
      const rewrite = createReasoningSummaryChannelBlockRewrite();
      const itemId = `rs_terminal_suffix_${terminalType}`;
      payloads(rewrite(added(itemId)));
      payloads(rewrite(delta(itemId, "首句。")));
      const terminalText = "首句。只在终态出现的尾文";
      const events = payloads(rewrite(block({
        type: terminalType,
        response: {
          status: terminalType === "response.failed" ? "failed" : "incomplete",
          output: [{
            type: "reasoning",
            id: itemId,
            encrypted_content: "opaque",
            content: [{ type: "reasoning_text", text: terminalText }],
            summary: [],
          }],
        },
      })));

      expect(events.find(event => event.type === "response.reasoning_summary_text.delta" && event.summary_index === 1)?.delta)
        .toBe("只在终态出现的尾文");
      const response = events.at(-1)!.response as { output: Array<Record<string, unknown>> };
      expect(response.output[0].encrypted_content).toBe("opaque");
      expect(response.output[0].content).toEqual([{ type: "reasoning_text", text: terminalText }]);
      expect(response.output[0].summary).toEqual([
        { type: "summary_text", text: "**首句。**\n\n首句。" },
        { type: "summary_text", text: "只在终态出现的尾文" },
      ]);
    });

    test(`${terminalType} after output_item.done does not close or reopen the item again`, () => {
      const rewrite = createReasoningSummaryChannelBlockRewrite();
      const itemId = `rs_closed_${terminalType}`;
      payloads(rewrite(added(itemId)));
      payloads(rewrite(delta(itemId, "短")));
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

      const terminal = { type: terminalType, response: { status: terminalType.slice("response.".length) } };
      expect(payloads(rewrite(block(terminal)))).toEqual([terminal]);
      expect(rewrite(added(itemId))).toEqual([]);
      expect(rewrite.flush!()).toEqual([]);
    });

    test(`${terminalType} reuses closed multipart projection in terminal output`, () => {
      const rewrite = createReasoningSummaryChannelBlockRewrite();
      const itemId = `rs_closed_parts_${terminalType}`;
      const first = "首句。";
      const later = "二句。三句。四句。";
      payloads(rewrite(added(itemId)));
      payloads(rewrite(delta(itemId, first)));
      payloads(rewrite(delta(itemId, later)));
      const item = {
        type: "reasoning",
        id: itemId,
        encrypted_content: "opaque",
        content: [{ type: "reasoning_text", text: first + later }],
        summary: [],
      };
      const outputTerminal = payloads(rewrite(block({
        type: "response.output_item.done",
        output_index: 0,
        item,
      }))).at(-1)!.item as { summary: Array<{ text: string }> };

      const terminal = payloads(rewrite(block({
        type: terminalType,
        response: { status: terminalType.slice("response.".length), output: [item] },
      }))).at(-1)!.response as { output: Array<{ summary: Array<{ text: string }> }> };
      expect(terminal.output[0].summary).toEqual(outputTerminal.summary);
      expect(terminal.output[0].summary).toHaveLength(2);
    });
  }

  test("duplicate content_part.added opens summary index zero only once", () => {
    const rewrite = createReasoningSummaryChannelBlockRewrite();
    const itemId = "rs_duplicate_added";
    expect(payloads(rewrite(added(itemId))).map(event => event.type)).toEqual([
      "response.reasoning_summary_part.added",
    ]);
    expect(rewrite(added(itemId))).toEqual([]);
    payloads(rewrite(delta(itemId, "短")));
    const terminal = payloads(rewrite(block({
      type: "response.incomplete",
      response: { status: "incomplete", output: [] },
    })));
    expect(terminal.filter(event => event.type === "response.reasoning_summary_part.done")).toHaveLength(1);
  });

  test("terminal-aware relay receives summary close before cancelling at failed", async () => {
    const itemId = "rs_failed_relay";
    const terminal = block({ type: "response.failed", response: { status: "failed", error: { code: "upstream_failed" } } });
    const budget = createTestTranslatorBudget();
    const rewritten = relaySseWithBlockRewrite(
      streamFromText(added(itemId) + delta(itemId, "首句。") + terminal),
      createReasoningSummaryChannelBlockRewrite(),
      budget,
    );

    const output = await new Response(relaySseWithFailedTail(rewritten, new AbortController())).text();
    expect(output.indexOf("response.reasoning_summary_text.done")).toBeLessThan(output.indexOf("response.failed"));
    expect(output.indexOf("response.reasoning_summary_part.done")).toBeLessThan(output.indexOf("response.failed"));
    expect(output).toEndWith("data: [DONE]\n\n");
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });

  test("eager terminal boundary receives summary close in the same failed chunk", async () => {
    const itemId = "rs_failed_eager";
    const terminal = block({ type: "response.failed", response: { status: "failed", error: { code: "upstream_failed" } } });
    const output = await new Response(relaySseEagerBounded(
      streamFromText(added(itemId) + delta(itemId, "首句。") + terminal),
      new AbortController(),
      {
        inspectChunk: () => {},
        finishInspection: () => {},
        sawTerminal: () => false,
        onSynthetic: () => {},
        onClientCancel: () => {},
        onDone: () => {},
        rewriteBlocks: createReasoningSummaryChannelBlockRewrite(),
      },
    )).text();

    expect(output.indexOf("response.reasoning_summary_text.done")).toBeLessThan(output.indexOf("response.failed"));
    expect(output.indexOf("response.reasoning_summary_part.done")).toBeLessThan(output.indexOf("response.failed"));
    expect(output).toEndWith("data: [DONE]\n\n");
  });
});

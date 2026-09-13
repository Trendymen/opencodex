import { describe, expect, test } from "bun:test";
import {
  createReasoningSummaryChannelBlockRewrite,
  createReasoningSummaryChannelPayloadRewrite,
  routeUsesContentChannelReasoning,
  rewriteReasoningSummaryInJson,
  rewriteReasoningSummaryInJsonString,
} from "../../src/server/responses-reasoning-summary-rewrite";
import { isTranslatorBudgetExceededError } from "../../src/lib/translator-budget";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const rewrite = createReasoningSummaryChannelPayloadRewrite();

function apply(payload: unknown): unknown {
  return JSON.parse(rewrite(JSON.stringify(payload)));
}

function sseBlock(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function ssePayloads(blocks: string[]): Record<string, unknown>[] {
  return blocks.map(block => JSON.parse(block.slice("data: ".length).trim()) as Record<string, unknown>);
}

describe("responses reasoning summary channel rewrite", () => {
  test("routes reasoning_text.delta through the summary channel", () => {
    expect(apply({
      type: "response.reasoning_text.delta",
      content_index: 0,
      delta: "think",
      item_id: "rs_1",
      output_index: 0,
      sequence_number: 4,
    })).toEqual({
      type: "response.reasoning_summary_text.delta",
      summary_index: 0,
      delta: "think",
      item_id: "rs_1",
      output_index: 0,
      sequence_number: 4,
    });
  });

  test("routes reasoning_text.done through the summary channel", () => {
    expect(apply({
      type: "response.reasoning_text.done",
      content_index: 0,
      text: "full thinking",
      item_id: "rs_1",
      output_index: 0,
    })).toEqual({
      type: "response.reasoning_summary_text.done",
      summary_index: 0,
      text: "full thinking",
      item_id: "rs_1",
      output_index: 0,
    });
  });

  test("adds a summary while retaining reasoning content on output_item.done", () => {
    expect(apply({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        content: [{ type: "reasoning_text", text: "thinking" }],
        summary: [],
      },
    })).toEqual({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        content: [{ type: "reasoning_text", text: "thinking" }],
        summary: [{ type: "summary_text", text: "thinking" }],
      },
    });
  });

  test("adds a summary while retaining reasoning content inside response.completed", () => {
    const payload = {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            status: "completed",
            content: [{ type: "reasoning_text", text: "thinking" }],
            summary: [],
          },
          { type: "message", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "OK" }] },
        ],
      },
    };
    const result = apply(payload) as { response: { output: Record<string, unknown>[] } };
    expect(result.response.output[0]).toEqual({
      type: "reasoning",
      id: "rs_1",
      status: "completed",
      content: [{ type: "reasoning_text", text: "thinking" }],
      summary: [{ type: "summary_text", text: "thinking" }],
    });
    expect(result.response.output[1]).toEqual(payload.response.output[1]);
  });

  test("leaves summary-channel and message events untouched", () => {
    const untouched = [
      { type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "s", item_id: "rs_1", output_index: 0 },
      { type: "response.output_text.delta", content_index: 0, delta: "OK", item_id: "msg_1", output_index: 1 },
      { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", status: "in_progress", content: [] } },
    ];
    for (const payload of untouched) {
      expect(apply(payload)).toEqual(payload);
    }
  });

  test("leaves a reasoning item without content text untouched", () => {
    expect(apply({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", status: "completed", content: [], summary: [] },
    })).toEqual({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", status: "completed", content: [], summary: [] },
    });
  });

  test("preserves a summary-channel reasoning item as-is", () => {
    expect(apply({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        content: [],
        summary: [{ type: "summary_text", text: "already summarized" }],
      },
    })).toEqual({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        content: [],
        summary: [{ type: "summary_text", text: "already summarized" }],
      },
    });
  });

  test("adds summaries to reasoning items inside a bare completed response document", () => {
    const doc = {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          status: "completed",
          content: [{ type: "reasoning_text", text: "thinking" }],
          summary: [],
        },
        { type: "message", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "OK" }] },
      ],
    };
    const result = rewriteReasoningSummaryInJson(doc) as { output: Record<string, unknown>[] };
    expect(result.output[0]).toEqual({
      type: "reasoning",
      id: "rs_1",
      status: "completed",
      content: [{ type: "reasoning_text", text: "thinking" }],
      summary: [{ type: "summary_text", text: "thinking" }],
    });
    expect(result.output[1]).toEqual(doc.output[1]);
  });

  test("adds summaries to reasoning items inside an SSE completed event document", () => {
    const doc = {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            status: "completed",
            content: [{ type: "reasoning_text", text: "thinking" }],
            summary: [],
          },
        ],
      },
    };
    const result = rewriteReasoningSummaryInJson(doc) as { response: { output: Record<string, unknown>[] } };
    expect(result.response.output[0]).toEqual({
      type: "reasoning",
      id: "rs_1",
      status: "completed",
      content: [{ type: "reasoning_text", text: "thinking" }],
      summary: [{ type: "summary_text", text: "thinking" }],
    });
  });

  test("string-level rewrite leaves summary-channel documents untouched", () => {
    const doc = JSON.stringify({
      id: "resp_1",
      output: [{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "already summarized" }] }],
    });
    expect(rewriteReasoningSummaryInJsonString(doc)).toBe(doc);
  });

  test("malformed payloads pass through unchanged", () => {
    expect(rewrite("not json")).toBe("not json");
    expect(rewrite("[1,2]")).toBe("[1,2]");
  });

  test("deduplicates a repeated sequence-numbered reasoning delta without changing the terminal raw content", () => {
    const stream = createReasoningSummaryChannelBlockRewrite();
    const first = {
      type: "response.reasoning_text.delta",
      item_id: "rs_1",
      output_index: 0,
      sequence_number: 1,
      delta: "First sentence.",
    };

    ssePayloads(stream(sseBlock(first)));
    expect(stream(sseBlock(first))).toEqual([]);

    const terminal = ssePayloads(stream(sseBlock({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        content: [{ type: "reasoning_text", text: "First sentence." }],
        summary: [],
      },
    })));
    const item = terminal.at(-1)?.item as Record<string, unknown>;

    expect(terminal.filter(payload => payload.type === "response.reasoning_summary_part.added")).toHaveLength(0);
    expect(item.content).toEqual([{ type: "reasoning_text", text: "First sentence." }]);
    expect(item.summary).toEqual([{ type: "summary_text", text: "**First sentence.**\n\nFirst sentence." }]);
  });

  test("ignores a late delta after output_item.done and preserves the original closed summary at response.completed", () => {
    const stream = createReasoningSummaryChannelBlockRewrite();
    ssePayloads(stream(sseBlock({
      type: "response.reasoning_text.delta",
      item_id: "rs_1",
      output_index: 0,
      sequence_number: 1,
      delta: "Initial sentence.",
    })));
    ssePayloads(stream(sseBlock({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        content: [{ type: "reasoning_text", text: "Initial sentence." }],
        summary: [],
      },
    })));

    expect(stream(sseBlock({
      type: "response.reasoning_text.delta",
      item_id: "rs_1",
      output_index: 0,
      sequence_number: 2,
      delta: "Late sentence.",
    }))).toEqual([]);

    const completed = ssePayloads(stream(sseBlock({
      type: "response.completed",
      response: {
        output: [{
          type: "reasoning",
          id: "rs_1",
          status: "completed",
          content: [{ type: "reasoning_text", text: "Initial sentence." }],
          summary: [],
        }],
      },
    })));
    const item = (completed.at(-1)?.response as { output: Record<string, unknown>[] }).output[0];

    expect(item.content).toEqual([{ type: "reasoning_text", text: "Initial sentence." }]);
    expect(item.summary).toEqual([{ type: "summary_text", text: "**Initial sentence.**\n\nInitial sentence." }]);
  });

  test("bounds sequence identities for an active item without a translator budget", () => {
    const stream = createReasoningSummaryChannelBlockRewrite();
    for (let sequenceNumber = 0; sequenceNumber < 256; sequenceNumber += 1) {
      expect(stream(sseBlock({
        type: "response.reasoning_text.delta",
        item_id: "rs_sequence_cap",
        output_index: 0,
        sequence_number: sequenceNumber,
        delta: "",
      }))).toEqual([]);
    }

    let overflow: unknown;
    try {
      stream(sseBlock({
        type: "response.reasoning_text.delta",
        item_id: "rs_sequence_cap",
        output_index: 0,
        sequence_number: 256,
        delta: "",
      }));
    } catch (error) {
      overflow = error;
    }

    if (!isTranslatorBudgetExceededError(overflow)) throw overflow;
    expect(overflow.kind).toBe("item_ids");
    expect(overflow.code).toBe("translation_buffer_limit");
  });

  test("charges and releases sequence identities on every reasoning terminal path", () => {
    const terminals: Array<readonly [string, (stream: ReturnType<typeof createReasoningSummaryChannelBlockRewrite>) => void]> = [
      ["output_item.done", stream => { stream(sseBlock({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "reasoning", id: "rs_release", status: "completed", content: [], summary: [] },
      })); }],
      ["response.completed", stream => { stream(sseBlock({
        type: "response.completed",
        response: { output: [] },
      })); }],
      ["response.failed", stream => { stream(sseBlock({
        type: "response.failed",
        response: { output: [] },
      })); }],
      ["response.incomplete", stream => { stream(sseBlock({
        type: "response.incomplete",
        response: { output: [] },
      })); }],
      ["flush", stream => { stream.flush!(); }],
      ["dispose", stream => { stream.dispose!(); }],
    ];

    for (const [name, terminate] of terminals) {
      const budget = createTestTranslatorBudget();
      const stream = createReasoningSummaryChannelBlockRewrite({ translatorBudget: budget });
      stream(sseBlock({
        type: "response.reasoning_text.delta",
        item_id: "rs_release",
        output_index: 0,
        sequence_number: 1,
        delta: "",
      }));
      expect(budget.snapshot().currentBytes, name).toBeGreaterThan(0);
      terminate(stream);
      expect(budget.snapshot().currentBytes, name).toBe(0);
    }
  });

  // `encrypted_content` is opaque, state-bearing provider data. Preserve it and the original
  // content verbatim while adding the summary Desktop needs for its terminal snapshot.
  describe("items carrying encrypted_content", () => {
    const blobItem = {
      type: "reasoning",
      id: "rs_1",
      status: "completed",
      encrypted_content: "gAAAAAB-upstream-issued-blob",
      content: [{ type: "reasoning_text", text: "thinking" }],
      summary: [],
    };

    test("keep opaque state and raw content while adding a summary on output_item.done", () => {
      const payload = { type: "response.output_item.done", output_index: 0, item: blobItem };
      expect(apply(payload)).toEqual({
        ...payload,
        item: { ...blobItem, summary: [{ type: "summary_text", text: "thinking" }] },
      });
    });

    test("keep opaque state and raw content while adding a summary inside response.completed", () => {
      const payload = {
        type: "response.completed",
        response: { id: "resp_1", output: [blobItem] },
      };
      expect(apply(payload)).toEqual({
        ...payload,
        response: { ...payload.response, output: [{ ...blobItem, summary: [{ type: "summary_text", text: "thinking" }] }] },
      });
    });

    test("keep opaque state and raw content while adding a summary through the non-streaming document rewrite", () => {
      const doc = { id: "resp_1", object: "response", output: [blobItem] };
      const expected = {
        ...doc,
        output: [{ ...blobItem, summary: [{ type: "summary_text", text: "thinking" }] }],
      };
      expect(rewriteReasoningSummaryInJson(doc)).toEqual(expected);
      const json = JSON.stringify(doc);
      expect(rewriteReasoningSummaryInJsonString(json)).toBe(JSON.stringify(expected));
    });

;

    // Only the stored item is protected: the live trace Codex renders comes from the delta events,
    // which carry no blob and are still routed to the summary channel.
    test("do not disable the delta rewrite that renders the live trace", () => {
      expect(apply({
        type: "response.reasoning_text.delta",
        delta: "think",
        item_id: "rs_1",
        output_index: 0,
      })).toMatchObject({ type: "response.reasoning_summary_text.delta", delta: "think" });
    });
  });
});

describe("routeUsesContentChannelReasoning", () => {
  test("statelessResponses providers use the content channel", () => {
    expect(routeUsesContentChannelReasoning({ statelessResponses: true }, "deepseek-v4-flash")).toBe(true);
  });

  test("preserveReasoningContentModels lists qualify", () => {
    expect(routeUsesContentChannelReasoning(
      { preserveReasoningContentModels: ["deepseek-v4-flash"] },
      "deepseek-v4-flash",
    )).toBe(true);
  });

  test("model matching is case-insensitive on both sides", () => {
    expect(routeUsesContentChannelReasoning(
      { preserveReasoningContentModels: ["DeepSeek-V4-Flash"] },
      "deepseek-v4-flash",
    )).toBe(true);
    expect(routeUsesContentChannelReasoning(
      { preserveReasoningContentModels: ["deepseek-v4-flash"] },
      "DeepSeek-V4-Flash",
    )).toBe(true);
  });

  test("other providers do not", () => {
    expect(routeUsesContentChannelReasoning({}, "gpt-5.5")).toBe(false);
  });
});

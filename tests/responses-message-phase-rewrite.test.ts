import { describe, expect, test } from "bun:test";
import {
  createResponsesMessagePhaseBlockRewrite,
  routeUsesResponsesMessagePhaseInference,
  rewriteResponsesMessagePhasesInJson,
} from "../src/fork/responses-message-phase";
import { sseDataPayload } from "../src/server/sse-payload-rewrite";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

function sse(payload: Record<string, unknown>): string {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}`;
}

function payloads(blocks: readonly string[]): Record<string, unknown>[] {
  return blocks.map(block => JSON.parse(sseDataPayload(block)!) as Record<string, unknown>);
}

describe("native Responses message-phase repair", () => {
  test("enables only configured non-GPT and non-OpenAI model ids", () => {
    const provider = { inferResponsesMessagePhaseModels: ["glm-5.3", "KIMI-K3", "gpt-5.6"] };

    expect(routeUsesResponsesMessagePhaseInference(provider, "glm-5.3")).toBe(true);
    expect(routeUsesResponsesMessagePhaseInference(provider, "kimi-k3")).toBe(true);
    expect(routeUsesResponsesMessagePhaseInference(provider, "gpt-5.6")).toBe(false);
    expect(routeUsesResponsesMessagePhaseInference({ inferResponsesMessagePhaseModels: ["openai-compatible"] }, "openai-compatible")).toBe(false);
    expect(routeUsesResponsesMessagePhaseInference(provider, "deepseek-v4-flash")).toBe(false);
  });

  test("never enables inference on an OpenAI-operated Responses destination", () => {
    const configuredModels = ["o3", "o4-mini", "codex-mini-latest"];
    for (const provider of [
      {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        inferResponsesMessagePhaseModels: configuredModels,
      },
      {
        adapter: "openai-responses",
        authMode: "forward",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        inferResponsesMessagePhaseModels: configuredModels,
      },
    ]) {
      for (const modelId of configuredModels) {
        expect(routeUsesResponsesMessagePhaseInference(provider, modelId)).toBe(false);
      }
    }

    expect(routeUsesResponsesMessagePhaseInference({
      adapter: "openai-responses",
      baseUrl: "https://third-party.example/v1",
      inferResponsesMessagePhaseModels: ["o3"],
    }, "o3")).toBe(true);
  });

  test("labels a terminal unphased assistant message final_answer without changing its text", () => {
    const rewrite = createResponsesMessagePhaseBlockRewrite();
    const message = {
      type: "message",
      id: "msg_final",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "最终回答" }],
    };

    expect(payloads(rewrite(sse({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...message, status: "in_progress", content: [] },
    })))).toEqual([{
      type: "response.output_item.added",
      output_index: 1,
      item: { ...message, status: "in_progress", content: [] },
    }]);

    expect(rewrite(sse({
      type: "response.output_item.done",
      output_index: 1,
      item: message,
    }))).toEqual([]);

    expect(payloads(rewrite(sse({
      type: "response.completed",
      response: { id: "resp_final", status: "completed", output: [message] },
    })))).toEqual([
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { ...message, phase: "final_answer" },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_final",
          status: "completed",
          output: [{ ...message, phase: "final_answer" }],
        },
      },
    ]);
  });

  test("uses the completed snapshot's explicit phase for a held assistant message", () => {
    const rewrite = createResponsesMessagePhaseBlockRewrite();
    const message = {
      type: "message",
      id: "msg_explicit",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "我先检查。" }],
    };
    const explicit = { ...message, phase: "commentary" };

    expect(rewrite(sse({
      type: "response.output_item.done",
      output_index: 0,
      item: message,
    }))).toEqual([]);

    expect(payloads(rewrite(sse({
      type: "response.completed",
      response: { id: "resp_explicit", status: "completed", output: [explicit] },
    })))).toEqual([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: explicit,
      },
      {
        type: "response.completed",
        response: { id: "resp_explicit", status: "completed", output: [explicit] },
      },
    ]);
  });

  test("fills a missing completed snapshot phase from an explicit done item", () => {
    const rewrite = createResponsesMessagePhaseBlockRewrite();
    const explicit = {
      type: "message",
      id: "msg_done_explicit",
      role: "assistant",
      status: "completed",
      phase: "commentary",
      content: [{ type: "output_text", text: "中间说明" }],
    };
    const snapshot = { ...explicit };
    delete (snapshot as { phase?: string }).phase;

    expect(payloads(rewrite(sse({
      type: "response.output_item.done",
      output_index: 0,
      item: explicit,
    })))).toEqual([{
      type: "response.output_item.done",
      output_index: 0,
      item: explicit,
    }]);
    expect(payloads(rewrite(sse({
      type: "response.completed",
      response: { id: "resp_done_explicit", status: "completed", output: [snapshot] },
    })))).toEqual([{
      type: "response.completed",
      response: {
        id: "resp_done_explicit",
        status: "completed",
        output: [explicit],
      },
    }]);
  });

  test("uses later work in a sparse completed snapshot to classify a held message commentary", () => {
    const rewrite = createResponsesMessagePhaseBlockRewrite();
    const message = {
      type: "message",
      id: "msg_sparse_tool",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "我先检查。" }],
    };
    const tool = {
      type: "function_call",
      id: "fc_sparse_tool",
      call_id: "call_sparse_tool",
      name: "exec",
      status: "completed",
      arguments: "{}",
    };

    expect(rewrite(sse({
      type: "response.output_item.done",
      output_index: 0,
      item: message,
    }))).toEqual([]);

    expect(payloads(rewrite(sse({
      type: "response.completed",
      response: { id: "resp_sparse_tool", status: "completed", output: [message, tool] },
    })))).toEqual([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...message, phase: "commentary" },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_sparse_tool",
          status: "completed",
          output: [{ ...message, phase: "commentary" }, tool],
        },
      },
    ]);
  });

  test("labels an unphased assistant message commentary when a tool call follows", () => {
    const rewrite = createResponsesMessagePhaseBlockRewrite();
    const message = {
      type: "message",
      id: "msg_preamble",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "我先检查一下。" }],
    };
    const toolCall = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "exec",
      status: "in_progress",
      arguments: "{}",
    };

    expect(rewrite(sse({
      type: "response.output_item.done",
      output_index: 0,
      item: message,
    }))).toEqual([]);

    expect(payloads(rewrite(sse({
      type: "response.output_item.added",
      output_index: 1,
      item: toolCall,
    })))).toEqual([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...message, phase: "commentary" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: toolCall,
      },
    ]);

    expect(payloads(rewrite(sse({
      type: "response.completed",
      response: {
        id: "resp_tool",
        status: "completed",
        output: [message, { ...toolCall, status: "completed" }],
      },
    })))).toEqual([{
      type: "response.completed",
      response: {
        id: "resp_tool",
        status: "completed",
        output: [
          { ...message, phase: "commentary" },
          { ...toolCall, status: "completed" },
        ],
      },
    }]);
  });

  test("keeps an observed commentary phase when the completed snapshot conflicts", () => {
    const rewrite = createResponsesMessagePhaseBlockRewrite();
    const message = {
      type: "message",
      id: "msg_conflict",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "我先检查。" }],
    };
    const tool = {
      type: "function_call",
      id: "fc_conflict",
      call_id: "call_conflict",
      name: "exec",
      status: "in_progress",
      arguments: "{}",
    };
    const snapshot = { ...message, phase: "final_answer" };

    expect(rewrite(sse({ type: "response.output_item.done", output_index: 0, item: message }))).toEqual([]);
    expect(payloads(rewrite(sse({ type: "response.output_item.added", output_index: 1, item: tool })))[0]?.item)
      .toEqual({ ...message, phase: "commentary" });
    expect(payloads(rewrite(sse({
      type: "response.completed",
      response: { id: "resp_conflict", status: "completed", output: [snapshot, tool] },
    })))).toEqual([{
      type: "response.completed",
      response: {
        id: "resp_conflict",
        status: "completed",
        output: [{ ...message, phase: "commentary" }, tool],
      },
    }]);
  });

  test("keeps proven commentary consistent through an incomplete terminal", () => {
    const rewrite = createResponsesMessagePhaseBlockRewrite();
    const message = {
      type: "message",
      id: "msg_worked",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "我先检查。" }],
    };
    const tool = {
      type: "function_call",
      id: "fc_worked",
      call_id: "call_worked",
      name: "exec",
      status: "in_progress",
      arguments: "{}",
    };
    const incomplete = {
      type: "response.incomplete",
      response: { id: "resp_worked", status: "incomplete", output: [message, tool] },
    };

    expect(rewrite(sse({ type: "response.output_item.done", output_index: 0, item: message }))).toEqual([]);
    expect(payloads(rewrite(sse({ type: "response.output_item.added", output_index: 1, item: tool })))[0]?.item)
      .toEqual({ ...message, phase: "commentary" });
    expect(payloads(rewrite(sse(incomplete)))).toEqual([{
      type: "response.incomplete",
      response: {
        id: "resp_worked",
        status: "incomplete",
        output: [{ ...message, phase: "commentary" }, tool],
      },
    }]);
  });

  test("flushes an unphased assistant message unchanged when the response is incomplete", () => {
    const rewrite = createResponsesMessagePhaseBlockRewrite();
    const message = {
      type: "message",
      id: "msg_partial",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "部分回答" }],
    };
    const incomplete = {
      type: "response.incomplete",
      response: { id: "resp_partial", status: "incomplete" },
    };

    expect(rewrite(sse({
      type: "response.output_item.done",
      output_index: 0,
      item: message,
    }))).toEqual([]);

    expect(payloads(rewrite(sse(incomplete)))).toEqual([
      { type: "response.output_item.done", output_index: 0, item: message },
      incomplete,
    ]);
  });

  test("safely flushes an ambiguous pending message before buffering a second message", () => {
    const rewrite = createResponsesMessagePhaseBlockRewrite();
    const first = {
      type: "message",
      id: "msg_first",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "第一段" }],
    };
    const second = {
      type: "message",
      id: "msg_second",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "第二段" }],
    };

    expect(rewrite(sse({ type: "response.output_item.done", output_index: 0, item: first }))).toEqual([]);
    expect(payloads(rewrite(sse({ type: "response.output_item.done", output_index: 1, item: second })))).toEqual([
      { type: "response.output_item.done", output_index: 0, item: first },
    ]);
    expect(payloads(rewrite(sse({
      type: "response.completed",
      response: { id: "resp_ambiguous", status: "completed", output: [first, second] },
    })))).toEqual([
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { ...second, phase: "final_answer" },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_ambiguous",
          status: "completed",
          output: [first, { ...second, phase: "final_answer" }],
        },
      },
    ]);
  });

  test("flushes and labels a pending message before a later explicit-phase message", () => {
    const rewrite = createResponsesMessagePhaseBlockRewrite();
    const pending = {
      type: "message",
      id: "msg_pending_before_explicit",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "先说明一下。" }],
    };
    const explicit = {
      type: "message",
      id: "msg_explicit_after_pending",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: "最终答案。" }],
    };

    expect(rewrite(sse({ type: "response.output_item.done", output_index: 0, item: pending }))).toEqual([]);
    expect(payloads(rewrite(sse({ type: "response.output_item.done", output_index: 1, item: explicit })))).toEqual([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...pending, phase: "commentary" },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: explicit,
      },
    ]);
  });

  test("forgets buffered state when the relay disposes the rewrite", () => {
    const rewrite = createResponsesMessagePhaseBlockRewrite();
    const message = {
      type: "message",
      id: "msg_disposed",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "不会延迟泄漏" }],
    };
    const completed = {
      type: "response.completed",
      response: { id: "resp_disposed", status: "completed", output: [message] },
    };

    expect(rewrite(sse({ type: "response.output_item.done", output_index: 0, item: message }))).toEqual([]);
    rewrite.dispose?.();
    expect(payloads(rewrite(sse(completed)))).toEqual([completed]);
  });

  test("passes through a terminal message when the phase collector cannot retain it", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 64 });
    const rewrite = createResponsesMessagePhaseBlockRewrite(budget);
    const message = {
      type: "message",
      id: "msg_over_budget",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "x".repeat(512) }],
    };
    const done = { type: "response.output_item.done", output_index: 0, item: message };

    expect(payloads(rewrite(sse(done)))).toEqual([done]);
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });

  test("does not retain a pending message beyond the phase collector's shared budget", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 1_024 });
    const rewrite = createResponsesMessagePhaseBlockRewrite(budget);
    const explicit = {
      type: "message",
      id: `msg_${"e".repeat(400)}`,
      role: "assistant",
      status: "completed",
      phase: "commentary",
      content: [{ type: "output_text", text: "已知阶段" }],
    };
    const pending = {
      type: "message",
      id: "msg_pending_budget",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "x".repeat(600) }],
    };
    const explicitDone = { type: "response.output_item.done", output_index: 0, item: explicit };
    const pendingDone = { type: "response.output_item.done", output_index: 1, item: pending };

    expect(payloads(rewrite(sse(explicitDone)))).toEqual([explicitDone]);
    expect(payloads(rewrite(sse(pendingDone)))).toEqual([pendingDone]);
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });

  test("stops retaining new message phases after the bounded tracked-item limit", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createResponsesMessagePhaseBlockRewrite(budget);
    for (let index = 0; index < 256; index++) {
      const message = {
        type: "message",
        id: `msg_${index}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "进度" }],
      };
      expect(rewrite(sse({ type: "response.output_item.done", output_index: index * 2, item: message }))).toEqual([]);
      const output = payloads(rewrite(sse({
        type: "response.output_item.added",
        output_index: index * 2 + 1,
        item: { type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: "exec", status: "in_progress" },
      })));
      expect((output[0]?.item as { phase?: string }).phase).toBe("commentary");
    }

    const overflow = {
      type: "message",
      id: "msg_overflow",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "不再保留" }],
    };
    const overflowDone = { type: "response.output_item.done", output_index: 512, item: overflow };

    expect(payloads(rewrite(sse(overflowDone)))).toEqual([overflowDone]);
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });

  test("classifies unphased messages in a completed non-stream response", () => {
    const preamble = {
      type: "message",
      id: "msg_pre",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "我先检查。" }],
    };
    const toolCall = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "exec",
      status: "completed",
      arguments: "{}",
    };
    const final = {
      type: "message",
      id: "msg_final",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "检查完成。" }],
    };

    expect(rewriteResponsesMessagePhasesInJson({
      id: "resp_json",
      object: "response",
      status: "completed",
      output: [preamble, toolCall, final],
    })).toEqual({
      id: "resp_json",
      object: "response",
      status: "completed",
      output: [
        { ...preamble, phase: "commentary" },
        toolCall,
        { ...final, phase: "final_answer" },
      ],
    });
  });

  test("classifies text before a terminal tool call commentary in a completed non-stream response", () => {
    const preamble = {
      type: "message",
      id: "msg_before_tool_only",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "我先检查。" }],
    };
    const tool = {
      type: "function_call",
      id: "fc_terminal",
      call_id: "call_terminal",
      name: "exec",
      status: "completed",
      arguments: "{}",
    };

    expect(rewriteResponsesMessagePhasesInJson({
      id: "resp_tool_only",
      object: "response",
      status: "completed",
      output: [preamble, tool],
    })).toEqual({
      id: "resp_tool_only",
      object: "response",
      status: "completed",
      output: [{ ...preamble, phase: "commentary" }, tool],
    });
  });

});

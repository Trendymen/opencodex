import { describe, expect, test } from "bun:test";
import { repairNestedExecAdapterEvents } from "../src/responses/nested-exec-adapter-events";
import {
  createNestedExecCallRepairBlockRewrite,
  createNestedExecClientOutcomeBlockRewrite,
  createNestedExecInspectionState,
  createNestedExecRepairCoordinator,
} from "../src/server/responses-nested-exec-call-repair";
import { sseDataPayload } from "../src/server/sse-payload-rewrite";
import {
  NESTED_EXEC_MAX_ARGUMENT_BYTES,
  buildNestedExecRepairPlan,
  normalizeNestedExecCall,
  repairNestedExecCallsInJson,
} from "../src/responses/nested-exec-call-repair";
import type { AdapterEvent } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const repairPlan = { execWireName: "exec", repairFunctionsExec: true, repairWebRun: true } as const;

async function collect(source: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

async function* events(values: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  yield* values;
}

function sse(payload: Record<string, unknown>): string {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function ssePayloads(blocks: readonly string[]): Array<Record<string, unknown>> {
  return blocks.map(block => JSON.parse(sseDataPayload(block)!) as Record<string, unknown>);
}

const webRunItem = {
  id: "fc_1",
  type: "function_call",
  call_id: "call_1",
  name: "web__run",
  arguments: '{"search_query":"OpenAI"}',
};

describe("nested exec repair", () => {
  test("derives web alias repair from structured declarations, not description wording", () => {
    expect(buildNestedExecRepairPlan({
      execIsDeclaredOnWire: true,
      directlyDeclaredWireNames: new Set(["functions.exec"]),
    })).toEqual({ execWireName: "exec", repairFunctionsExec: false, repairWebRun: true });
  });

  test("normalizes a top-level web__run call into a single exec input", () => {
    const repaired = normalizeNestedExecCall(
      "web__run",
      JSON.stringify({ search_query: [{ q: "OpenAI" }], response_length: "short" }),
      repairPlan,
    );
    expect(repaired).toEqual({
      name: "exec",
      arguments: JSON.stringify({
        input: "const result = await tools.web__run({\"response_length\":\"short\",\"search_query\":[{\"q\":\"OpenAI\"}]});\ntext(JSON.stringify(result, null, 2));",
      }),
      outcome: "repaired",
    });
  });

  test("keeps malformed and over-budget aliases untouched so the final guard can fail closed", () => {
    expect(normalizeNestedExecCall("web__run", "{", repairPlan).outcome).toBe("rejected");
    const oversized = "x".repeat(NESTED_EXEC_MAX_ARGUMENT_BYTES + 1);
    expect(normalizeNestedExecCall("functions.exec", oversized, repairPlan)).toEqual({
      name: "functions.exec",
      arguments: oversized,
      outcome: "rejected",
    });
    const original = '{"output":[{"type":"function_call","name":"web__run","arguments":"{"}]}';
    expect(repairNestedExecCallsInJson(original, repairPlan)).toBe(original);
  });

  test("repairs a fragmented AdapterEvent call atomically and releases the retained barrier", async () => {
    const budget = createTestTranslatorBudget();
    const repaired = await collect(repairNestedExecAdapterEvents(events([
      { type: "tool_call_start", id: "call_1", name: "web__run" },
      { type: "tool_call_delta", arguments: '{"search_' },
      { type: "tool_call_delta", arguments: 'query":"OpenAI"}' },
      { type: "tool_call_end" },
      { type: "done" },
    ]), repairPlan, budget));
    expect(repaired).toEqual([
      { type: "tool_call_start", id: "call_1", name: "exec" },
      {
        type: "tool_call_delta",
        arguments: JSON.stringify({
          input: "const result = await tools.web__run({\"search_query\":\"OpenAI\"});\ntext(JSON.stringify(result, null, 2));",
        }),
      },
      { type: "tool_call_end" },
      { type: "done" },
    ]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("passes a direct client web__run declaration through without repair", async () => {
    const directPlan = { ...repairPlan, repairWebRun: false };
    const source = [
      { type: "tool_call_start", id: "call_1", name: "web__run" },
      { type: "tool_call_delta", arguments: '{"search_query":"OpenAI"}' },
      { type: "tool_call_end" },
    ] satisfies AdapterEvent[];
    expect(await collect(repairNestedExecAdapterEvents(events(source), directPlan, createTestTranslatorBudget()))).toEqual(source);
  });

  test("flushes the passthrough SSE barrier only after a complete normalized call", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createNestedExecCallRepairBlockRewrite(repairPlan, createNestedExecRepairCoordinator(budget), budget);
    expect(rewrite(sse({ type: "response.output_item.added", output_index: 0, item: webRunItem }))).toEqual([]);
    expect(rewrite(sse({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: webRunItem.arguments }))).toEqual([]);
    const flushed = rewrite(sse({ type: "response.output_item.done", output_index: 0, item: webRunItem }));
    const payloads = ssePayloads(flushed);
    expect(payloads.map(payload => payload.type)).toEqual([
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
    ]);
    expect((payloads[0]!.item as { name: string }).name).toBe("exec");
    expect((payloads.at(-1)!.item as { name: string }).name).toBe("exec");
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("commits a repaired cached response only after the client terminal event", () => {
    const budget = createTestTranslatorBudget();
    const coordinator = createNestedExecRepairCoordinator(budget);
    const inspection = createNestedExecInspectionState(repairPlan, coordinator, budget);
    expect(inspection.notePayload({ type: "response.output_item.added", output_index: 0, item: webRunItem }).action).toBe("defer");
    expect(inspection.notePayload({ type: "response.output_item.done", output_index: 0, item: webRunItem }).action).toBe("inspect");
    const candidate = inspection.prepareResponseForCache({ id: "resp_1", output: [] });
    expect(candidate.action).toBe("inspect");
    const remembered: unknown[] = [];
    coordinator.stageCacheCandidate(candidate.value, value => remembered.push(value));
    expect(remembered).toEqual([]);
    const outcome = createNestedExecClientOutcomeBlockRewrite(coordinator);
    outcome(sse({ type: "response.completed", response: { id: "resp_1" } }));
    expect(remembered).toEqual([{
      id: "resp_1",
      output: [{ ...webRunItem, name: "exec", arguments: JSON.stringify({
        input: "const result = await tools.web__run({\"search_query\":\"OpenAI\"});\ntext(JSON.stringify(result, null, 2));",
      }) }],
    }]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("guard rejection or disposer drops staged cache state and releases retained bytes", () => {
    const budget = createTestTranslatorBudget();
    const coordinator = createNestedExecRepairCoordinator(budget);
    coordinator.stageCacheCandidate({ id: "resp_1" }, () => { throw new Error("must not commit"); });
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    coordinator.reject();
    expect(budget.snapshot().currentBytes).toBe(0);

    const rewrite = createNestedExecCallRepairBlockRewrite(repairPlan, createNestedExecRepairCoordinator(budget), budget);
    rewrite(sse({ type: "response.output_item.added", output_index: 0, item: webRunItem }));
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
  });
});

import type { TranslatorBudget } from "../lib/translator-budget";
import { isTranslatorBudgetExceededError } from "../lib/translator-budget";
import type { AdapterEvent } from "../types";
import {
  NESTED_EXEC_MAX_ARGUMENT_BYTES,
  normalizeNestedExecCall,
  type NestedExecRepairPlan,
} from "./nested-exec-call-repair";

export const NESTED_EXEC_MAX_ADAPTER_EVENT_BARRIER_BYTES = 256 * 1024;

type RetainedEvent = Readonly<{ event: AdapterEvent; bytes: number }>;

function eventBytes(event: AdapterEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function candidateEnabled(name: string, plan: NestedExecRepairPlan): boolean {
  return (name === "functions.exec" && plan.repairFunctionsExec)
    || (name === "web__run" && plan.repairWebRun);
}

function transformedGroup(
  retained: readonly RetainedEvent[],
  normalizedName: string,
  normalizedArguments: string,
): AdapterEvent[] {
  const out: AdapterEvent[] = [];
  let emittedArguments = false;
  for (const { event } of retained) {
    if (event.type === "tool_call_start") {
      out.push({ ...event, name: normalizedName });
      continue;
    }
    if (event.type === "tool_call_delta") {
      if (!emittedArguments) {
        out.push({ type: "tool_call_delta", arguments: normalizedArguments });
        emittedArguments = true;
      }
      continue;
    }
    if (event.type === "tool_call_end" && !emittedArguments) {
      out.push({ type: "tool_call_delta", arguments: normalizedArguments });
      emittedArguments = true;
    }
    out.push(event);
  }
  return out;
}

export function repairNestedExecAdapterEvents(
  source: AsyncIterable<AdapterEvent>,
  plan: NestedExecRepairPlan,
  budget: TranslatorBudget,
): AsyncIterable<AdapterEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
      const upstream = source[Symbol.asyncIterator]();
      let retained: RetainedEvent[] = [];
      let retainedBytes = 0;
      let candidateName = "";
      let candidateArguments = "";
      let queue: AdapterEvent[] = [];
      let queueIndex = 0;
      let ended = false;
      let cancelled = false;
      let upstreamClose: Promise<IteratorResult<AdapterEvent>> | undefined;
      let nextTail: Promise<void> = Promise.resolve();

      const releaseRetained = (): void => {
        for (const entry of retained) {
          budget.releaseRetained(entry.bytes, { kind: "retained_collectors" });
        }
        retained = [];
        retainedBytes = 0;
        candidateName = "";
        candidateArguments = "";
      };

      const closeUpstream = async (
        mode: "return" | "throw" = "return",
        error?: unknown,
      ): Promise<IteratorResult<AdapterEvent>> => {
        if (!upstreamClose) {
          upstreamClose = (async () => {
            if (mode === "throw" && upstream.throw) return await upstream.throw(error);
            if (upstream.return) return await upstream.return();
            return { done: true, value: undefined as never };
          })();
        }
        return upstreamClose;
      };

      const retain = (event: AdapterEvent): boolean => {
        const bytes = eventBytes(event);
        if (retainedBytes + bytes > NESTED_EXEC_MAX_ADAPTER_EVENT_BARRIER_BYTES) return false;
        try {
          budget.chargeRetained(bytes, { kind: "retained_collectors" });
        } catch (error) {
          if (isTranslatorBudgetExceededError(error)) return false;
          throw error;
        }
        retained.push({ event, bytes });
        retainedBytes += bytes;
        return true;
      };

      const queueOriginalGroup = (unretained?: AdapterEvent): void => {
        const original = retained.map(entry => entry.event);
        if (unretained) original.push(unretained);
        releaseRetained();
        queue = original;
        queueIndex = 0;
      };

      const takeQueued = (): IteratorResult<AdapterEvent> | undefined => {
        if (queueIndex >= queue.length) {
          queue = [];
          queueIndex = 0;
          return undefined;
        }
        return { done: false, value: queue[queueIndex++]! };
      };

      const nextOperation = async (): Promise<IteratorResult<AdapterEvent>> => {
        const queued = takeQueued();
        if (queued) return queued;
        if (ended || cancelled) return { done: true, value: undefined as never };

        try {
          while (true) {
            const result = await upstream.next();
            if (cancelled) return { done: true, value: undefined as never };
            if (result.done) {
              ended = true;
              if (retained.length > 0) {
                queueOriginalGroup();
                return takeQueued() ?? { done: true, value: undefined as never };
              }
              return { done: true, value: undefined as never };
            }
            const event = result.value;

            if (retained.length === 0) {
              if (event.type !== "tool_call_start" || !candidateEnabled(event.name, plan)) {
                return { done: false, value: event };
              }
              if (!retain(event)) return { done: false, value: event };
              candidateName = event.name;
              continue;
            }

            if (!retain(event)) {
              queueOriginalGroup(event);
              return takeQueued()!;
            }

            if (event.type === "tool_call_start") {
              queueOriginalGroup();
              return takeQueued()!;
            }
            if (event.type === "tool_call_delta") {
              const nextArguments = candidateArguments + event.arguments;
              const nextArgumentBytes = Buffer.byteLength(nextArguments, "utf8");
              if (nextArgumentBytes > NESTED_EXEC_MAX_ARGUMENT_BYTES) {
                queueOriginalGroup();
                return takeQueued()!;
              }
              candidateArguments = nextArguments;
              continue;
            }
            if (event.type === "error" || event.type === "done") {
              queueOriginalGroup();
              return takeQueued()!;
            }
            if (event.type !== "tool_call_end") continue;

            const normalized = normalizeNestedExecCall(candidateName, candidateArguments, plan);
            if (normalized.outcome !== "repaired") {
              queueOriginalGroup();
              return takeQueued()!;
            }
            const repaired = transformedGroup(retained, normalized.name, normalized.arguments);
            releaseRetained();
            queue = repaired;
            queueIndex = 0;
            return takeQueued()!;
          }
        } catch (error) {
          releaseRetained();
          ended = true;
          await closeUpstream("return").catch(() => undefined);
          throw error;
        }
      };

      const next = (): Promise<IteratorResult<AdapterEvent>> => {
        const operation = nextTail.then(nextOperation, nextOperation);
        nextTail = operation.then(() => undefined, () => undefined);
        return operation;
      };

      const returnIterator = async (value?: unknown): Promise<IteratorResult<AdapterEvent>> => {
        if (cancelled) return { done: true, value: value as AdapterEvent };
        cancelled = true;
        queue = [];
        queueIndex = 0;
        releaseRetained();
        await closeUpstream("return").catch(() => undefined);
        return { done: true, value: value as AdapterEvent };
      };

      const throwIterator = async (error?: unknown): Promise<IteratorResult<AdapterEvent>> => {
        cancelled = true;
        queue = [];
        queueIndex = 0;
        releaseRetained();
        await closeUpstream("throw", error).catch(() => undefined);
        throw error;
      };

      return { next, return: returnIterator, throw: throwIterator };
    },
  };
}

import {
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
} from "../server/sse-payload-rewrite";
import type { TranslatorBudget } from "../lib/translator-budget";
import {
  MAX_COMPLETED_OUTPUT_ITEMS,
  MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES,
} from "../server/relay";
import { isOpenAiOperatedResponsesDestination } from "../providers/openai-tiers";
import type { OcxProviderConfig } from "../types";

type Rec = Record<string, unknown>;
type MessagePhase = "commentary" | "final_answer";
type PhaseSource = "upstream" | "inferred_work";

export interface ResponsesMessagePhaseInferenceProvider {
  adapter?: OcxProviderConfig["adapter"];
  authMode?: OcxProviderConfig["authMode"];
  baseUrl?: string;
  responsesPath?: string;
  inferResponsesMessagePhaseModels?: readonly string[];
}

interface PendingMessageDone {
  block: string;
  itemId: string;
  bytes: number;
}

interface TrackedPhase {
  phase: MessagePhase;
  source: PhaseSource;
  bytes: number;
}

const MAX_TRACKED_PHASE_BYTES = MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES;

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function routeUsesResponsesMessagePhaseInference(
  provider: ResponsesMessagePhaseInferenceProvider,
  modelId: string,
): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized || normalized.includes("gpt") || normalized.includes("openai")) return false;
  if (provider.adapter !== undefined && provider.baseUrl !== undefined
    && isOpenAiOperatedResponsesDestination(provider as OcxProviderConfig)) return false;
  return provider.inferResponsesMessagePhaseModels?.some(candidate =>
    typeof candidate === "string" && candidate.trim().toLowerCase() === normalized,
  ) === true;
}

function parsePayload(block: string): Rec | null {
  const text = sseDataPayload(block);
  if (text === null || text === "[DONE]") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRec(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assistantMessageWithoutPhase(payload: Rec): string | null {
  if (payload.type !== "response.output_item.done" || !isRec(payload.item)) return null;
  const item = payload.item;
  if (item.type !== "message" || item.role !== "assistant" || item.phase !== undefined) return null;
  return typeof item.id === "string" && item.id.length > 0 ? item.id : null;
}

function assistantMessageWithExplicitPhase(payload: Rec): { id: string; phase: MessagePhase } | null {
  if (payload.type !== "response.output_item.done" || !isRec(payload.item)) return null;
  const item = payload.item;
  if (item.type !== "message" || item.role !== "assistant" || typeof item.id !== "string" || item.id.length === 0) {
    return null;
  }
  return item.phase === "commentary" || item.phase === "final_answer"
    ? { id: item.id, phase: item.phase }
    : null;
}

function stampItemPhase(payload: Rec, phase: MessagePhase): Rec {
  const item = payload.item;
  if (!isRec(item)) return payload;
  return { ...payload, item: { ...item, phase } };
}

function stampTerminalOutput(payload: Rec, phases: ReadonlyMap<string, TrackedPhase>): Rec {
  if (!isRec(payload.response)) return payload;
  const response = payload.response;
  if (!Array.isArray(response.output)) return payload;
  let changed = false;
  const output = response.output.map(entry => {
    if (!isRec(entry) || entry.type !== "message" || entry.role !== "assistant" || typeof entry.id !== "string") {
      return entry;
    }
    const known = phases.get(entry.id);
    if (!known) return entry;
    if (entry.phase !== undefined && known.source !== "inferred_work") return entry;
    if (entry.phase === known.phase) return entry;
    changed = true;
    return { ...entry, phase: known.phase };
  });
  return changed ? { ...payload, response: { ...response, output } } : payload;
}

function startsNewOutputItem(payload: Rec): boolean {
  return payload.type === "response.output_item.added";
}

function isUnsuccessfulTerminal(payload: Rec): boolean {
  return payload.type === "response.failed" || payload.type === "response.incomplete";
}

type CompletedSnapshotPhase =
  | { kind: "inferred"; phase: MessagePhase }
  | { kind: "explicit"; phase: MessagePhase }
  | { kind: "unsafe" };

function completedSnapshotPhase(payload: Rec, itemId: string): CompletedSnapshotPhase {
  if (!isRec(payload.response) || !Array.isArray(payload.response.output)) {
    return { kind: "inferred", phase: "final_answer" };
  }
  let matching: Rec | undefined;
  let matchingIndex = -1;
  for (const [index, entry] of payload.response.output.entries()) {
    if (!isRec(entry) || entry.id !== itemId) continue;
    if (matching || entry.type !== "message" || entry.role !== "assistant") return { kind: "unsafe" };
    matching = entry;
    matchingIndex = index;
  }
  if (!matching) return { kind: "unsafe" };
  if (matching.phase === undefined) {
    return { kind: "inferred", phase: matchingIndex === payload.response.output.length - 1 ? "final_answer" : "commentary" };
  }
  if (matching.phase === "commentary" || matching.phase === "final_answer") {
    return { kind: "explicit", phase: matching.phase };
  }
  return { kind: "unsafe" };
}

function rewriteCompletedResponseDocument(response: Rec): Rec {
  if (response.status !== "completed" || !Array.isArray(response.output)) return response;
  let changed = false;
  const output = response.output.map((entry, index, all) => {
    if (!isRec(entry) || entry.type !== "message" || entry.role !== "assistant" || entry.phase !== undefined) {
      return entry;
    }
    const phase: MessagePhase = index === all.length - 1 ? "final_answer" : "commentary";
    changed = true;
    return { ...entry, phase };
  });
  return changed ? { ...response, output } : response;
}

export function rewriteResponsesMessagePhasesInJson(value: unknown): unknown {
  if (!isRec(value)) return value;
  if (value.type === "response.completed" && isRec(value.response)) {
    const response = rewriteCompletedResponseDocument(value.response);
    return response === value.response ? value : { ...value, response };
  }
  return rewriteCompletedResponseDocument(value);
}

export function rewriteResponsesMessagePhasesInJsonString(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    const rewritten = rewriteResponsesMessagePhasesInJson(parsed);
    return rewritten === parsed ? value : JSON.stringify(rewritten);
  } catch {
    return value;
  }
}

export function createResponsesMessagePhaseBlockRewrite(budget?: TranslatorBudget): SseBlockRewrite {
  let pending: PendingMessageDone | null = null;
  const phases = new Map<string, TrackedPhase>();
  let retainedPhaseBytes = 0;
  let inferenceDisabled = false;

  const releasePending = (): string[] => {
    if (!pending) return [];
    const blocks = [pending.block];
    budget?.releaseRetained(pending.bytes, { kind: "retained_collectors" });
    pending = null;
    return blocks;
  };

  const releasePhases = (): void => {
    if (retainedPhaseBytes > 0) {
      budget?.releaseRetained(retainedPhaseBytes, { kind: "retained_collectors" });
    }
    phases.clear();
    retainedPhaseBytes = 0;
  };

  const holdPending = (block: string, itemId: string): readonly string[] => {
    const flushed = releasePending();
    if (inferenceDisabled || phases.size >= MAX_COMPLETED_OUTPUT_ITEMS) {
      inferenceDisabled = true;
      return [...flushed, block];
    }
    const bytes = Buffer.byteLength(block, "utf8");
    if (retainedPhaseBytes + bytes > MAX_TRACKED_PHASE_BYTES) {
      inferenceDisabled = true;
      return [...flushed, block];
    }
    try {
      budget?.chargeRetained(bytes, { kind: "retained_collectors" });
    } catch {
      inferenceDisabled = true;
      return [...flushed, block];
    }
    pending = { block, itemId, bytes };
    return flushed;
  };

  const rememberPhase = (itemId: string, phase: MessagePhase, source: PhaseSource): boolean => {
    if (inferenceDisabled) return false;
    const previous = phases.get(itemId);
    if (previous) return previous.phase === phase;
    const bytes = Buffer.byteLength(`${itemId}:${phase}`, "utf8");
    if (phases.size >= MAX_COMPLETED_OUTPUT_ITEMS
      || retainedPhaseBytes + (pending?.bytes ?? 0) + bytes > MAX_TRACKED_PHASE_BYTES) {
      inferenceDisabled = true;
      return false;
    }
    try {
      budget?.chargeRetained(bytes, { kind: "retained_collectors" });
    } catch {
      inferenceDisabled = true;
      return false;
    }
    phases.set(itemId, { phase, source, bytes });
    retainedPhaseBytes += bytes;
    return true;
  };

  const phaseMap = (): Map<string, TrackedPhase> => new Map(phases);

  const rewrite: SseBlockRewrite = block => {
    if (sseDataPayload(block) === "[DONE]") {
      const pendingBlocks = releasePending();
      releasePhases();
      return pendingBlocks.length > 0 ? [...pendingBlocks, block] : [block];
    }
    const payload = parsePayload(block);
    if (!payload) return [block];

    const explicit = assistantMessageWithExplicitPhase(payload);
    if (explicit) {
      rememberPhase(explicit.id, explicit.phase, "upstream");
      if (pending) {
        const held = pending;
        if (!rememberPhase(held.itemId, "commentary", "inferred_work")) return [...releasePending(), block];
        const commentaryPayload = parsePayload(held.block);
        const pendingBlock = commentaryPayload
          ? replaceSseDataPayload(held.block, JSON.stringify(stampItemPhase(commentaryPayload, "commentary")))
          : held.block;
        releasePending();
        return [pendingBlock, block];
      }
      return [block];
    }
    const message = assistantMessageWithoutPhase(payload);
    if (message) return holdPending(block, message);

    if (pending && startsNewOutputItem(payload)) {
      const held = pending;
      if (!rememberPhase(held.itemId, "commentary", "inferred_work")) return [...releasePending(), block];
      const commentaryPayload = parsePayload(held.block);
      const pendingBlock = commentaryPayload
        ? replaceSseDataPayload(held.block, JSON.stringify(stampItemPhase(commentaryPayload, "commentary")))
        : held.block;
      releasePending();
      return [pendingBlock, block];
    }

    if (pending && isUnsuccessfulTerminal(payload)) {
      const pendingBlocks = releasePending();
      const terminal = stampTerminalOutput(payload, phaseMap());
      releasePhases();
      return [...pendingBlocks, terminal === payload ? block : replaceSseDataPayload(block, JSON.stringify(terminal))];
    }

    if (isUnsuccessfulTerminal(payload)) {
      const terminal = stampTerminalOutput(payload, phaseMap());
      releasePhases();
      return terminal === payload ? [block] : [replaceSseDataPayload(block, JSON.stringify(terminal))];
    }

    if (pending && payload.type === "response.output_item.done") {
      return [...releasePending(), block];
    }

    if (payload.type === "response.completed" && pending) {
      const held = pending;
      const snapshotPhase = completedSnapshotPhase(payload, held.itemId);
      if (snapshotPhase.kind === "unsafe") {
        const pendingBlocks = releasePending();
        const completed = stampTerminalOutput(payload, phaseMap());
        releasePhases();
        return [...pendingBlocks, completed === payload ? block : replaceSseDataPayload(block, JSON.stringify(completed))];
      }
      const phase = snapshotPhase.phase;
      const terminalPayload = parsePayload(held.block);
      const terminal = terminalPayload
        ? replaceSseDataPayload(held.block, JSON.stringify(stampItemPhase(terminalPayload, phase)))
        : held.block;
      const completedPhases = phaseMap();
      completedPhases.set(held.itemId, {
        phase,
        source: snapshotPhase.kind === "explicit" ? "upstream" : "inferred_work",
        bytes: 0,
      });
      const completed = stampTerminalOutput(payload, completedPhases);
      releasePending();
      releasePhases();
      return [terminal, completed === payload ? block : replaceSseDataPayload(block, JSON.stringify(completed))];
    }

    if (payload.type === "response.completed") {
      const completed = stampTerminalOutput(payload, phaseMap());
      releasePhases();
      return completed === payload ? [block] : [replaceSseDataPayload(block, JSON.stringify(completed))];
    }

    return [block];
  };
  rewrite.flush = () => {
    const pendingBlocks = releasePending();
    releasePhases();
    return pendingBlocks;
  };
  rewrite.dispose = () => {
    releasePending();
    releasePhases();
  };
  return rewrite;
}

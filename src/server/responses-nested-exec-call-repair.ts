import type { TranslatorBudget } from "../lib/translator-budget";
import { debugProviderDiagnostic } from "../lib/debug";
import {
  buildNestedExecRepairPlan,
  findUniqueCurrentTurnExecDeclaration,
  repairNestedExecCallsInPayload,
  type CurrentTurnExecDeclaration,
  type NestedExecRepairPlan,
} from "../responses/nested-exec-call-repair";
import { repairNestedExecAdapterEvents } from "../responses/nested-exec-adapter-events";
import type { AdapterEvent } from "../types";
import {
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
} from "./sse-payload-rewrite";
import {
  collectDeclaredNamelessClientCallTypes,
  collectDeclaredWireToolNames,
  currentTurnWireToolCatalogBody,
  hasExplicitWireToolCatalog,
} from "./responses-undeclared-tool-guard";

export const NESTED_EXEC_MAX_BARRIER_BYTES = 256 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBlock(block: string): Record<string, unknown> | undefined {
  const payload = sseDataPayload(block);
  if (payload === null || payload === "[DONE]") return undefined;
  try {
    const parsed: unknown = JSON.parse(payload);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function replaceEventName(block: string, type: string): string {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  let replaced = false;
  return block.split(/\r?\n/).map(line => {
    if (!replaced && line.startsWith("event:")) {
      replaced = true;
      return `event: ${type}`;
    }
    return line;
  }).join(newline);
}

function replaceBlock(block: string, type: string, payload: Record<string, unknown>): string {
  return replaceSseDataPayload(replaceEventName(block, type), JSON.stringify({ ...payload, type }));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function equivalentArguments(left: string, right: string): boolean {
  try {
    return stableJson(JSON.parse(left)) === stableJson(JSON.parse(right));
  } catch {
    return false;
  }
}

function candidateName(name: unknown, plan: NestedExecRepairPlan): string | undefined {
  if (name === "web__run" && plan.repairWebRun) return "web__run";
  if (name === "functions.exec" && plan.repairFunctionsExec) return "functions.exec";
  return undefined;
}

function eventIdentity(payload: Record<string, unknown>): {
  itemId?: string;
  outerItemId?: string;
  innerItemId?: string;
  itemIdConflict?: true;
  outputIndex?: number;
} {
  const item = isPlainObject(payload.item) ? payload.item : undefined;
  const outerItemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
  const innerItemId = typeof item?.id === "string" ? item.id : undefined;
  const itemId = outerItemId ?? innerItemId;
  const outputIndex = typeof payload.output_index === "number" && Number.isInteger(payload.output_index)
    ? payload.output_index
    : undefined;
  return {
    ...(itemId !== undefined ? { itemId } : {}),
    ...(outerItemId !== undefined ? { outerItemId } : {}),
    ...(innerItemId !== undefined ? { innerItemId } : {}),
    ...(outerItemId !== undefined && innerItemId !== undefined && outerItemId !== innerItemId
      ? { itemIdConflict: true as const }
      : {}),
    ...(outputIndex !== undefined ? { outputIndex } : {}),
  };
}

function identityKey(identity: { itemId?: string; outputIndex?: number }): string | undefined {
  if (identity.itemId !== undefined) return `id:${identity.itemId}`;
  if (identity.outputIndex !== undefined) return `index:${identity.outputIndex}`;
  return undefined;
}

type RetainedBlock = {
  block: string;
  bytes: number;
};

type Candidate = {
  key: string;
  name: string;
  itemId?: string;
  outerItemId?: string;
  innerItemId?: string;
  outputIndex?: number;
  callId?: string;
  itemType?: string;
  argumentDoneIndex?: number;
  argumentDoneText?: string;
  normalizedArguments?: string;
  normalizedDoneItem?: Record<string, unknown>;
  complete: boolean;
};

export type NestedExecRepairCoordinator = Readonly<{
  stageCacheCandidate(response: unknown, remember: (response: unknown) => void): void;
  markClientCommitted(): void;
  reject(): void;
  dispose(): void;
}>;

export function createNestedExecRepairCoordinator(
  budget?: TranslatorBudget,
): NestedExecRepairCoordinator {
  let state: "pending" | "committed" | "rejected" = "pending";
  let staged: { response: unknown; remember: (response: unknown) => void; bytes: number } | undefined;

  const releaseStage = (): void => {
    if (!staged) return;
    if (staged.bytes > 0) budget?.releaseRetained(staged.bytes, { kind: "retained_collectors" });
    staged = undefined;
  };
  const commitStage = (): void => {
    if (state !== "committed" || !staged) return;
    const current = staged;
    staged = undefined;
    if (current.bytes > 0) budget?.releaseRetained(current.bytes, { kind: "retained_collectors" });
    current.remember(current.response);
  };

  return {
    stageCacheCandidate(response, remember) {
      if (state === "rejected") return;
      releaseStage();
      const bytes = Buffer.byteLength(JSON.stringify(response), "utf8");
      try {
        if (bytes > 0) budget?.chargeRetained(bytes, { kind: "retained_collectors" });
      } catch {
        state = "rejected";
        return;
      }
      staged = { response, remember, bytes };
      commitStage();
    },
    markClientCommitted() {
      if (state === "rejected") return;
      state = "committed";
      commitStage();
    },
    reject() {
      if (state === "rejected") return;
      state = "rejected";
      releaseStage();
    },
    dispose() {
      if (state === "pending") {
        state = "rejected";
        releaseStage();
      }
    },
  };
}

function terminalType(type: unknown): boolean {
  return type === "response.completed" || type === "response.incomplete" || type === "response.failed";
}

export function createNestedExecCallRepairBlockRewrite(
  plan: NestedExecRepairPlan,
  coordinator: NestedExecRepairCoordinator,
  budget?: TranslatorBudget,
): SseBlockRewrite {
  let retained: RetainedBlock[] = [];
  let retainedBytes = 0;
  let candidates = new Map<string, Candidate>();
  let disposed = false;

  const release = (): void => {
    if (retainedBytes > 0) budget?.releaseRetained(retainedBytes, { kind: "retained_collectors" });
    retained = [];
    retainedBytes = 0;
    candidates = new Map();
  };

  const fallback = (): readonly string[] => {
    const original = retained.map(entry => entry.block);
    coordinator.reject();
    release();
    return original;
  };

  const retain = (block: string): boolean => {
    const bytes = Buffer.byteLength(block, "utf8");
    if (retainedBytes + bytes > NESTED_EXEC_MAX_BARRIER_BYTES) return false;
    try {
      if (bytes > 0) budget?.chargeRetained(bytes, { kind: "retained_collectors" });
    } catch {
      return false;
    }
    retained.push({ block, bytes });
    retainedBytes += bytes;
    return true;
  };

  const candidateFor = (payload: Record<string, unknown>): Candidate | "conflict" | undefined => {
    const identity = eventIdentity(payload);
    if (identity.itemIdConflict) return "conflict";
    if (identity.itemId !== undefined) {
      const direct = candidates.get(`id:${identity.itemId}`);
      if (direct) {
        if (identity.outerItemId !== undefined && identity.outerItemId !== direct.itemId) return "conflict";
        if (identity.innerItemId !== undefined && identity.innerItemId !== direct.itemId) return "conflict";
        if (identity.outputIndex !== undefined && direct.outputIndex !== undefined
          && identity.outputIndex !== direct.outputIndex) return "conflict";
        return direct;
      }
      if (identity.outputIndex !== undefined
        && [...candidates.values()].some(candidate => candidate.outputIndex === identity.outputIndex)) {
        return "conflict";
      }
      return undefined;
    }
    if (identity.outputIndex !== undefined) {
      const matches = [...candidates.values()].filter(candidate => candidate.outputIndex === identity.outputIndex);
      if (matches.length > 1) return "conflict";
      return matches[0];
    }
    return undefined;
  };

  const registerCandidate = (payload: Record<string, unknown>): Candidate | "conflict" | undefined => {
    if (payload.type !== "response.output_item.added" || !isPlainObject(payload.item)) return undefined;
    const name = candidateName(payload.item.name, plan);
    if (!name) return undefined;
    const identity = eventIdentity(payload);
    if (identity.itemIdConflict) return "conflict";
    const key = identityKey(identity);
    if (!key || candidates.has(key)) return "conflict";
    if (identity.outputIndex !== undefined
      && [...candidates.values()].some(candidate => candidate.outputIndex === identity.outputIndex)) {
      return "conflict";
    }
    const candidate: Candidate = {
      key,
      name,
      ...(identity.itemId !== undefined ? { itemId: identity.itemId } : {}),
      ...(identity.outerItemId !== undefined ? { outerItemId: identity.outerItemId } : {}),
      ...(identity.innerItemId !== undefined ? { innerItemId: identity.innerItemId } : {}),
      ...(identity.outputIndex !== undefined ? { outputIndex: identity.outputIndex } : {}),
      ...(typeof payload.item.call_id === "string" ? { callId: payload.item.call_id } : {}),
      ...(typeof payload.item.type === "string" ? { itemType: payload.item.type } : {}),
      complete: false,
    };
    candidates.set(key, candidate);
    return candidate;
  };

  const analyze = (payload: Record<string, unknown>, blockIndex: number): "ok" | "fallback" => {
    if (registerCandidate(payload) === "conflict") {
      debugProviderDiagnostic("nested-exec", "fallback", { reason: "duplicate-candidate", type: payload.type, identity: eventIdentity(payload) });
      return "fallback";
    }
    const type = payload.type;
    const match = candidateFor(payload);
    if (match === "conflict") {
      debugProviderDiagnostic("nested-exec", "fallback", { reason: "identity-match-conflict", type, identity: eventIdentity(payload) });
      return "fallback";
    }
    const candidate = match;
    if (type === "response.function_call_arguments.done" && candidate) {
      if (candidate.argumentDoneIndex !== undefined || typeof payload.arguments !== "string") return "fallback";
      candidate.argumentDoneIndex = blockIndex;
      candidate.argumentDoneText = payload.arguments;
    }
    if (type === "response.output_item.done" && candidate && isPlainObject(payload.item)) {
      if (candidate.complete) return "fallback";
      const doneShape = { id: payload.item.id, callId: payload.item.call_id, name: payload.item.name, itemType: payload.item.type };
      const addedShape = { id: candidate.itemId, callId: candidate.callId, name: candidate.name, itemType: candidate.itemType };
      if (candidate.itemId !== undefined && payload.item.id !== candidate.itemId) {
        debugProviderDiagnostic("nested-exec", "fallback", { reason: "done-item-id", addedShape, doneShape });
        return "fallback";
      }
      if (candidate.callId !== undefined && payload.item.call_id !== candidate.callId) {
        debugProviderDiagnostic("nested-exec", "fallback", { reason: "done-call-id", addedShape, doneShape });
        return "fallback";
      }
      if (candidate.itemType !== undefined && payload.item.type !== candidate.itemType) {
        debugProviderDiagnostic("nested-exec", "fallback", { reason: "done-item-type", addedShape, doneShape });
        return "fallback";
      }
      if (candidateName(payload.item.name, plan) !== candidate.name) {
        debugProviderDiagnostic("nested-exec", "fallback", { reason: "done-alias", addedShape, doneShape });
        return "fallback";
      }
      const itemArguments = typeof payload.item.arguments === "string" ? payload.item.arguments : undefined;
      if (candidate.argumentDoneText !== undefined && itemArguments !== undefined
        && !equivalentArguments(candidate.argumentDoneText, itemArguments)) return "fallback";
      const source = itemArguments ?? candidate.argumentDoneText;
      if (source === undefined) return "fallback";
      const repaired = repairNestedExecCallsInPayload({ ...payload.item, arguments: source }, plan);
      if (repaired.outcome !== "repaired" || !isPlainObject(repaired.value)
        || typeof repaired.value.arguments !== "string") return "fallback";
      candidate.normalizedArguments = repaired.value.arguments;
      candidate.normalizedDoneItem = repaired.value;
      candidate.complete = true;
    }
    return "ok";
  };

  const normalizedArgumentBlocks = (sourceBlock: string, candidate: Candidate): string[] => {
    const base = {
      ...(candidate.itemId !== undefined ? { item_id: candidate.itemId } : {}),
      ...(candidate.outputIndex !== undefined ? { output_index: candidate.outputIndex } : {}),
    };
    const deltaType = "response.function_call_arguments.delta";
    const doneType = "response.function_call_arguments.done";
    return [
      replaceBlock(sourceBlock, deltaType, { ...base, delta: candidate.normalizedArguments! }),
      replaceBlock(sourceBlock, doneType, { ...base, arguments: candidate.normalizedArguments! }),
    ];
  };

  const flushSuccess = (): readonly string[] => {
    const output: string[] = [];
    for (let index = 0; index < retained.length; index++) {
      const source = retained[index]!.block;
      const payload = parseBlock(source);
      if (!payload) {
        output.push(source);
        continue;
      }
      const match = candidateFor(payload);
      const candidate = match === "conflict" ? undefined : match;
      if (!candidate) {
        const repaired = terminalType(payload.type) ? repairNestedExecCallsInPayload(payload, plan) : undefined;
        output.push(repaired?.outcome === "repaired"
          ? replaceSseDataPayload(source, JSON.stringify(repaired.value))
          : source);
        continue;
      }
      if (payload.type === "response.output_item.added" && isPlainObject(payload.item)) {
        output.push(replaceSseDataPayload(source, JSON.stringify({
          ...payload,
          item: { ...payload.item, name: plan.execWireName },
        })));
        continue;
      }
      if (payload.type === "response.function_call_arguments.delta") continue;
      if (payload.type === "response.function_call_arguments.done") {
        output.push(...normalizedArgumentBlocks(source, candidate));
        continue;
      }
      if (payload.type === "response.output_item.done") {
        if (candidate.argumentDoneIndex === undefined) {
          output.push(...normalizedArgumentBlocks(source, candidate));
        }
        output.push(replaceSseDataPayload(source, JSON.stringify({
          ...payload,
          item: candidate.normalizedDoneItem,
        })));
        continue;
      }
      output.push(source);
    }
    release();
    return output;
  };

  const rewrite: SseBlockRewrite = (block: string) => {
    if (disposed) return [block];
    const payloadText = sseDataPayload(block);
    const payload = parseBlock(block);
    if (retained.length === 0) {
      if (payload && payload.type === "response.output_item.added" && isPlainObject(payload.item)
        && candidateName(payload.item.name, plan)) {
        if (!retain(block)) return [block];
        if (registerCandidate(payload) === "conflict") return fallback();
        return [];
      }
      if (payload && payload.type === "response.output_item.done" && isPlainObject(payload.item)
        && candidateName(payload.item.name, plan)) {
        const syntheticAdded = replaceBlock(block, "response.output_item.added", {
          ...payload,
          item: { ...payload.item, status: "in_progress", arguments: undefined },
        });
        if (!retain(syntheticAdded) || !retain(block)) return fallback();
        const addedPayload = parseBlock(syntheticAdded)!;
        if (registerCandidate(addedPayload) === "conflict") return fallback();
        if (analyze(payload, 1) === "fallback") return fallback();
        return flushSuccess();
      }
      if (payload && terminalType(payload.type)) {
        const repaired = repairNestedExecCallsInPayload(payload, plan);
        if (repaired.outcome === "repaired") {
          return [replaceSseDataPayload(block, JSON.stringify(repaired.value))];
        }
        if (repaired.outcome === "rejected") coordinator.reject();
      }
      return [block];
    }

    if (!retain(block)) {
      retained.push({ block, bytes: 0 });
      return fallback();
    }
    const blockIndex = retained.length - 1;
    if (payload && analyze(payload, blockIndex) === "fallback") return fallback();
    if (payloadText === "[DONE]" || (payload && terminalType(payload.type))) return fallback();
    if (candidates.size > 0 && [...candidates.values()].every(candidate => candidate.complete)) {
      return flushSuccess();
    }
    return [];
  };
  rewrite.dispose = () => {
    if (disposed) return;
    disposed = true;
    if (retained.length > 0) coordinator.reject();
    release();
  };
  return rewrite;
}

export type NestedExecInspectionDecision = Readonly<{
  action: "defer" | "inspect" | "reject";
  value?: unknown;
}>;

export type NestedExecInspectionState = Readonly<{
  notePayload(payload: unknown): NestedExecInspectionDecision;
  prepareResponseForCache(response: unknown): NestedExecInspectionDecision;
  dispose(): void;
}>;

export function createNestedExecInspectionState(
  plan: NestedExecRepairPlan,
  coordinator: NestedExecRepairCoordinator,
  budget?: TranslatorBudget,
): NestedExecInspectionState {
  const pending = new Map<string, { itemId?: string; outputIndex?: number }>();
  const completed = new Map<string, { item: Record<string, unknown>; outputIndex: number; bytes: number }>();
  let disposed = false;

  const releaseCompleted = (): void => {
    let bytes = 0;
    for (const entry of completed.values()) bytes += entry.bytes;
    if (bytes > 0) budget?.releaseRetained(bytes, { kind: "retained_collectors" });
    completed.clear();
  };
  const reject = (): NestedExecInspectionDecision => {
    coordinator.reject();
    pending.clear();
    releaseCompleted();
    return { action: "reject" };
  };

  return {
    notePayload(payload) {
      if (disposed || !isPlainObject(payload)) return { action: "inspect", value: payload };
      if (payload.type === "response.output_item.added" && isPlainObject(payload.item)
        && candidateName(payload.item.name, plan)) {
        const identity = eventIdentity(payload);
        const key = identityKey(identity);
        if (!key || pending.has(key)) return reject();
        pending.set(key, identity);
        return { action: "defer" };
      }
      const identity = eventIdentity(payload);
      const key = identityKey(identity);
      const candidate = key ? pending.get(key) : identity.outputIndex !== undefined
        ? [...pending.values()].find(entry => entry.outputIndex === identity.outputIndex)
        : undefined;
      if ((payload.type === "response.function_call_arguments.delta"
        || payload.type === "response.function_call_arguments.done") && candidate) {
        return { action: "defer" };
      }
      if (payload.type === "response.output_item.done" && candidate && isPlainObject(payload.item)) {
        const repaired = repairNestedExecCallsInPayload(payload, plan);
        if (repaired.outcome !== "repaired" || !isPlainObject(repaired.value)
          || !isPlainObject(repaired.value.item)) return reject();
        const outputIndex = identity.outputIndex ?? 0;
        const bytes = Buffer.byteLength(JSON.stringify(repaired.value.item), "utf8");
        try {
          if (bytes > 0) budget?.chargeRetained(bytes, { kind: "retained_collectors" });
        } catch {
          return reject();
        }
        const candidateKey = [...pending.entries()].find(([, entry]) => entry === candidate)?.[0] ?? key!;
        pending.delete(candidateKey);
        completed.set(candidateKey, { item: repaired.value.item, outputIndex, bytes });
        return { action: "inspect", value: repaired.value };
      }
      if (terminalType(payload.type)) {
        if (pending.size > 0) return reject();
        const repaired = repairNestedExecCallsInPayload(payload, plan);
        if (repaired.outcome === "rejected") return reject();
        return { action: "inspect", value: repaired.value };
      }
      return { action: "inspect", value: payload };
    },
    prepareResponseForCache(response) {
      if (disposed || pending.size > 0 || !isPlainObject(response)) return reject();
      const repaired = repairNestedExecCallsInPayload(response, plan);
      if (repaired.outcome === "rejected" || !isPlainObject(repaired.value)) return reject();
      const next: Record<string, unknown> = { ...repaired.value };
      const output = Array.isArray(next.output) ? [...next.output] : [];
      const ids = new Set(output.filter(isPlainObject).map(item => item.id).filter((id): id is string => typeof id === "string"));
      for (const entry of [...completed.values()].sort((left, right) => left.outputIndex - right.outputIndex)) {
        if (typeof entry.item.id === "string" && ids.has(entry.item.id)) continue;
        output.splice(Math.min(entry.outputIndex, output.length), 0, entry.item);
      }
      next.output = output;
      releaseCompleted();
      return { action: "inspect", value: next };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pending.size > 0) coordinator.reject();
      pending.clear();
      releaseCompleted();
    },
  };
}

export function createNestedExecClientOutcomeBlockRewrite(
  coordinator: NestedExecRepairCoordinator,
): SseBlockRewrite {
  const rewrite: SseBlockRewrite = (block: string) => {
    const payloadText = sseDataPayload(block);
    const payload = parseBlock(block);
    if (payload && (payload.type === "response.completed" || payload.type === "response.incomplete")) {
      coordinator.markClientCommitted();
    } else if (payload && payload.type === "response.failed") {
      coordinator.reject();
    } else if (payloadText === "[DONE]") {
      // A prior canonical terminal owns the decision; DONE alone never commits.
    }
    return [block];
  };
  rewrite.dispose = () => coordinator.dispose();
  return rewrite;
}

/** Client tool-catalog facts plus the adapter-event repair plan derived from them. */
export type NestedExecAdapterEventRepair = Readonly<{
  clientToolAuthorizationBody: unknown;
  clientExplicitWireToolCatalog: boolean;
  clientDeclaredWireToolNames: ReadonlySet<string>;
  clientDeclaredNamelessCallTypes: ReadonlySet<string>;
  currentTurnExecDeclaration: CurrentTurnExecDeclaration | undefined;
  plan: NestedExecRepairPlan | undefined;
  repairSource: (source: AsyncIterable<AdapterEvent>) => AsyncIterable<AdapterEvent>;
  repairBatch: (events: AdapterEvent[]) => Promise<AdapterEvent[]>;
}>;

export function createNestedExecAdapterEventRepair(args: {
  rawBody: unknown;
  replayPrefixLength: number;
  isPassthrough: boolean;
  translatorBudget: TranslatorBudget;
}): NestedExecAdapterEventRepair {
  const clientToolAuthorizationBody = currentTurnWireToolCatalogBody(args.rawBody, args.replayPrefixLength);
  const clientExplicitWireToolCatalog = hasExplicitWireToolCatalog(clientToolAuthorizationBody);
  const clientDeclaredWireToolNames = collectDeclaredWireToolNames(clientToolAuthorizationBody);
  const clientDeclaredNamelessCallTypes = collectDeclaredNamelessClientCallTypes(clientToolAuthorizationBody);
  const currentTurnExecDeclaration = findUniqueCurrentTurnExecDeclaration(clientToolAuthorizationBody);
  const plan = !args.isPassthrough && currentTurnExecDeclaration && clientDeclaredWireToolNames.has("exec")
    ? buildNestedExecRepairPlan({
        execIsDeclaredOnWire: true,
        directlyDeclaredWireNames: clientDeclaredWireToolNames,
      })
    : undefined;
  const repairSource = (source: AsyncIterable<AdapterEvent>): AsyncIterable<AdapterEvent> =>
    plan ? repairNestedExecAdapterEvents(source, plan, args.translatorBudget) : source;
  const repairBatch = async (events: AdapterEvent[]): Promise<AdapterEvent[]> => {
    if (!plan) return events;
    const repaired: AdapterEvent[] = [];
    for await (const event of repairNestedExecAdapterEvents(
      (async function* () { yield* events; })(),
      plan,
      args.translatorBudget,
    )) repaired.push(event);
    return repaired;
  };
  return {
    clientToolAuthorizationBody,
    clientExplicitWireToolCatalog,
    clientDeclaredWireToolNames,
    clientDeclaredNamelessCallTypes,
    currentTurnExecDeclaration,
    plan,
    repairSource,
    repairBatch,
  };
}

/** Passthrough-side nested-exec repair trio: plan + coordinator + inspection state. */
export type NestedExecPassthroughRepair = Readonly<{
  plan: NestedExecRepairPlan | undefined;
  coordinator: NestedExecRepairCoordinator | undefined;
  inspection: NestedExecInspectionState | undefined;
}>;

export function createNestedExecPassthroughRepair(args: {
  execWasLowered: boolean;
  currentTurnExecDeclaration: CurrentTurnExecDeclaration | undefined;
  clientDeclaredWireToolNames: ReadonlySet<string>;
  translatorBudget: TranslatorBudget;
}): NestedExecPassthroughRepair {
  const plan = buildNestedExecRepairPlan({
    execWasLowered: args.execWasLowered && args.currentTurnExecDeclaration?.kind === "custom",
    execIsDeclaredOnWire: args.currentTurnExecDeclaration?.kind === "function"
      && args.clientDeclaredWireToolNames.has("exec"),
    directlyDeclaredWireNames: args.clientDeclaredWireToolNames,
  });
  const coordinator = plan ? createNestedExecRepairCoordinator(args.translatorBudget) : undefined;
  const inspection = plan && coordinator
    ? createNestedExecInspectionState(plan, coordinator, args.translatorBudget)
    : undefined;
  return { plan, coordinator, inspection };
}

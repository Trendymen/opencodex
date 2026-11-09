import type { TranslatorBudget } from "../lib/translator-budget";
import type { DecodedJsonCapture } from "../server/request-decompress";

export interface CodexRequestSource {
  release(): void;
}

type RecoveryChange = { apply(item: unknown): boolean; retainedBytes: number };
type ItemOrigin = { key: string; history: boolean };
type SourceState = { text?: string; serializedBytes: number; releaseText(): void; copies: Set<() => void>;
  budget: TranslatorBudget; recovery: Map<string, { origin: ItemOrigin; change: RecoveryChange; release(): void }> };
const sources = new WeakMap<CodexRequestSource, SourceState>();
const items = new WeakMap<object, { source: CodexRequestSource; origin: ItemOrigin }>();
const replays = new WeakMap<Request, { source: CodexRequestSource; origins: Map<number, ItemOrigin> }>();

export class CodexRecoveredInputUnavailableError extends Error {
  constructor() { super("Recovered Codex request input is unavailable"); }
}

function inputItems(body: unknown): unknown[] {
  const input = body && typeof body === "object" ? (body as { input?: unknown }).input : undefined;
  return Array.isArray(input) ? input : [];
}

export function bindCodexRequestSourceItems(source: CodexRequestSource, body: unknown, request?: Request): void {
  if (sources.get(source)?.text === undefined) return;
  const replay = request && replays.get(request);
  for (const [index, item] of inputItems(body).entries()) {
    if (!item || typeof item !== "object") continue;
    const origin = replay?.source === source ? replay.origins.get(index)
      : (item as { type?: unknown }).type === "agent_message" ? { key: `raw:${index}`, history: false } : undefined;
    if (origin) items.set(item, { source, origin });
  }
}

export function bindCodexRequestHistory(source: CodexRequestSource | undefined, body: unknown): void {
  const state = source && sources.get(source);
  if (!source || !state || state.text === undefined) return;
  const previous = body && typeof body === "object" ? (body as { previous_response_id?: unknown }).previous_response_id : undefined;
  if (typeof previous !== "string") return;
  const input = inputItems(body);
  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "agent_message" || items.get(item)?.source === source) continue;
    const copy = structuredClone(item);
    const release = state.budget.observeAcceptedRequestCopy(new TextEncoder().encode(JSON.stringify(copy)).byteLength);
    state.copies.add(release);
    input[index] = copy;
    items.set(copy, { source, origin: { key: JSON.stringify(["history", previous, index]), history: true } });
  }
}

export function linkCodexRequestReplay(source: CodexRequestSource | undefined, request: Request, body: unknown): void {
  if (!source || sources.get(source)?.text === undefined) return;
  const origins = new Map<number, ItemOrigin>();
  for (const [index, item] of inputItems(body).entries()) {
    const binding = item && typeof item === "object" ? items.get(item) : undefined;
    if (binding?.source === source) origins.set(index, binding.origin);
  }
  replays.set(request, { source, origins });
}

export function recordCodexSourceRecovery(item: object, change: RecoveryChange): void {
  const binding = items.get(item);
  if (!binding) return;
  const state = sources.get(binding.source);
  if (!state || state.text === undefined) return;
  const release = state.budget.observeAcceptedRequestCopy(change.retainedBytes);
  state.recovery.get(binding.origin.key)?.release();
  state.recovery.set(binding.origin.key, { origin: binding.origin, change, release });
}

export function replayCodexSourceRecovery(source: CodexRequestSource, body: unknown, includeHistory: boolean): boolean {
  const state = sources.get(source);
  if (!state?.recovery.size) return false;
  const targets = new Map<string, unknown>();
  for (const item of inputItems(body)) {
    const binding = item && typeof item === "object" ? items.get(item) : undefined;
    if (binding?.source === source) targets.set(binding.origin.key, item);
  }
  let applied = false;
  for (const { origin, change } of state.recovery.values()) {
    if (origin.history && !includeHistory) continue;
    if (!change.apply(targets.get(origin.key))) throw new CodexRecoveredInputUnavailableError();
    applied = true;
  }
  return applied;
}

export function retainCodexRequestSource(capture: DecodedJsonCapture, budget: TranslatorBudget): CodexRequestSource {
  const state: SourceState = { text: capture.jsonText, serializedBytes: capture.serializedBytes,
    releaseText: capture.takeTextLease(), copies: new Set(), budget, recovery: new Map() };
  const source: CodexRequestSource = {
    release() {
      if (state.text === undefined) return;
      state.text = undefined;
      state.releaseText();
      for (const release of state.copies) release();
      state.copies.clear();
      for (const entry of state.recovery.values()) entry.release();
      state.recovery.clear();
    },
  };
  sources.set(source, state);
  bindCodexRequestSourceItems(source, capture.value);
  return source;
}

export function materializeCodexRequestSource(source: CodexRequestSource, budget: TranslatorBudget): { body: unknown; release(): void } {
  const state = sources.get(source);
  if (state?.text === undefined) throw new Error("Codex request source is unavailable");
  const releaseCopy = budget.observeAcceptedRequestCopy(state.serializedBytes);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseCopy();
    state.copies.delete(release);
  };
  try {
    const body: unknown = JSON.parse(state.text);
    bindCodexRequestSourceItems(source, body);
    state.copies.add(release);
    return { body, release };
  } catch (error) { release(); throw error; }
}

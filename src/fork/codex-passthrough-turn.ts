import type { OcxProviderConfig } from "../types";
import type { InboundWire } from "../providers/registry/types";
import { getProviderRegistryEntry } from "../providers/registry";
import { CODEX_FORWARD_BASE_URL, isCanonicalOpenAiForwardProvider, normalizedOpenAiBaseUrl } from "../providers/openai-tiers-destination";
import { readCodexPassthroughConfig, resolveCodexPassthroughPermissions, CODEX_PASSTHROUGH_DEFAULTS, type CodexPassthroughPermissions } from "./codex-passthrough-contract";
import { retainCodexRequestSource, materializeCodexRequestSource, bindCodexRequestSourceItems, type CodexRequestSource } from "./codex-passthrough-source";
import type { DecodedJsonCapture } from "../server/request-decompress";
import type { TranslatorBudget } from "../lib/translator-budget";
import { carryCodexLocalFailure } from "./codex-passthrough-local-errors";

declare const turnBrand: unique symbol;
export type CodexPassthroughTurn = { readonly [turnBrand]: true };
type TurnState = { overrides: Readonly<Record<string, CodexPassthroughPermissions>>; source?: CodexRequestSource; released: boolean };
const turns = new WeakMap<CodexPassthroughTurn, TurnState>();
const responses = new WeakMap<Response, CodexPassthroughPermissions | null>();

function possibleDestination(auth: unknown, base: unknown): boolean {
  const origin = normalizedOpenAiBaseUrl(typeof base === "string" ? base : undefined);
  if (typeof auth !== "string" || !origin) return true;
  return auth === "forward" && origin === CODEX_FORWARD_BASE_URL;
}

function possibleProvider(name: string, provider: OcxProviderConfig): boolean {
  const entry = getProviderRegistryEntry(name);
  return possibleDestination(provider?.authMode, provider?.baseUrl)
    || !!entry && possibleDestination(entry.authKind, entry.baseUrl);
}

export function shouldRetainCodexRequestSource(providers: Readonly<Record<string, OcxProviderConfig>>, inboundWire: InboundWire): boolean {
  if (inboundWire !== "responses") return false;
  const entries = Object.entries(providers);
  return entries.length === 0 || entries.some(([name, provider]) => possibleProvider(name, provider));
}

export function captureCodexPassthroughTurn(providers: Readonly<Record<string, OcxProviderConfig>>, inboundWire: InboundWire): CodexPassthroughTurn | undefined {
  if (!shouldRetainCodexRequestSource(providers, inboundWire)) return undefined;
  const overrides = Object.fromEntries(Object.entries(providers).filter(([name, provider]) => possibleProvider(name, provider))
    .map(([name, provider]) => [name, resolveCodexPassthroughPermissions(readCodexPassthroughConfig(provider?.codexPassthrough).value)]));
  const turn = Object.freeze({}) as CodexPassthroughTurn;
  turns.set(turn, { overrides: Object.freeze(overrides), released: false });
  return turn;
}

export function resolveCodexPassthroughAttempt(turn: CodexPassthroughTurn | undefined, destination: {
  providerName: string; provider: OcxProviderConfig; inboundWire: InboundWire;
}): CodexPassthroughPermissions | undefined {
  if (!turn || destination.inboundWire !== "responses" || !isCanonicalOpenAiForwardProvider(destination.provider)) return undefined;
  const overrides = turns.get(turn)?.overrides;
  return overrides && Object.hasOwn(overrides, destination.providerName) ? overrides[destination.providerName] : CODEX_PASSTHROUGH_DEFAULTS;
}

export function codexPassthroughStreamPolicy(provider: OcxProviderConfig, permissions: CodexPassthroughPermissions | undefined,
  parsedStream: boolean, clientRequestedStream: boolean): { upstreamRequestsStream: boolean; canonicalBufferedJson: boolean } {
  const normalizedStream = isCanonicalOpenAiForwardProvider(provider) && permissions?.normalizeRequestParameters !== false;
  // Recovery must classify the stream requested upstream, including when ChatGPT omits Content-Type.
  // Parameter normalization forces SSE on the outbound copy without changing the client's preference.
  // JSON clients stay on HTTP so delivery can fold SSE and preserve manual redirect handling.
  return {
    upstreamRequestsStream: parsedStream === true || normalizedStream,
    canonicalBufferedJson: clientRequestedStream !== true && normalizedStream,
  };
}

export function codexPassthroughSourceRequired(turn: CodexPassthroughTurn | undefined): boolean {
  return !!turn && turns.has(turn);
}

export function retainCodexPassthroughTurnSource(turn: CodexPassthroughTurn | undefined, capture: DecodedJsonCapture, budget: TranslatorBudget, request?: Request): void {
  const state = turn && turns.get(turn);
  if (!state) return;
  if (state.source) { bindCodexRequestSourceItems(state.source, capture.value, request); return; }
  const source = retainCodexRequestSource(capture, budget);
  if (state.released) source.release();
  else state.source = source;
}

export function materializeCodexPassthroughTurnSource(turn: CodexPassthroughTurn | undefined, budget: TranslatorBudget): { body: unknown; release(): void } {
  const state = turn && turns.get(turn);
  if (!state?.source || state.released) throw new Error("Codex request source is unavailable");
  return materializeCodexRequestSource(state.source, budget);
}

export function codexPassthroughRequestSource(turn: CodexPassthroughTurn | undefined): CodexRequestSource | undefined {
  const state = turn && turns.get(turn);
  return state && !state.released ? state.source : undefined;
}

export function releaseCodexPassthroughTurnSource(turn: CodexPassthroughTurn | undefined): void {
  const state = turn && turns.get(turn);
  if (!state || state.released) return;
  state.released = true;
  state.source?.release();
  state.source = undefined;
}

export function markCodexPassthroughResponse(response: Response, permissions: CodexPassthroughPermissions | undefined): Response {
  if (permissions) responses.set(response, permissions);
  else responses.delete(response);
  return response;
}

export function codexPassthroughResponsePermissions(response: Response): CodexPassthroughPermissions | undefined {
  return responses.get(response) ?? undefined;
}

export function carryCodexPassthroughResponse(source: Response, target: Response): Response {
  carryCodexLocalFailure(source, target);
  if (isNonReplayableResponse(source)) markResponseNonReplayable(target);
  if (isReplayRefusalResponse(source)) markReplayRefusalResponse(target);
  if (responses.get(source) === null) { responses.set(target, null); return target; }
  return markCodexPassthroughResponse(target, responses.get(source) ?? undefined);
}

export function markCodexPassthroughAttemptResponse(response: Response, turn: CodexPassthroughTurn | undefined,
  destination: Parameters<typeof resolveCodexPassthroughAttempt>[1]): Response {
  if (!responses.has(response)) responses.set(response, resolveCodexPassthroughAttempt(turn, destination) ?? null);
  return response;
}
import { isNonReplayableResponse, isReplayRefusalResponse, markResponseNonReplayable, markReplayRefusalResponse } from "../lib/upstream-retry";

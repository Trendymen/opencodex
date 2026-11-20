import type { PassthroughDispatchInputs } from "../server/responses-passthrough-dispatch-types";
import type { NativeReplayGuard } from "../server/responses/native-replay-guard";
import type { OcxReasoningReplayScopeRef } from "../types";
import { containsRetainedKimiNativeReasoning, kimiReplayScopeForEndpoint, rememberKimiNativeReasoning } from "./kimi-reasoning-replay";

type ReplayResponse = { id?: unknown; output?: unknown; status?: unknown };

export function createKimiPassthroughReplay(
  guard: Pick<NativeReplayGuard, "sendHandler" | "record">,
  state: () => {
    parsed: PassthroughDispatchInputs["requestState"]["parsed"];
    route: PassthroughDispatchInputs["requestState"]["route"];
    url: string;
  },
) {
  let servedScope: OcxReasoningReplayScopeRef | undefined;
  let servedBody: BodyInit | null | undefined;
  let retainedReasoning: boolean | undefined;
  const capture = (body: BodyInit | null | undefined, url?: string): void => {
    const { parsed, route, url: currentUrl } = state();
    servedScope = route.provider.authMode !== "forward" && route.provider.arkKimiResponsesModels?.includes(route.modelId)
      ? kimiReplayScopeForEndpoint(parsed._reasoningReplayScope, url ?? currentUrl) : undefined;
    servedBody = body;
    retainedReasoning = undefined;
  };
  const track = (next?: () => void) => (body?: BodyInit | null): void => guard.sendHandler(() => {
    next?.();
    capture(body);
  })(body);
  track.record = (request: Parameters<NativeReplayGuard["record"]>[0], body: BodyInit | null | undefined): void => {
    guard.record(request, body);
    capture(body, request.url);
  };
  track.hasRetainedReasoning = (body: string | undefined): boolean => {
    if (!servedScope || state().parsed._stripReasoningEncryptedContent !== true
      || typeof servedBody !== "string" || servedBody !== body) return false;
    if (retainedReasoning !== undefined) return retainedReasoning;
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(servedBody); } catch { return retainedReasoning = false; }
    return retainedReasoning = containsRetainedKimiNativeReasoning(parsedBody, servedScope);
  };
  track.remember = (
    accepted: unknown,
    response: { status?: unknown },
    rememberPassthroughResponse: ((response: ReplayResponse) => void) | undefined,
  ): void => {
    if (response.status === "completed" && servedScope) rememberKimiNativeReasoning((accepted as ReplayResponse | null)?.output, servedScope);
    rememberPassthroughResponse?.(accepted as ReplayResponse);
  };
  return track;
}

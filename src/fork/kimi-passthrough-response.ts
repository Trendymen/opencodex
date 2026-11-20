import type { PassthroughDispatchInputs } from "../server/responses-passthrough-dispatch-types";
import { rememberKimiNativeReasoning } from "./kimi-reasoning-replay";

type ReplayResponse = { id?: unknown; output?: unknown; status?: unknown };

export function rememberAcceptedPassthroughResponse(
  accepted: unknown,
  response: { status?: unknown },
  route: PassthroughDispatchInputs["requestState"]["route"],
  parsed: PassthroughDispatchInputs["requestState"]["parsed"],
  rememberPassthroughResponse: ((response: ReplayResponse) => void) | undefined,
): void {
  if (response.status === "completed" && route.provider.arkKimiResponsesModels?.includes(route.modelId)) {
    rememberKimiNativeReasoning(
      (accepted as ReplayResponse | null)?.output,
      parsed._reasoningReplayScope,
    );
  }
  rememberPassthroughResponse?.(accepted as ReplayResponse);
}

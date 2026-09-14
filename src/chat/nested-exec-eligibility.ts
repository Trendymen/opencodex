/** Nested-exec surface detection for the Chat inbound path (relay fork). */

import { chatCompletionsToResponsesBody } from "./inbound";
import { hasCurrentTurnNestedExecSurface } from "../responses/nested-exec-call-repair";

export function carriesCodeModeNestedExecSurface(rawBody: Record<string, unknown>): boolean {
  try {
    return hasCurrentTurnNestedExecSurface(chatCompletionsToResponsesBody(rawBody));
  } catch {
    // Validation owns malformed-request errors; eligibility must have no side effects.
    return false;
  }
}

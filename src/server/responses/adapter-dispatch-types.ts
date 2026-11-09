import type { ResponsesRequestContext, ResponsesAdmissionState } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesEffects } from "./response-effects";
import type { ResponsesSendBudget } from "./request-send-budget";

export interface AdapterDispatchInputs {
  requestContext: Pick<ResponsesRequestContext, "options" | "config" | "logCtx" | "req">;
  admissionState: ResponsesAdmissionState;
  requestState: Pick<
    PreparedResponsesRequest,
    | "parsed"
    | "toolBridgeMaps"
    | "translatorBudget"
    | "selectedForwardHeaders"
    | "route"
    | "inboundWire"
    | "clientRequestedStream"
    | "subagentQuotaFailureModel"
    | "subagentFallbackAccountId"
  >;
  transportState: Pick<
    ResponsesTransport,
    | "activeAdapter"
    | "adapter"
    | "sameTargetRequest"
    | "sameTargetParsed"
    | "sameTargetToken"
    | "transportToken"
    | "oauthDispatch"
    | "recoverAutoPausedSelection"
    | "imageTierBias"
    | "oauth401ReplayAttempted"
    | "isOAuth401ReplayProvider"
    | "sentOAuthSnapshot"
    | "refreshResolvedOAuthSelection"
    | "replayOAuthCredentialSnapshot"
    | "invalidateSameTargetRequest"
    | "resolveSelectionAdapter"
    | "resolveCopilotSelection"
    | "copilotRefusalResponse"
    | "anthropicInstance"
    | "currentAnthropicRouteDecision"
    | "anthropicRouteDecision"
    | "anthropicPoolAccountId"
    | "anthropicPoolFailovers"
    | "anthropicSessionKey"
    | "commitResolvedOAuthSelection"
    | "genericFailoverAccountId"
    | "genericFailovers"
    | "genericFailoverLimit"
    | "applyFailoverSnapshot"
    | "noteRoutedAttemptSend"
  >;
  responseEffects: Pick<ResponsesEffects, "cancelResponseCompletion" | "notifyResponseComplete" | "refreshRequestToolAliases">;
  sendBudgetState: Pick<
    ResponsesSendBudget,
    | "adapterSendBudget"
    | "adapterDispatchBudget"
    | "noteAdapterPhysicalSend"
    | "noteAdapterRecoveryWithheld"
    | "remainingTransientSendBudget"
    | "adapterSendBudget"
    | "transientSendReporter"
    | "recoverySendAllowance"
    | "recoveryClassFor"
    | "sendBudgetExhausted"
    | "reserveCredentialHop"
    | "pendingHopPermit"
    | "workflowRootId"
    | "claimAmbiguousResend"
    | "sendsUsed"
    | "targetSendsUsed"
    | "initialSendAllowance"
    | "noteInitialDispatch"
  >;
}

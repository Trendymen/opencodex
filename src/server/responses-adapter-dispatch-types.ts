import type { ResponsesRequestContext, ResponsesAdmissionState } from "./responses/core-options";
import type { PreparedResponsesRequest } from "./responses/request-prepare";
import type { ResponsesTransport } from "./responses/request-transport";
import type { ResponsesEffects } from "./responses/response-effects";
import type { ResponsesSendBudget } from "./responses/request-send-budget";

export interface AdapterDispatchInputs {
  requestContext: Pick<ResponsesRequestContext, "options" | "config" | "logCtx" | "req">;
  admissionState: ResponsesAdmissionState;
  requestState: Pick<
    PreparedResponsesRequest,
    | "parsed"
    | "toolBridgeMaps"
    | "translatorBudget" | "completedToolBlocks"
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
    | "pinAnthropicImageRecovery"
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
    | "genericFailoverLimit" | "anthropicFailoverLimit"
    | "applyFailoverSnapshot"
    | "noteRoutedAttemptSend" | "attemptSendDeferred" | "deferPhysicalAttribution" | "commitAdapterAttemptSend"
    | "createCredentialReplayAttempt" | "credentialReplayHandoff"
  >;
  responseEffects: Pick<ResponsesEffects, "cancelResponseCompletion" | "notifyResponseComplete" | "refreshRequestToolAliases">;
  sendBudgetState: Pick<
    ResponsesSendBudget,
    | "adapterSendBudget"
    | "adapterDispatchBudget"
    | "noteAdapterPhysicalSend"
    | "noteAdapterRecoveryWithheld"
    | "imageRecoverySendReporter"
    | "remainingTransientSendBudget"
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
    | "compactHandoffSendCeiling"
    | "initialSendAllowance"
    | "noteInitialDispatch"
  >;
}

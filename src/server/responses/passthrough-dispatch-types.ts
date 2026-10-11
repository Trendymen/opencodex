import type {
  ResponsesRequestContext,
  ResponsesAdmissionState,
  PassthroughAdmissionState,
} from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesEffects } from "./response-effects";
import type { ResponsesSendBudget } from "./request-send-budget";

export interface PassthroughDispatchInputs {
  requestContext: Pick<ResponsesRequestContext, "config" | "logCtx" | "options" | "req">;
  admissionState: ResponsesAdmissionState;
  nativeHostState: PassthroughAdmissionState;
  requestState: Pick<
    PreparedResponsesRequest,
    | "route"
    | "toolBridgeMaps"
    | "parsed"
    | "adoptParsedRequest"
    | "translatorBudget"
    | "responseStateOptions"
    | "selectedForwardHeaders"
    | "clientRequestedStream"
    | "inboundWire"
    | "clientDeclaredEmptyToolCatalog"
    | "substituteMainCredential"
    | "callerAuthHeaders"
    | "subagentFallbackAccountId"
    | "parentThreadId"
    | "threadSpawn"
  >;
  transportState: Pick<
    ResponsesTransport,
    | "adapter"
    | "genericFailoverAccountId"
    | "passiveQuotaWriterGeneration"
    | "oauthDispatch"
    | "resolveSelectionAdapter"
    | "resolveCopilotSelection"
    | "copilotRefusalResponse"
    | "oauth401ReplayAttempted"
    | "activeAdapter"
    | "runTurnAdapter"
    | "invalidateSameTargetRequest"
    | "isOAuth401ReplayProvider"
    | "sentOAuthSnapshot"
    | "refreshResolvedOAuthSelection"
    | "replayOAuthCredentialSnapshot"
    | "genericFailovers"
    | "genericFailoverLimit"
    | "applyFailoverSnapshot"
    | "noteRoutedAttemptSend"
    | "selectionIsCurrent"
    | "requestBindings"
  >;
  responseEffects: Pick<
    ResponsesEffects,
    | "refreshRequestToolAliases"
    | "routedMuseToolNameAliases"
    | "plaintextV2AgentMessageToolNames"
    | "routedNamespaceToolAliases"
    | "plaintextV2AgentMessageAliasedToolNames"
    | "notifyResponseComplete"
  >;
  sendBudgetState: Pick<
    ResponsesSendBudget,
    | "remainingTransientSendBudget"
    | "noteTransientSends"
    | "transientSendReporter"
    | "recoverySendAllowance"
    | "recoveryClassFor"
    | "sendBudgetExhausted"
    | "claimAmbiguousResend"
    | "ambiguousResendSpent"
    | "reserveCredentialHop"
    | "pendingHopPermit"
    | "workflowRootId"
    | "sendsUsed"
    | "targetSendsUsed"
    | "initialSendAllowance"
    | "noteInitialDispatch"
    | "adapterSendBudget"
  >;
}

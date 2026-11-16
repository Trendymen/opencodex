import type {
  ResponsesRequestContext,
  ResponsesAdmissionState,
  PassthroughAdmissionState,
} from "./responses/core-options";
import type { PreparedResponsesRequest } from "./responses/request-prepare";
import type { ResponsesTransport } from "./responses/request-transport";
import type { ResponsesEffects } from "./responses/response-effects";
import type { ResponsesSendBudget } from "./responses/request-send-budget";

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
    | "recoverAutoPausedSelection"
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
    | "deferPhysicalAttribution"
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
    | "continuationSendReporter"
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

/** Transfer an uncommitted Copilot exchange to the existing translated pipeline without new admission. */
export interface PassthroughAdapterHandoff { kind: "adapter-handoff" }
export type PassthroughExchange = Exclude<Awaited<ReturnType<typeof import("./responses/passthrough-dispatch").preparePassthroughExchange>>, Response | PassthroughAdapterHandoff>;

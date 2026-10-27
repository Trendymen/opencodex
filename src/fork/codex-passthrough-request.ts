import type { OcxConfig, OcxParsedRequest } from "../types";
import type { RouteResult } from "../router";
import type { RequestLogContext } from "../server/request-log";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { CodexPassthroughPermissions } from "./codex-passthrough-contract";
import { materializeCodexRequestSource, bindCodexRequestHistory, replayCodexSourceRecovery, type CodexRequestSource } from "./codex-passthrough-source";
import { expandPreviousResponseInput, previousResponseReplayFailure, markBodyNonPersistable } from "../responses/state";
import { parseRequest } from "../responses/parser";
import { sanitizeEncryptedContentInPlace, strictBackendEncryptedAgentTaskContentPart } from "../server/responses/encrypted-payload";
import { snapshotSkillsCatalogInBody } from "../server/responses/skills-snapshot";
import { rewriteAnnotationInstructionsInPlace } from "../server/responses/annotation-instructions";
import { redactHostedImageDisplayPaths } from "../server/responses-hosted-image-display";
import { parseSyntheticRowId } from "../server/fast-row";
import { shouldPreparePlaintextV2AgentMessages } from "../responses/plaintext-v2-agent-messages";
import { applyRoutedMultiAgentGuidance } from "../server/responses/core-normalize";

export interface CanonicalRequestPreparationContext {
  req: Request;
  config: OcxConfig;
  logCtx: RequestLogContext;
  route: RouteResult;
  translatorBudget: TranslatorBudget;
  skillsScopeKey: string | undefined;
  modelOverride?: string;
  deferredGuidanceReasoning?: { value: OcxParsedRequest["options"]["reasoning"] };
  adoptParsedRequest(next: OcxParsedRequest): void;
}

export class CodexContinuationUnavailableError extends Error {
  constructor() { super("Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id."); }
}

export async function prepareCanonicalCodexRequest(source: CodexRequestSource, permissions: CodexPassthroughPermissions,
  context: CanonicalRequestPreparationContext): Promise<{ body: unknown; parsed: OcxParsedRequest; commitPreparedEffects(): void; release(): void }> {
  const copy = materializeCodexRequestSource(source, context.translatorBudget);
  try {
    let body = copy.body;
    if (permissions.normalizeHostedImages) redactHostedImageDisplayPaths(body);
    const original = body;
    if (permissions.expandRequestHistory) {
      body = expandPreviousResponseInput(body, context.req.headers.get("x-codex-parent-thread-id")?.trim() || undefined);
      if (previousResponseReplayFailure(body)) throw new CodexContinuationUnavailableError();
      bindCodexRequestHistory(source, body);
    }
    if (replayCodexSourceRecovery(source, body, permissions.expandRequestHistory)) markBodyNonPersistable(body);
    const raw = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
    if (strictBackendEncryptedAgentTaskContentPart(raw?.input)) markBodyNonPersistable(body);
    if (permissions.normalizeEncryptedContent) sanitizeEncryptedContentInPlace(raw?.input, { preserveUnknownOpaqueSlots: true });
    const commitSkills = permissions.snapshotSkillsCatalog ? snapshotSkillsCatalogInBody(body, context.skillsScopeKey ?? null, context.config) : undefined;
    if (permissions.rewriteAnnotationInstructions) rewriteAnnotationInstructionsInPlace(raw?.input);
    if (permissions.normalizeEncryptedContent) {
      const task = strictBackendEncryptedAgentTaskContentPart(raw?.input);
      sanitizeEncryptedContentInPlace(raw?.input, task ? { preserveEncryptedContentParts: new Set([task]) } : undefined);
    }
    const parsed = parseRequest(body);
    if (body !== original && typeof raw?.previous_response_id === "string") parsed._previousResponseInputExpanded = true;
    const { fastRow, effortRow } = parseSyntheticRowId(parsed.modelId, context.config);
    if (raw && fastRow) { raw.model = fastRow.baseId; raw.service_tier = "priority"; parsed.options.serviceTier = "priority"; }
    if (raw && effortRow) {
      raw.model = effortRow.baseId;
      raw.reasoning = { ...(raw.reasoning && typeof raw.reasoning === "object" && !Array.isArray(raw.reasoning) ? raw.reasoning : {}), effort: effortRow.effort };
      parsed.options.reasoning = effortRow.effort;
    }
    if (raw && context.modelOverride !== undefined) { raw.model = context.modelOverride; parsed.modelId = context.modelOverride; }
    context.adoptParsedRequest(parsed);
    parsed._plaintextV2AgentMessages = shouldPreparePlaintextV2AgentMessages({ enabled: context.config.plaintextV2AgentMessages === true,
      inboundWire: "responses", canonicalChatGpt: true, requestBody: parsed._rawBody });
    if (permissions.normalizeRequestParameters) await applyRoutedMultiAgentGuidance(parsed, context.route, context.config, context.deferredGuidanceReasoning);
    let committed = false;
    return { body, parsed, release: copy.release, commitPreparedEffects() {
      if (committed) return;
      committed = true;
      commitSkills?.();
    } };
  } catch (error) { copy.release(); throw error; }
}

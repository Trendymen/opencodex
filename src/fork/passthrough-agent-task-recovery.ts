import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { isNonReplayableResponse, isTransientUpstreamStatus } from "../lib/upstream-retry";
import { markBodyNonPersistable } from "../responses/state";
import { parseRequest } from "../responses/parser";
import { agentTaskRecoveryConfig, recoverEncryptedAgentTask } from "../server/responses/agent-task-recovery";
import { hasStrictBackendEncryptedAgentTask } from "../server/responses/encrypted-payload";

interface NativeEncryptedTaskRecoveryInput {
  transientRetryExhausted: boolean;
  upstreamResponse: Response;
  inboundWire: string;
  threadSpawn: boolean;
  comboAttempt?: boolean;
  provider: OcxProviderConfig;
  parsed: OcxParsedRequest;
  config: OcxConfig;
  req: Request;
  parentThreadId: string | null;
  abortSignal?: AbortSignal;
}

type NativeEncryptedTaskRecoveryResult =
  | { kind: "skipped" }
  | { kind: "aborted"; reason: unknown }
  | { kind: "recovered"; parsed: OcxParsedRequest };

export async function maybeRecoverNativeEncryptedAgentTask({
  transientRetryExhausted,
  upstreamResponse,
  inboundWire,
  threadSpawn,
  comboAttempt,
  provider,
  parsed,
  config,
  req,
  parentThreadId,
  abortSignal,
}: NativeEncryptedTaskRecoveryInput): Promise<NativeEncryptedTaskRecoveryResult> {
  const input = (parsed._rawBody as { input?: unknown } | undefined)?.input;
  if (!transientRetryExhausted
    || !isTransientUpstreamStatus(upstreamResponse.status)
    || isNonReplayableResponse(upstreamResponse)
    || inboundWire !== "responses"
    || !threadSpawn
    || comboAttempt
    || !isCanonicalOpenAiForwardProvider(provider)
    || !hasStrictBackendEncryptedAgentTask(input)) return { kind: "skipped" };

  let recovered = false;
  try {
    const recovery = agentTaskRecoveryConfig(config);
    if (recovery) recovered = await recoverEncryptedAgentTask(
      req, input, recovery, config, { parentThreadId, abortSignal },
    );
  } catch {
    recovered = false;
  }
  if (abortSignal?.aborted || req.signal.aborted) {
    return {
      kind: "aborted",
      reason: abortSignal?.reason ?? req.signal.reason ?? new DOMException("client disconnected", "AbortError"),
    };
  }
  if (!recovered) return { kind: "skipped" };

  markBodyNonPersistable(parsed._rawBody);
  try {
    const reparsed = parseRequest(parsed._rawBody);
    return { kind: "recovered", parsed: { ...parsed, context: reparsed.context, _rawBody: reparsed._rawBody } };
  } catch {
    return { kind: "skipped" };
  }
}

import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { isNonReplayableResponse, isTransientUpstreamStatus } from "../lib/upstream-retry";
import { markBodyNonPersistable } from "../responses/state";
import { parseRequest } from "../responses/parser";
import { agentTaskRecoveryConfig, recoverEncryptedAgentTask } from "../server/responses/agent-task-recovery";
import { hasStrictBackendEncryptedAgentTask } from "../server/responses/encrypted-payload";

interface NativeEncryptedTaskRecoveryInput<TFailure> {
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
  replay: (parsed: OcxParsedRequest) => Promise<Response | { failed: TFailure }>;
  restore: (response: Response) => Response;
}

type NativeEncryptedTaskRecoveryResult<TFailure> =
  | { kind: "skipped" }
  | { kind: "aborted"; reason: unknown }
  | { kind: "failed"; response: TFailure }
  | { kind: "replayed"; response: Response };

export async function maybeRecoverNativeEncryptedAgentTask<TFailure>({
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
  replay,
  restore,
}: NativeEncryptedTaskRecoveryInput<TFailure>): Promise<NativeEncryptedTaskRecoveryResult<TFailure>> {
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
    const retried = await replay({ ...parsed, context: reparsed.context, _rawBody: reparsed._rawBody });
    if ("failed" in retried) {
      return abortSignal?.aborted || req.signal.aborted
        ? { kind: "failed", response: retried.failed }
        : { kind: "skipped" };
    }
    return { kind: "replayed", response: restore(retried) };
  } catch {
    return { kind: "skipped" };
  }
}

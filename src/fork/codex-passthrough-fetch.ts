import type { OcxProviderConfig } from "../types";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers-destination";
import { providerFetch, type ProviderFetchOptions } from "../server/responses/fetch-helpers";
import type { BunRuntimeGateInput } from "../server/responses/ws-upstream";
import { markCodexPreDispatchFailure } from "./codex-passthrough-local-errors";

export function codexPassthroughProviderFetch(
  provider: OcxProviderConfig,
  runtime: BunRuntimeGateInput | undefined,
  options: ProviderFetchOptions,
) {
  const permissions = isCanonicalOpenAiForwardProvider(provider) ? options.codexPassthroughPermissions : undefined;
  return providerFetch(provider, runtime, {
    ...options,
    codexPassthroughPermissions: permissions,
    onHttpBeforeDispatchFailure: permissions ? markCodexPreDispatchFailure : undefined,
  });
}

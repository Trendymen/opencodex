import { isXaiResponsesDestination } from "../providers/xai-transport";
import {
  isOpenAiOperatedResponsesDestination,
  isThirdPartyNonGptResponsesRoute,
} from "../providers/openai-tiers-destination";
import type { OcxProviderConfig } from "../types";

export type AgentMessageConversionPhase = "early" | "late";

export type AgentMessageConversionOptions = Readonly<{
  allowStringContent: boolean;
}>;

function isOpenCodeGoBaseUrl(baseUrl: string | undefined): boolean {
  try {
    const url = new URL(baseUrl ?? "");
    return url.origin === "https://opencode.ai" && url.pathname.replace(/\/+$/, "") === "/zen/go/v1";
  } catch {
    return false;
  }
}

/** 两次 adapter 处理共用同一消息转换策略，避免后置处理覆盖 preserve。 */
export function agentMessageConversionOptions(args: {
  provider: OcxProviderConfig;
  resolvedModelId: string;
  phase: AgentMessageConversionPhase;
}): AgentMessageConversionOptions | undefined {
  const { provider, resolvedModelId, phase } = args;
  if (provider.adapter !== "openai-responses" || isOpenAiOperatedResponsesDestination(provider)) return undefined;

  const format = provider.agentMessageFormat;
  if (format === "preserve") return undefined;
  if (format === "user_message") return { allowStringContent: true };

  const forward = provider.authMode === "forward";
  const thirdPartyNonGptRoute = isThirdPartyNonGptResponsesRoute(provider, resolvedModelId);
  if (phase === "early") {
    if (!forward && isOpenCodeGoBaseUrl(provider.baseUrl)) return { allowStringContent: false };
    if (!forward && isXaiResponsesDestination(provider) && thirdPartyNonGptRoute) {
      return { allowStringContent: true };
    }
    return undefined;
  }

  return thirdPartyNonGptRoute ? { allowStringContent: false } : undefined;
}

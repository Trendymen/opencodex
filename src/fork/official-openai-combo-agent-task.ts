import { targetKey } from "../combos/identifiers";
import type { NormalizedComboTarget } from "../combos/types";
import { isCanonicalOpenAiForwardProvider, isOfficialOpenAiKeyResponsesDestination } from "../providers/openai-tiers-destination";
import { captureOpenAiVirtualWirePolicy, resolveOpenAiVirtualModel } from "../providers/openai-virtual-models";
import type { InboundWire } from "../providers/registry";
import { routedProviderConfig } from "../providers/routed-config";
import { routeConcreteModel, type RouteResult } from "../router";
import { resolveWireProtocolOverride } from "../server/adapter-resolve";
import type { OcxConfig } from "../types";

export function isOfficialOpenAiComboAgentTaskRoute(route: RouteResult, inboundWire: InboundWire): boolean {
  if (route.combo || inboundWire !== "responses") return false;
  const virtual = resolveOpenAiVirtualModel(route.providerName, route.modelId);
  const wireRoute = virtual ? { ...route, modelId: virtual.wireModelId } : route;
  if (virtual) captureOpenAiVirtualWirePolicy(wireRoute, virtual, inboundWire);
  const provider = resolveWireProtocolOverride(
    wireRoute.providerName, wireRoute.modelId, wireRoute.provider, inboundWire, wireRoute.staticPolicy,
  );
  return isOfficialOpenAiKeyResponsesDestination(provider);
}

export function officialOpenAiComboAgentTaskFallbackTargets(
  config: OcxConfig,
  targets: readonly NormalizedComboTarget[],
  inboundWire: InboundWire,
): ReadonlySet<string> {
  const fallbackTargets = new Set<string>();
  if (inboundWire !== "responses") return fallbackTargets;

  let seenSubscription = false;
  for (const target of targets) {
    const configured = config.providers[target.provider];
    if (!configured) continue;
    try {
      const route = configured.disabled === true ? undefined
        : routeConcreteModel(config, `${target.provider}/${target.model}`);
      // A disabled subscription still defines the configured order. It cannot be routed, so
      // classify its provider with the same registry defaults the live router would apply.
      if (isCanonicalOpenAiForwardProvider(route?.provider ?? routedProviderConfig(target.provider, configured))) {
        seenSubscription = true;
        fallbackTargets.clear();
      } else if (seenSubscription && route && isOfficialOpenAiComboAgentTaskRoute(route, inboundWire)) {
        fallbackTargets.add(targetKey(target));
      }
    } catch { /* The target is ineligible if it cannot resolve. */ }
  }
  return fallbackTargets;
}

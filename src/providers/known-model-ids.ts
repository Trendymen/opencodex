import type { OcxProviderConfig } from "../types";
import { getProviderRegistryEntry } from "./registry";
import { registryModelIdKeys } from "./registry/model-ids";
import { providerMatchesRegistryTransportWithStaticGuards } from "./static-model-discovery";

/**
 * Static native model ids shared by config admission and runtime routing.
 * Live-cache and custom-row ids are intentionally added by the router at runtime.
 */
export function knownStaticModelIdsForProvider(
  name: string,
  provider: OcxProviderConfig,
): string[] {
  const ids = new Set<string>();
  if (Array.isArray(provider.models)) {
    for (const id of provider.models) if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  if (typeof provider.defaultModel === "string" && provider.defaultModel.length > 0) {
    ids.add(provider.defaultModel);
  }
  const registry = providerMatchesRegistryTransportWithStaticGuards(name, provider)
    ? getProviderRegistryEntry(name)
    : undefined;
  for (const id of registry?.models ?? []) ids.add(id);
  for (const id of registry ? registryModelIdKeys(registry) : []) ids.add(id);
  return [...ids];
}

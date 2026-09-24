import {
  hasOwnProvider,
  isValidProviderName,
  saveConfigPreservingClaudeCode,
} from "../../config";
import {
  DEFAULT_PROVIDER_CONTEXT_CAP,
  globalContextCapValue,
  providerContextCap,
  providerContextCaps,
  selectedProviderContextCaps,
  setAllProviderContextCaps,
  setGlobalContextCapValue,
  setProviderContextCap,
} from "../../providers/context-cap";
import { clearModelCache } from "../../codex/model-cache";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { isPlainRecord } from "./shared";

export async function handleProviderContextCapRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, convergeCodexCatalog } = ctx;
  if (url.pathname === "/api/provider-context-caps" && req.method === "GET") {
    return jsonResponse({
      cap: DEFAULT_PROVIDER_CONTEXT_CAP,
      value: globalContextCapValue(config),
      caps: providerContextCaps(config),
      values: selectedProviderContextCaps(config),
    });
  }

  if (url.pathname !== "/api/provider-context-caps" || req.method !== "PUT") return null;

  let rawBody: unknown;
  try {
    rawBody = await readManagementJsonBody(req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  if (!isPlainRecord(rawBody)) {
    return jsonResponse({ error: "provider-context-caps body must be a plain object" }, 400);
  }
  const body = rawBody as { provider?: unknown; enabled?: unknown; value?: unknown; setAll?: unknown };
  const respond = (catalogRefresh: Awaited<ReturnType<typeof convergeCodexCatalog>>) => jsonResponse({
    ok: true,
    cap: DEFAULT_PROVIDER_CONTEXT_CAP,
    value: globalContextCapValue(config),
    caps: providerContextCaps(config),
    values: selectedProviderContextCaps(config),
    catalogRefresh,
  });

  const hasProviderFields = Object.hasOwn(body, "provider") || Object.hasOwn(body, "enabled");
  if (hasProviderFields) {
    if (typeof body.provider !== "string" || typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "provider and enabled are required together" }, 400);
    }
    if (Object.hasOwn(body, "setAll")) {
      return jsonResponse({ error: "setAll cannot be combined with provider updates" }, 400);
    }
  }

  if (typeof body.provider === "string" && typeof body.enabled === "boolean") {
    const provider = body.provider.trim();
    if (!isValidProviderName(provider)) {
      return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
    }
    if (!hasOwnProvider(config.providers, provider)) return jsonResponse({ error: "unknown provider" }, 404);
    if (body.value !== undefined && (typeof body.value !== "number" || !Number.isFinite(body.value))) {
      return jsonResponse({ error: "value must be a positive number" }, 400);
    }
    const perProviderValue = typeof body.value === "number" ? Math.floor(body.value) : undefined;
    if (perProviderValue !== undefined && perProviderValue < 1) {
      return jsonResponse({ error: "value must be a positive number" }, 400);
    }
    setProviderContextCap(config, provider, body.enabled, perProviderValue);
    saveConfigPreservingClaudeCode(config);
    reconcileLiveStateStores();
    clearModelCache(provider);
    return respond(await convergeCodexCatalog());
  }

  if (body.value !== undefined) {
    if (typeof body.value !== "number" || !Number.isFinite(body.value)) {
      return jsonResponse({ error: "value must be a positive number" }, 400);
    }
    const normalizedValue = Math.floor(body.value);
    if (normalizedValue < 1) return jsonResponse({ error: "value must be a positive number" }, 400);
    if (body.setAll !== undefined && typeof body.setAll !== "boolean") {
      return jsonResponse({ error: "setAll must be a boolean" }, 400);
    }
    const affected = Object.keys(providerContextCaps(config));
    const applyToAll = body.setAll === true;
    setGlobalContextCapValue(config, normalizedValue, applyToAll);
    saveConfigPreservingClaudeCode(config);
    reconcileLiveStateStores();
    if (applyToAll) for (const provider of affected) clearModelCache(provider);
    return respond(await convergeCodexCatalog());
  }

  if (body.setAll !== undefined) {
    if (typeof body.setAll !== "boolean") return jsonResponse({ error: "setAll must be a boolean" }, 400);
    const before = Object.keys(providerContextCaps(config));
    const names = Object.keys(config.providers);
    setAllProviderContextCaps(config, names, body.setAll);
    saveConfigPreservingClaudeCode(config);
    reconcileLiveStateStores();
    for (const provider of new Set([...before, ...names])) clearModelCache(provider);
    return respond(await convergeCodexCatalog());
  }

  return jsonResponse({ error: "provider string and enabled boolean are required" }, 400);
}

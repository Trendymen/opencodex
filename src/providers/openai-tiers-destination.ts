import { openaiResponsesUrl } from "../adapters/openai-responses-url";
import { isOpenAiGptFamilyModel } from "./openai-model-identity";

export interface OpenAiDestinationShape {
  readonly adapter?: string;
  readonly authMode?: string;
  readonly baseUrl?: string;
  readonly responsesPath?: string;
}

export const OPENAI_CODEX_PROVIDER_ID = "openai";
export const LEGACY_OPENAI_MULTI_PROVIDER_ID = "openai-multi";
export const OPENAI_API_PROVIDER_ID = "openai-apikey";
export const LEGACY_CHATGPT_PROVIDER_ID = "chatgpt";

export const CODEX_FORWARD_BASE_URL = "https://chatgpt.com/backend-api/codex";

export function normalizedOpenAiBaseUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

export function isCanonicalOpenAiForwardProvider<T extends OpenAiDestinationShape>(provider: T): boolean {
  return provider.adapter === "openai-responses"
    && provider.authMode === "forward"
    && normalizedOpenAiBaseUrl(provider.baseUrl) === CODEX_FORWARD_BASE_URL;
}

const OPENAI_API_ORIGIN = "https://api.openai.com";
const OPENAI_API_BASE_URL = `${OPENAI_API_ORIGIN}/v1`;
const OPENAI_API_RESPONSES_URL = `${OPENAI_API_BASE_URL}/responses`;

/**
 * The Responses endpoint the adapter would actually POST key-auth traffic to, normalized.
 *
 * Mirrors the adapter's own construction (`src/adapters/openai-responses.ts`): a configured
 * `responsesPath` is appended to the base verbatim, and only the default branch runs the
 * `/v1/responses` suffix normalization. Classifying on the base URL alone would call
 * `baseUrl: "https://api.openai.com"` with `responsesPath: "/other"` official even though that
 * request never reaches the official Responses endpoint.
 */
function resolvedResponsesEndpoint(provider: OpenAiDestinationShape): string | undefined {
  if (typeof provider.baseUrl !== "string") return undefined;
  try {
    const raw = provider.responsesPath === undefined
      ? openaiResponsesUrl(provider.baseUrl)
      : `${provider.baseUrl.replace(/\/$/, "")}${provider.responsesPath}`;
    return normalizedOpenAiBaseUrl(raw);
  } catch {
    return undefined;
  }
}

function isOfficialOpenAiResponsesDestination(provider: OpenAiDestinationShape): boolean {
  // Exact normalized URL keeps lookalike/suffix hosts out of this set: `api.openai.com.evil.test`
  // resolves to its own origin, never to the official one.
  return resolvedResponsesEndpoint(provider) === OPENAI_API_RESPONSES_URL;
}

export function isOfficialOpenAiApiBaseUrl(baseUrl: string | undefined): boolean {
  return normalizedOpenAiBaseUrl(baseUrl) === OPENAI_API_BASE_URL;
}

export function isRawOfficialOpenAiApiBaseUrl(baseUrl: string | undefined): boolean {
  return typeof baseUrl === "string"
    && baseUrl.replace(/\/+$/, "") === OPENAI_API_BASE_URL;
}

export function isOfficialOpenAiApiHost(baseUrl: string | undefined): boolean {
  try {
    return new URL(baseUrl ?? "").hostname === "api.openai.com";
  } catch {
    return false;
  }
}

export function isOpenAiOrChatGptHost(baseUrl: string | undefined): boolean {
  try {
    const hostname = new URL(baseUrl ?? "").hostname.toLowerCase();
    return hostname === "openai.com"
      || hostname.endsWith(".openai.com")
      || hostname === "chatgpt.com"
      || hostname.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
}

/**
 * Whether this provider can serve `POST /responses/compact`. The canonical ChatGPT
 * backend can, and so can the official OpenAI API — but an arbitrary gateway that
 * merely speaks the Responses wire cannot, and calling it there fails compaction
 * with an unhelpful error instead of falling back to a routed summary (#422).
 */
export function supportsNativeResponsesCompactEndpoint<T extends OpenAiDestinationShape>(
  providerName: string,
  provider: T,
): boolean {
  if (isCanonicalOpenAiForwardProvider(provider)) return true;
  return providerName === OPENAI_API_PROVIDER_ID
    && provider.adapter === "openai-responses"
    && isOfficialOpenAiApiBaseUrl(provider.baseUrl);
}

/**
 * Whether this destination is an OpenAI-operated Responses backend — the canonical ChatGPT Codex
 * surface or the official OpenAI API.
 *
 * Deliberately not keyed on `authMode === "forward"`: a noncanonical forward provider does not
 * receive the caller's credentials (see the forward-header gate in the Responses adapter), so
 * forward auth says nothing about which backend is on the other end.
 */
export function isOpenAiOperatedResponsesDestination<T extends OpenAiDestinationShape>(provider: T): boolean {
  if (isCanonicalOpenAiForwardProvider(provider)) return true;
  return provider.adapter === "openai-responses"
    && isOfficialOpenAiResponsesDestination(provider);
}

/**
 * Whether this destination can decode a native (non-`ocx1:`) compaction blob.
 *
 * Only the backend that minted a blob can decode it. `authMode: "forward"` alone is not a signal:
 * the adapter forwards caller credentials only to the canonical ChatGPT Codex surface, while a
 * noncanonical forward provider receives no caller credentials and may point at any backend.
 *
 * Relay only to an OpenAI-operated destination or a destination whose operator explicitly opts in.
 * Keyed by destination rather than provider id: a blob's issuer is the URL that produced it, not the
 * local config key a replay travels under.
 */
export function destinationDecodesNativeCompactionBlob<T extends OpenAiDestinationShape & { readonly decodesNativeCompactionBlobs?: boolean }>(provider: T): boolean {
  return isOpenAiOperatedResponsesDestination(provider)
    || provider.decodesNativeCompactionBlobs === true;
}

export function isThirdPartyNonGptResponsesRoute<T extends OpenAiDestinationShape>(
  provider: T,
  resolvedModelId: string,
): boolean {
  return provider.adapter === "openai-responses"
    && !isOpenAiOperatedResponsesDestination(provider)
    && !isOpenAiGptFamilyModel(resolvedModelId);
}

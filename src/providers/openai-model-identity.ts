function normalizedModelId(modelId: string): string {
  return typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
}

/** Legacy bare native-alias shape; consumers requiring case-insensitivity derive from it. */
export const NATIVE_OPENAI_FAMILY_PATTERN = /^(?:gpt-|o1-|o3-|o4-|codex-)/;
const RESERVED_NATIVE_OPENAI_ALIAS_PATTERN = new RegExp(NATIVE_OPENAI_FAMILY_PATTERN.source, "i");

export function isOpenAiGptFamilyModel(modelId: string): boolean {
  const normalized = normalizedModelId(modelId);
  const slug = normalized.startsWith("openai/") ? normalized.slice("openai/".length) : normalized;
  if (slug.includes("/")) return false;
  return /^(?:gpt|chatgpt|codex|o1|o3|o4)(?:[-_.]|$)/.test(slug)
    || /^openai-gpt-/.test(slug);
}

export function isBareOpenAiGptOrReasoningSlug(modelId: string): boolean {
  return !modelId.includes("/") && /^(?:gpt-|o1-|o3-|o4-)/.test(modelId);
}

export function isImplicitNativeOpenAiRouteModel(modelId: string): boolean {
  return isBareOpenAiGptOrReasoningSlug(modelId) || modelId === "codex-auto-review";
}

export function isReservedNativeOpenAiAlias(modelId: string): boolean {
  return RESERVED_NATIVE_OPENAI_ALIAS_PATTERN.test(modelId);
}

export function isOpenAiNativeCleanupCandidate(modelId: string): boolean {
  return !modelId.includes("/") && /^(?:gpt-|codex-)/.test(modelId);
}

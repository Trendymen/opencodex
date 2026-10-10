import { describe, expect, test } from "bun:test";
import {
  isBareOpenAiGptOrReasoningSlug,
  isImplicitNativeOpenAiRouteModel,
  isOpenAiGptFamilyModel,
  isOpenAiNativeCleanupCandidate,
  isReservedNativeOpenAiAlias,
} from "../../src/providers/openai-model-identity";

describe("OpenAI model identity", () => {
  test.each(["gpt-5.6-sol", "gpt", "gpt_5", "gpt.5", "chatgpt", "codex", "openai/gpt-oss-120b", "openai-gpt-5.6-luna", "o1", "o3", "o4", "o3-mini", "o4-mini", " CHATGPT-4O ", " OPENAI/GPT-5 "])("recognizes family %s", modelId => {
    expect(isOpenAiGptFamilyModel(modelId)).toBe(true);
  });

  test.each(["", "   ", "glm-5.3", "my-gpt-helper", "gptish", "o10", "openai-compatible-glm", "other/gpt-5.6", "openai/other/gpt-5.6", "gpt-model/other"])("does not recognize family %s", modelId => {
    expect(isOpenAiGptFamilyModel(modelId)).toBe(false);
  });

  test("keeps family, aliases, native routing, and cleanup shapes separate", () => {
    expect(isReservedNativeOpenAiAlias("GPT-custom")).toBe(true);
    expect(isReservedNativeOpenAiAlias(" GPT-custom")).toBe(false);
    expect(isImplicitNativeOpenAiRouteModel("GPT-custom")).toBe(false);
    expect(isImplicitNativeOpenAiRouteModel("codex-auto-review")).toBe(true);
    expect(isImplicitNativeOpenAiRouteModel("codex-custom")).toBe(false);
    expect(isImplicitNativeOpenAiRouteModel("openai/gpt-5.6")).toBe(false);
    expect(isBareOpenAiGptOrReasoningSlug("gpt-5.6")).toBe(true);
    expect(isBareOpenAiGptOrReasoningSlug("GPT-5.6")).toBe(false);
    expect(isOpenAiNativeCleanupCandidate("codex-custom")).toBe(true);
    expect(isOpenAiNativeCleanupCandidate("o3-mini")).toBe(false);
  });
});

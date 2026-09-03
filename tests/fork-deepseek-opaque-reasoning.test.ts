/**
 * Issue #875 (local half): DeepSeek's Responses API accepts plaintext reasoning
 * replay (its compatibility guide merges reasoning items into the adjacent
 * assistant message), but the passthrough serializer blanked reasoning `content`
 * for EVERY provider — a rule only the ChatGPT native backend needs. Providers
 * flagged `preserveResponsesReasoningContent` now keep valid replay content while
 * still stripping proxy-minted `ocxr1` envelopes no upstream can decrypt.
 */
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction, sanitizeReasoningInputContent } from "../src/adapters/openai-responses";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { OCX_REASONING_PREFIX } from "../src/responses/reasoning-envelope";
import type { OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const reasoningItem = (extra: Record<string, unknown> = {}) => ({
  type: "reasoning",
  id: "rs_1",
  content: [{ type: "reasoning_text", text: "think step by step" }],
  ...extra,
});

function inputOf(result: unknown): Record<string, unknown>[] {
  return (result as { input: Record<string, unknown>[] }).input;
}

describe("fork deepseek opaque reasoning replay", () => {
test("native GPT replay drops a raw third-party opaque reasoning blob but retains its own summary blob", () => {
  const out = inputOf(sanitizeReasoningInputContent({
    model: "gpt-5.6-terra",
    input: [
      reasoningItem({ id: "rs_deepseek", encrypted_content: "third-party-opaque-state" }),
      { type: "reasoning", id: "rs_openai", summary: [], encrypted_content: "gAAAA-openai-issued-state" },
    ],
  }, { stripRawContentBackedEncryptedContent: true }));

  expect(out).toEqual([
    { type: "reasoning", id: "rs_deepseek", content: [] },
    { type: "reasoning", id: "rs_openai", summary: [], encrypted_content: "gAAAA-openai-issued-state" },
  ]);

});
  test("a canonical OpenAI continuation removes an interrupted DeepSeek opaque reasoning token", () => {
      const provider = { ...providerConfigSeed(getProviderRegistryEntry("openai-apikey")!), apiKey: "sk-test" };
      const built = createResponsesPassthroughAdapter(provider).buildRequest({
        modelId: "gpt-5.6-terra",
        context: { messages: [] },
        stream: true,
        options: {},
        _rawBody: {
          model: "gpt-5.6-terra",
          input: [
            reasoningItem({ id: "rs_interrupted_deepseek", encrypted_content: "deepseek-opaque-token" }),
            { type: "reasoning", id: "rs_prior_gpt", summary: [], encrypted_content: "gAAAA-openai-issued-state" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
          ],
        },
      } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], { headers: new Headers() });
      const body = JSON.parse(String(built.body)) as { input: Record<string, unknown>[] };

      expect(body.input).toEqual([
        { type: "reasoning", id: "rs_interrupted_deepseek", content: [] },
        { type: "reasoning", id: "rs_prior_gpt", summary: [], encrypted_content: "gAAAA-openai-issued-state" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ]);
  });

});

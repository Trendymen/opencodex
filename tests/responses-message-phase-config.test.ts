import { expect, test } from "bun:test";
import { getDefaultConfig, validateConfigCandidate } from "../src/config";

test("normalizes provider message-phase inference model ids", () => {
  const result = validateConfigCandidate({
    ...getDefaultConfig(),
    defaultProvider: "phase",
    providers: {
      phase: {
        adapter: "openai-responses",
        baseUrl: "https://example.test/v1",
        inferResponsesMessagePhaseModels: [" glm-5.3 ", "glm-5.3", "kimi-k3"],
      },
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect((result.config.providers.phase as { inferResponsesMessagePhaseModels?: string[] })
    .inferResponsesMessagePhaseModels).toEqual(["glm-5.3", "kimi-k3"]);
});

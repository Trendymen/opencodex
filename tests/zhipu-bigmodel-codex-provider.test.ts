import { expect, test } from "bun:test";
import { extractProviderModelItems, resolveProviderModelDiscovery } from "../src/providers/model-discovery";

test("BigModel Codex discovery maps the official models-slug catalog", () => {
  const discovery = resolveProviderModelDiscovery("zhipu-bigmodel-codex", {
    adapter: "openai-responses",
    baseUrl: "https://open.bigmodel.cn/api/v1",
    authMode: "key",
  });

  expect(extractProviderModelItems({
    models: [
      { slug: "glm-5.3", display_name: "glm-5.3" },
      { slug: "glm-5.3-flash", display_name: "glm-5.3-flash" },
    ],
  }, discovery)).toEqual({
    ok: true,
    rawCount: 2,
    items: [
      { id: "glm-5.3", slug: "glm-5.3", display_name: "glm-5.3" },
      { id: "glm-5.3-flash", slug: "glm-5.3-flash", display_name: "glm-5.3-flash" },
    ],
  });
});

test("BigModel Codex discovery retains an official catalog larger than 64 models", () => {
  const discovery = resolveProviderModelDiscovery("zhipu-bigmodel-codex", {
    adapter: "openai-responses",
    baseUrl: "https://open.bigmodel.cn/api/v1",
    authMode: "key",
  });
  const models = Array.from({ length: 65 }, (_, index) => ({ slug: `glm-test-${index}` }));

  const result = extractProviderModelItems({ models }, discovery);
  expect(result).toMatchObject({ ok: true, rawCount: 65 });
});

test("BigModel Codex slug discovery is limited to its exact provider transport", () => {
  const matching = resolveProviderModelDiscovery("zhipu-bigmodel-codex", {
    adapter: "openai-responses",
    baseUrl: "https://open.bigmodel.cn/api/v1/",
    authMode: "key",
  });
  expect(extractProviderModelItems({ models: [{ slug: "glm-5.3" }] }, matching))
    .toMatchObject({ ok: true, items: [{ id: "glm-5.3" }] });

  for (const provider of [
    { name: "other", adapter: "openai-responses", baseUrl: "https://open.bigmodel.cn/api/v1" },
    { name: "zhipu-bigmodel-codex", adapter: "openai-chat", baseUrl: "https://open.bigmodel.cn/api/v1" },
    { name: "zhipu-bigmodel-codex", adapter: "openai-responses", baseUrl: "https://open.bigmodel.cn/api/v2" },
  ]) {
    const discovery = resolveProviderModelDiscovery(provider.name, { ...provider, authMode: "key" });
    expect(extractProviderModelItems({ models: [{ slug: "glm-5.3" }] }, discovery))
      .toEqual({ ok: false, reason: "invalid_shape" });
    expect(extractProviderModelItems({ data: [{ id: "still-openai" }] }, discovery))
      .toMatchObject({ ok: true, items: [{ id: "still-openai" }] });
  }
});

import { expect, test } from "bun:test";
import { providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routedProviderConfig } from "../../src/router";
import { isModelVisionSidecarConsumer } from "../../src/vision/eligibility";

  test("DeepSeek V4 Flash keeps its images instead of handing them to the vision sidecar", () => {
    const entry = PROVIDER_REGISTRY.find(row => row.id === "deepseek");
    expect(entry).toBeDefined();
    // Assert the MERGED route provider, not the seed: routedProviderConfig unions the registry
    // list with the saved one, so an install whose config still names `deepseek-v4-flash` stays
    // sidecar-covered until that stale entry is removed.
    const merged = routedProviderConfig("deepseek", providerConfigSeed(entry!));
    expect(merged.modelInputModalities?.["deepseek-v4-flash"]).toEqual(["text", "image"]);
    expect(isModelVisionSidecarConsumer(merged, "deepseek-v4-flash")).toBe(false);
    expect(isModelVisionSidecarConsumer(merged, "deepseek-chat")).toBe(true);
  });

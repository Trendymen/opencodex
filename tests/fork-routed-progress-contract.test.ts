import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_GPT5_IDENTITY_LINE, identifyRoutedModel } from "../src/adapters/identity";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import {
  buildCatalogEntries,
  deriveComboCatalogModel,
  gatherRoutedModels,
} from "../src/codex/catalog";
import {
  appendRoutedProgressContract,
  neutralizeRoutedChannelInstructions,
  ROUTED_PROGRESS_CONTRACT,
} from "../src/fork/routed-progress-contract";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";
import type { OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const PROGRESS_SENTENCE = "ordinary assistant text message before the first tool call";

function routedProvider(): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: "https://open.bigmodel.cn/api/v1",
    authMode: "key",
    apiKey: "test-key",
  } as OcxProviderConfig;
}

const TOOL = {
  type: "function",
  name: "inspect_repository",
  description: "Inspect repository state.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

function buildResponsesBody(
  provider: OcxProviderConfig,
  instructions: unknown,
  options: { toolPlacement?: "top" | "additional" | "none"; compaction?: boolean } = {},
): Record<string, unknown> {
  const toolPlacement = options.toolPlacement ?? "top";
  const input: unknown[] = [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Inspect the repository with tools." }],
  }];
  if (toolPlacement === "additional") {
    input.push({ type: "additional_tools", role: "developer", tools: [TOOL] });
  }
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
  const request = adapter.buildRequest({
    modelId: "glm-5.3-flash",
    context: { messages: [] },
    stream: true,
    options: {},
    ...(options.compaction ? { _compactionRequest: true } : {}),
    _rawBody: {
      model: "glm-5.3-flash",
      ...(instructions === undefined ? {} : { instructions }),
      input,
      ...(toolPlacement === "top" ? { tools: [TOOL] } : {}),
      stream: true,
    },
  }, { headers: new Headers({ "thread-id": "thread-progress-contract" }) });
  return JSON.parse(request.body) as Record<string, unknown>;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function buildTranslatedSystemText(systemPrompt?: string): string {
  const adapter = withTestTranslatorBudget(createOpenAIChatAdapter({
    adapter: "openai-chat",
    baseUrl: "https://provider.example/v1",
    apiKey: "test-key",
  } as OcxProviderConfig));
  const request = adapter.buildRequest({
    modelId: "glm-5.3-flash",
    context: {
      systemPrompt: [systemPrompt
        ?? `${CODEX_GPT5_IDENTITY_LINE}\n\nKeep existing operator instructions intact.`],
      messages: [{ role: "user", content: "Inspect the repository with tools." }],
      tools: [{
        name: "inspect_repository",
        description: "Inspect repository state.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
    },
    stream: false,
    options: {},
  } as never);
  const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: string }> };
  return body.messages.find(message => message.role === "system")?.content ?? "";
}

let previousOpenCodexHome: string | undefined;
let testDir = "";

beforeEach(() => {
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-routed-progress-"));
  process.env.OPENCODEX_HOME = testDir;
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
});

afterEach(() => {
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("fork routed progress contract", () => {
  test("routed prompt cleanup removes GPT-only channel instructions before adding progress guidance", () => {
    const gptChannels = [
      "You have two channels for staying in conversation with the user:",
      "- You share updates in the `commentary` channel.",
      "- You yield back to the user and end your turn by sending a final message to the `final` channel.",
      "",
      "## Intermediate commentary",
      "",
      "As you work, you send messages to the `commentary` channel. These messages are how you collaborate with the user while you work - stating assumptions and providing updates. These messages should be concise and quickly scannable. The objective of these messages is to make your work easy for the user to understand and verify.",
      "",
      "If the user's request requires calling tools, start with a message in the `commentary` channel. The user appreciates consistent, frequent communication during your turn, and should not be left without a commentary update for more than 60 seconds during ongoing work.",
      "",
      "Do NOT put a final response (e.g. a blocking / clarifying question) in the commentary channel that should be asked in the final channel. Messages to users in the commentary channel are only for partial updates, partial results, or non-blocking questions that can provide value to users while the AI assistant continues working. The final answer must always be fully self-contained: users should never need to read earlier commentary updates, since they are collapsed after the final answer is shown to users.",
      "",
      "Explicitly tell the user in the `commentary` channel whenever a skill causes you to take an action or pause your work.",
      "- First, tell the user in the commentary channel **why** you are using the skill.",
    ].join("\n");
    const cleaned = neutralizeRoutedChannelInstructions(gptChannels);

    expect(cleaned).not.toMatch(/commentary|`final` channel|final channel/i);
    expect(cleaned).toContain("ordinary assistant text");
    expect(cleaned).toContain("## User-visible progress");
  });

  test("translated third-party system prompts require ordinary assistant progress", () => {
    const first = buildTranslatedSystemText();

    expect(first).toContain("Keep existing operator instructions intact.");
    expect(first).toContain(PROGRESS_SENTENCE);
    expect(first).toContain("new user message");
    expect(first).toContain("four consecutive tool-only responses");
    expect(first).not.toMatch(/commentary|final_answer|channel/i);
  });

  test("catalog-derived translated prompts keep exactly one complete progress contract", () => {
    const system = buildTranslatedSystemText(
      `${CODEX_GPT5_IDENTITY_LINE}\n\n${ROUTED_PROGRESS_CONTRACT}`,
    );

    expect(occurrences(system, ROUTED_PROGRESS_CONTRACT)).toBe(1);
  });

  test("progress contract composition is idempotent without changing identity-only repair", () => {
    const identityOnly = identifyRoutedModel(CODEX_GPT5_IDENTITY_LINE, "gpt-daybreak-blue-latest");
    const first = appendRoutedProgressContract(identityOnly);
    const second = appendRoutedProgressContract(first);

    expect(identityOnly).not.toContain(PROGRESS_SENTENCE);
    expect(occurrences(second, ROUTED_PROGRESS_CONTRACT)).toBe(1);
  });

  test("routed catalog metadata carries the neutral contract without restoring native model messages", () => {
    const template = {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Native GPT model",
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      base_instructions: `${CODEX_GPT5_IDENTITY_LINE}\n\nNative instructions.`,
      model_messages: { instructions_template: "Native-only model template." },
      supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
    };
    const rows = buildCatalogEntries(template, ["gpt-5.5"], [{
      provider: "zhipu-bigmodel-codex",
      id: "glm-5.3-flash",
    }]);
    const native = rows.find(row => row.slug === "gpt-5.5");
    const routed = rows.find(row => row.slug === "zhipu-bigmodel-codex/glm-5.3-flash");

    expect(native?.base_instructions).toBe(template.base_instructions);
    expect(native?.model_messages).toEqual(template.model_messages);
    expect(routed?.base_instructions).toContain(PROGRESS_SENTENCE);
    expect(routed?.base_instructions).not.toMatch(/commentary|final_answer|channel/i);
    expect(routed).not.toHaveProperty("model_messages");
  });

  test("template-less routed catalog metadata still carries the neutral contract", () => {
    const rows = buildCatalogEntries(null, [], [{
      provider: "deepseek",
      id: "deepseek-v4-flash",
    }]);
    const routed = rows.find(row => row.slug === "deepseek/deepseek-v4-flash");

    expect(routed?.base_instructions).toContain(PROGRESS_SENTENCE);
    expect(routed?.base_instructions).not.toMatch(/commentary|final_answer|channel/i);
  });

  test("official OpenAI and native capability-alias catalog rows do not receive the contract", () => {
    const template = {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      description: "Native GPT model",
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      base_instructions: `${CODEX_GPT5_IDENTITY_LINE}\n\nNative instructions.`,
      model_messages: { instructions_template: "Native-only model template." },
      supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
    };
    const rows = buildCatalogEntries(template, [], [
      { provider: "openai-apikey", id: "gpt-5.6-sol" },
      {
        provider: "openai",
        id: "gpt-daybreak-blue-latest",
        codexForwardNativeCapabilityAlias: true,
      },
    ]);
    const publicApi = rows.find(row => row.slug === "openai-apikey/gpt-5.6-sol");
    const capabilityAlias = rows.find(row => row.slug === "openai/gpt-daybreak-blue-latest");

    expect(publicApi).toBeDefined();
    expect(publicApi?.base_instructions).not.toContain(PROGRESS_SENTENCE);
    expect(capabilityAlias).toBeDefined();
    expect(capabilityAlias?.base_instructions).not.toContain(PROGRESS_SENTENCE);
  });

  test("catalog eligibility follows the actual destination instead of the provider id", async () => {
    const gathered = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://third-party.example/v1",
          authMode: "key",
          apiKey: "test-key",
          models: ["third-party-model"],
          liveModels: false,
        },
        "official-custom": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          apiKey: "test-key",
          models: ["official-model"],
          liveModels: false,
        },
      },
    } as never);
    const rows = buildCatalogEntries({
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Native GPT model",
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      base_instructions: `${CODEX_GPT5_IDENTITY_LINE}\n\nNative instructions.`,
      supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
    }, [], gathered);
    const thirdParty = rows.find(row => row.slug === "openai/third-party-model");
    const official = rows.find(row => row.slug === "official-custom/official-model");

    expect(thirdParty?.base_instructions).toContain(PROGRESS_SENTENCE);
    expect(official?.base_instructions).not.toContain(PROGRESS_SENTENCE);

    const canonicalGathered = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
      },
      customModels: [{
        id: "custom-canonical-row",
        provider: "openai",
        modelId: "custom-canonical-model",
        addedAt: "2026-08-30T00:00:00.000Z",
      }],
    } as never);
    const canonicalRows = buildCatalogEntries({
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Native GPT model",
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      base_instructions: `${CODEX_GPT5_IDENTITY_LINE}\n\nNative instructions.`,
      supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
    }, [], canonicalGathered);
    const omittedAuthCanonical = canonicalRows.find(
      row => row.slug === "openai/custom-canonical-model",
    );
    expect(omittedAuthCanonical?.base_instructions).not.toContain(PROGRESS_SENTENCE);
  });

  test("combo catalog guidance is enabled only when every possible member is third-party", () => {
    const member = (provider: string, id: string, eligible: boolean) => ({
      provider,
      id,
      contextWindow: 128_000,
      inputModalities: ["text"],
      reasoningEfforts: ["medium"],
      routedProgressContractEligible: eligible,
    });
    const combo = (targets: Array<{ provider: string; model: string; weight: number }>) => ({
      strategy: "failover",
      stickyLimit: 1,
      defaultEffort: null,
      imageInput: "auto",
      alias: null,
      nativeAlias: false,
      displayName: null,
      targets,
    });
    const officialA = member("official-a", "model-a", false);
    const officialB = member("official-b", "model-b", false);
    const thirdA = member("third-a", "model-a", true);
    const thirdB = member("third-b", "model-b", true);
    const allOfficial = deriveComboCatalogModel("all-official", combo([
      { provider: officialA.provider, model: officialA.id, weight: 1 },
      { provider: officialB.provider, model: officialB.id, weight: 1 },
    ]) as never, [officialA, officialB]);
    const mixed = deriveComboCatalogModel("mixed", combo([
      { provider: officialA.provider, model: officialA.id, weight: 1 },
      { provider: thirdB.provider, model: thirdB.id, weight: 1 },
    ]) as never, [officialA, thirdB]);
    const allThirdParty = deriveComboCatalogModel("all-third-party", combo([
      { provider: thirdA.provider, model: thirdA.id, weight: 1 },
      { provider: thirdB.provider, model: thirdB.id, weight: 1 },
    ]) as never, [thirdA, thirdB]);

    expect(allOfficial?.routedProgressContractEligible).toBeUndefined();
    expect(mixed?.routedProgressContractEligible).toBeUndefined();
    expect(allThirdParty?.routedProgressContractEligible).toBe(true);
  });

  test("third-party Responses wire instructions receive the contract idempotently", () => {
    const first = buildResponsesBody(routedProvider(), "Existing caller instructions.");
    const firstInstructions = first.instructions;
    expect(typeof firstInstructions).toBe("string");
    expect(firstInstructions).toContain("Existing caller instructions.");
    expect(firstInstructions).toContain(PROGRESS_SENTENCE);
    expect(firstInstructions).not.toMatch(/commentary|final_answer|channel/i);

    const second = buildResponsesBody(routedProvider(), firstInstructions as string);
    expect(occurrences(second.instructions as string, ROUTED_PROGRESS_CONTRACT)).toBe(1);
  });

  test("partial prose does not spoof a complete delivered progress contract", () => {
    const body = buildResponsesBody(
      routedProvider(),
      `The caller quoted: ${PROGRESS_SENTENCE}.`,
    );

    expect(body.instructions).toContain("meaningful milestones");
    expect(occurrences(body.instructions as string, ROUTED_PROGRESS_CONTRACT)).toBe(1);
  });

  test("Responses exclusions and Responses Lite tools preserve their exact boundaries", () => {
    const missing = buildResponsesBody(routedProvider(), undefined);
    const nonString = buildResponsesBody(routedProvider(), [{ type: "message", role: "developer" }]);
    const noTools = buildResponsesBody(routedProvider(), "No tools.", { toolPlacement: "none" });
    const compact = buildResponsesBody(routedProvider(), "Compaction.", { compaction: true });
    const lite = buildResponsesBody(routedProvider(), "Responses Lite.", { toolPlacement: "additional" });

    expect(missing).not.toHaveProperty("instructions");
    expect(nonString.instructions).toEqual([{ type: "message", role: "developer" }]);
    expect(noTools.instructions).toBe("No tools.");
    expect(JSON.stringify(compact)).not.toContain(PROGRESS_SENTENCE);
    expect(lite.instructions).toContain(PROGRESS_SENTENCE);
  });

  test("Cursor tool requests receive one contract after the effective tool budget", () => {
    const request = createCursorRequest({
      modelId: "cursor/auto",
      context: {
        systemPrompt: ["Cursor caller instructions."],
        messages: [{ role: "user", content: "Inspect the repository with tools." }],
        tools: [{
          name: TOOL.name,
          description: TOOL.description,
          parameters: TOOL.parameters,
        }],
      },
      stream: false,
      options: {},
    } as never);
    const replay = createCursorRequest({
      modelId: "cursor/auto",
      context: {
        systemPrompt: ["Cursor caller instructions.", ROUTED_PROGRESS_CONTRACT],
        messages: [{ role: "user", content: "Inspect the repository with tools." }],
        tools: [{
          name: TOOL.name,
          description: TOOL.description,
          parameters: TOOL.parameters,
        }],
      },
      stream: false,
      options: {},
    } as never);

    expect(occurrences(request.system.join("\n\n"), ROUTED_PROGRESS_CONTRACT)).toBe(1);
    expect(occurrences(replay.system.join("\n\n"), ROUTED_PROGRESS_CONTRACT)).toBe(1);
  });

  test("canonical ChatGPT Responses forwarding remains byte-for-byte prompt native", () => {
    const body = buildResponsesBody({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    } as OcxProviderConfig, "Native caller instructions.");

    expect(body.instructions).toBe("Native caller instructions.");
  });

  test("public OpenAI Responses forwarding remains byte-for-byte prompt native", () => {
    const body = buildResponsesBody({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
      apiKey: "test-key",
    } as OcxProviderConfig, "Native API instructions.");

    expect(body.instructions).toBe("Native API instructions.");
  });

  test("provider debug proves the routed contract reached wire instructions without logging it", () => {
    setDebugSettings({ debug: true });
    const body = buildResponsesBody(routedProvider(), "Existing caller instructions.");
    const entry = getDebugLogEntries()
      .findLast(row => row.line.startsWith("[ocx:openai-responses:outbound-shape]"));
    expect(entry).toBeDefined();
    const payload = JSON.parse(entry!.line.slice(entry!.line.indexOf("] ") + 2)) as {
      instructions?: { bytes?: number; routedProgressContractPresent?: boolean; text?: unknown };
    };

    expect(payload.instructions).toEqual({
      bytes: Buffer.byteLength(body.instructions as string, "utf8"),
      routedProgressContractPresent: true,
    });
    expect(payload.instructions).not.toHaveProperty("text");
  });
});

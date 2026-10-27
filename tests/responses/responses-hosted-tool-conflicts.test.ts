import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const provider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward" as const,
};

describe("OpenAI Responses hosted-tool name conflicts", () => {
  const keyedProvider = {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.example/v1",
    authMode: "key" as const,
    apiKey: "sk-test",
  };
  const meta = { headers: new Headers({ authorization: "Bearer token" }) };

  test("keyed platform replaces a dotted image_gen function with a safe alias", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [
          { type: "function", name: "image_gen.imagegen", parameters: {} },
          { type: "image_generation" },
          { type: "web_search" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: { type: string; name?: string }[] };

    // Hosted image_generation dropped; the declared client tool wins and unrelated hosted tools stay.
    expect(body.tools).toHaveLength(2);
    expect(body.tools.some(t => t.type === "image_generation")).toBe(false);
    expect(body.tools.some(t => t.type === "function" && t.name === "image_gen__imagegen")).toBe(true);
    expect(body.tools.some(t => t.type === "web_search")).toBe(true);
  });

  test("keyed platform flattens an image_gen namespace and removes the hosted duplicate", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [
          {
            type: "namespace",
            name: "image_gen",
            description: "Client image tools",
            tools: [{
              type: "function",
              name: "imagegen",
              description: "Generate or edit an image",
              parameters: { type: "object", properties: { prompt: { type: "string" } } },
              strict: true,
            }],
          },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };

    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toEqual({
      type: "function",
      name: "image_gen__imagegen",
      description: "Generate or edit an image",
      parameters: { type: "object", properties: { prompt: { type: "string" } } },
      strict: true,
    });
  });

  test("keyed platform rewrites a forced image-gen tool choice with its declared alias", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [{
          type: "namespace",
          name: "image_gen",
          tools: [{ type: "function", name: "imagegen", parameters: {} }],
        }],
        tool_choice: { type: "function", name: "image_gen.imagegen" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tool_choice: { type: string; name: string };
    };

    expect(body.tool_choice).toEqual({ type: "function", name: "image_gen__imagegen" });
  });

  test("keyed platform rewrites image-gen entries in an allowed-tools choice", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [{
          type: "additional_tools",
          tools: [{ type: "function", name: "image_gen.imagegen", parameters: {} }],
        }],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [
            { type: "function", name: "image_gen.imagegen" },
            { type: "function", name: "exec_command" },
          ],
        },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tool_choice: { type: string; mode: string; tools: Array<{ type: string; name: string }> };
    };

    expect(body.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "function", name: "image_gen__imagegen" },
        { type: "function", name: "exec_command" },
      ],
    });
  });

  test("keyed responses-lite flattens a nested namespace without requiring a hosted tool", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [
              {
                type: "namespace",
                name: "image_gen",
                tools: [{ type: "function", name: "imagegen", parameters: { type: "object" } }],
              },
              { type: "web_search" },
            ],
          },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      input: Array<{ type: string; role?: string; tools?: Array<{ type: string; name?: string }> }>;
    };
    const additionalTools = body.input.find(item => item.type === "additional_tools");

    // Preserve the input entry and unrelated tools while lowering the private namespace.
    expect(additionalTools).toBeDefined();
    expect(additionalTools?.role).toBe("developer");
    expect(additionalTools?.tools?.some(t => t.type === "namespace")).toBe(false);
    expect(additionalTools?.tools?.some(t =>
      t.type === "function" && t.name === "image_gen__imagegen"
    )).toBe(true);
    expect(additionalTools?.tools?.some(t => t.type === "web_search")).toBe(true);
    expect(body.input.some(item => item.type === "message")).toBe(true);
  });

  test("keyed responses-lite detects image_gen conflicts across top-level and nested tool groups", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        tools: [
          { type: "image_generation" },
          { type: "web_search" },
        ],
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [{ type: "function", name: "image_gen.imagegen", parameters: {} }],
          },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string }>;
      input: Array<{ type: string; tools?: Array<{ type: string; name?: string }> }>;
      tool_choice?: { type: string; name?: string };
    };
    const additionalTools = body.input.find(item => item.type === "additional_tools");

    // The platform validates one merged namespace even when declarations use different groups.
    expect(body.tools.some(t => t.type === "image_generation")).toBe(false);
    expect(body.tools.some(t => t.type === "web_search")).toBe(true);
    expect(additionalTools?.tools?.some(t => t.name === "image_gen__imagegen")).toBe(true);
  });

  test("keyed platform encodes native and legacy image-gen calls for upstream replay", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        tools: [{
          type: "namespace",
          name: "image_gen",
          tools: [{ type: "function", name: "imagegen", parameters: {} }],
        }],
        input: [
          {
            type: "function_call",
            namespace: "image_gen",
            name: "imagegen",
            call_id: "call_native",
            arguments: "{}",
          },
          {
            type: "function_call",
            name: "image_gen.imagegen",
            call_id: "call_legacy",
            arguments: "{}",
          },
          { type: "function_call", name: "exec_command", call_id: "call_other", arguments: "{}" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      input: Array<{ name?: string; namespace?: string }>;
    };

    expect(body.input[0]).toMatchObject({ name: "image_gen__imagegen", call_id: "call_native" });
    expect(body.input[0]).not.toHaveProperty("namespace");
    expect(body.input[1]).toMatchObject({ name: "image_gen__imagegen", call_id: "call_legacy" });
    expect(body.input[2]).toMatchObject({ name: "exec_command", call_id: "call_other" });
  });

  test("keyed responses normalization is idempotent and deduplicates image-gen aliases", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const firstRequest = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        tools: [{
          type: "namespace",
          name: "image_gen",
          tools: [{ type: "function", name: "imagegen", parameters: { type: "object" } }],
        }],
        input: [{
          type: "additional_tools",
          role: "developer",
          tools: [
            { type: "function", name: "image_gen.imagegen", parameters: { type: "object" } },
            { type: "web_search" },
          ],
        }],
      },
    }, meta);
    const firstBody = JSON.parse(firstRequest.body) as {
      tools: Array<{ type: string; name?: string }>;
      input: Array<{ type: string; tools?: Array<{ type: string; name?: string }> }>;
    };

    expect(firstBody.tools).toEqual([
      { type: "function", name: "image_gen__imagegen", parameters: { type: "object" } },
    ]);
    expect(firstBody.input[0]?.tools).toEqual([{ type: "web_search" }]);

    const secondRequest = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: firstBody,
    }, meta);
    expect(JSON.parse(secondRequest.body)).toEqual(firstBody);
  });

  test("keyed platform flattens complete namespaces and drops ones it cannot express", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [
          { type: "namespace", name: "image_gen", tools: [] },
          {
            type: "namespace",
            name: "web",
            tools: [{ type: "function", name: "run", parameters: {} }],
          },
          { type: "image_generation" },
        ],
        tool_choice: { type: "function", name: "image_gen.imagegen" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<Record<string, unknown>>;
      tool_choice: { type: string; name: string };
    };

    // The empty `image_gen` group declares nothing, and relaying `type: "namespace"` is the shape a
    // strict gateway rejects for the whole request.
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "web__run",
        parameters: { type: "object" },
      },
      { type: "image_generation" },
    ]);
    expect(body.tool_choice).toEqual({ type: "function", name: "image_gen.imagegen" });
  });

  test("configured model removes an empty image_gen namespace and preserves hosted image generation", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        tools: [{ type: "image_generation" }],
        input: [{
          type: "additional_tools",
          role: "developer",
          tools: [
            { type: "namespace", name: "image_gen", tools: [] },
            { type: "web_search" },
          ],
        }],
        tool_choice: { type: "function", name: "image_gen.imagegen" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string }>;
      input: Array<{ type: string; tools?: Array<{ type: string; name?: string }> }>;
    };
    const additionalTools = body.input.find(item => item.type === "additional_tools");

    expect(body.tools).toEqual([{ type: "image_generation" }]);
    expect(additionalTools?.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
  });

  test("an inherited Object.prototype key is not read as a preference", () => {
    // `provider.modelPreferHostedTools?.[modelId]` walked the prototype chain, so a
    // routed model literally named `constructor` or `toString` yielded a function
    // and threw on `.includes` before the request was ever dispatched.
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    for (const inheritedKey of ["constructor", "toString", "hasOwnProperty"]) {
      const request = adapter.buildRequest({
        modelId: inheritedKey,
        context: { messages: [] },
        stream: true,
        options: {},
        _rawBody: {
          model: inheritedKey,
          tools: [{ type: "image_generation" }],
          tool_choice: { type: "function", name: "image_gen.imagegen" },
        },
      }, meta);
      const body = JSON.parse(request.body) as { tool_choice: unknown };
      // Unconfigured model: ordinary normalization applies, the hosted preference does not.
      expect(body.tool_choice).toEqual({ type: "function", name: "image_gen.imagegen" });
    }
  });

  test("multi-container stripping restores hosted image generation exactly once", () => {
    // Stripping runs over every container. Restoration must not: tool declarations are
    // request-scoped, and `hasHostedImageGenDeclaration` treats a declaration in any
    // container as covering the request. #924 briefly restored into each stripped
    // container and put `image_generation` on the wire twice; this asserts against both
    // that and the original defect of losing the capability entirely.
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [{ type: "namespace", name: "image_gen", tools: [] }, { type: "web_search" }],
          },
          {
            type: "additional_tools",
            role: "developer",
            tools: [{ type: "namespace", name: "image_gen", tools: [] }],
          },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      input: Array<{ type: string; tools?: Array<{ type: string }> }>;
    };
    const containers = body.input.filter(item => item.type === "additional_tools");

    expect(containers).toHaveLength(2);
    const hostedDeclarations = containers.flatMap(container =>
      (container.tools ?? []).filter(tool => tool.type === "image_generation"));
    // Exactly one hosted declaration on the wire, riding the first stripped container
    // so the capability is neither lost nor duplicated.
    expect(hostedDeclarations).toEqual([{ type: "image_generation" }]);
    expect(containers[0].tools).toContainEqual({ type: "image_generation" });
  });

  test("configured model rewrites a custom image-gen selector", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        input: [],
        tools: [
          { type: "custom", name: "image_gen.render" },
          { type: "image_generation" },
        ],
        tool_choice: { type: "custom", name: "image_gen.render" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string }>;
      tool_choice: { type: string };
    };

    expect(body.tools).toEqual([{ type: "image_generation" }]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
  });

  test("configured model retains a hosted declaration for a wrapper-only selector", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        input: [],
        tools: [{ type: "namespace", name: "image_gen", tools: [] }],
        tool_choice: { type: "function", name: "image_gen.imagegen" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string }>;
      tool_choice: { type: string };
    };

    expect(body.tools).toEqual([{ type: "image_generation" }]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
  });

  test("configured model retains hosted image generation without a forced selector", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });

    for (const toolChoice of ["auto", "none", undefined] as const) {
      const request = adapter.buildRequest({
        modelId: "provider-image-model",
        context: { messages: [] },
        stream: true,
        options: {},
        _rawBody: {
          model: "provider-image-model",
          input: [],
          tools: [{ type: "namespace", name: "image_gen", tools: [] }],
          ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
        },
      }, meta);
      const body = JSON.parse(request.body) as {
        tools: Array<{ type: string }>;
        tool_choice?: string;
      };

      expect(body.tools).toEqual([{ type: "image_generation" }]);
      expect(body.tool_choice).toBe(toolChoice);
    }
  });

  test("configured model retains a hosted declaration in wrapper-only additional tools", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        tools: [],
        input: [{
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "namespace", name: "image_gen", tools: [] }],
        }],
        tool_choice: { type: "function", name: "image_gen.imagegen" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      input: Array<{ type: string; tools?: Array<{ type: string }> }>;
      tool_choice: { type: string };
    };
    const additionalTools = body.input.find(item => item.type === "additional_tools");

    expect(additionalTools?.tools).toEqual([{ type: "image_generation" }]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
  });

  test("configured model restores hosted image generation in unforced additional tools", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        tools: [],
        input: [{
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "namespace", name: "image_gen", tools: [] }],
        }],
        tool_choice: "auto",
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      input: Array<{ type: string; tools?: Array<{ type: string }> }>;
      tool_choice: string;
    };
    const additionalTools = body.input.find(item => item.type === "additional_tools");

    expect(additionalTools?.tools).toEqual([{ type: "image_generation" }]);
    expect(body.tool_choice).toBe("auto");
  });

  test("configured model retains unrelated allowed-tools selector entries", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        input: [],
        tools: [
          { type: "namespace", name: "image_gen", tools: [] },
          { type: "image_generation" },
          { type: "function", name: "exec_command", parameters: {} },
        ],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [
            { type: "function", name: "image_gen.imagegen" },
            { type: "function", name: "exec_command" },
          ],
        },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string; name?: string }>;
      tool_choice?: { type: string; mode: string; tools: Array<{ type: string; name?: string }> };
    };

    expect(body.tools).toEqual([
      { type: "image_generation" },
      { type: "function", name: "exec_command", parameters: { type: "object" } },
    ]);
    expect(body.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "image_generation" },
        { type: "function", name: "exec_command" },
      ],
    });
  });

  test("configured model rewrites custom image-gen entries in an allowed-tools selector", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        input: [],
        tools: [
          { type: "custom", name: "image_gen.render" },
          { type: "image_generation" },
          { type: "custom", name: "exec_command" },
        ],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [
            { type: "custom", name: "image_gen.render" },
            { type: "custom", name: "exec_command" },
          ],
        },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string; name?: string }>;
      tool_choice: { type: string; mode: string; tools: Array<{ type: string; name?: string }> };
    };

    expect(body.tools).toEqual([
      { type: "image_generation" },
      { type: "function", name: "exec_command", parameters: { type: "object" } },
    ]);
    expect(body.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "image_generation" },
        { type: "function", name: "exec_command" },
      ],
    });
  });

  test("hosted-tool preference stays scoped to its configured model", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "other-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "other-model",
        input: [],
        tools: [
          { type: "namespace", name: "image_gen", tools: [] },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };

    // The empty namespace group is lowered away; only the hosted tool reaches the wire.
    expect(body.tools).toEqual([{ type: "image_generation" }]);
  });

  test("hosted-tool preference uses the exact model id", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model:variant",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model:variant",
        input: [],
        tools: [
          { type: "namespace", name: "image_gen", tools: [] },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };

    // The empty namespace group is lowered away; only the hosted tool reaches the wire.
    expect(body.tools).toEqual([{ type: "image_generation" }]);
  });

  test("hosted-tool preference honors an OpenAI virtual model's selected id", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "gpt-5.6-sol-pro": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      _openAiVirtualSelectedModelId: "gpt-5.6-sol-pro",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [
          { type: "namespace", name: "image_gen", tools: [] },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };

    expect(body.tools).toEqual([{ type: "image_generation" }]);
  });

  test("keyed platform preserves hosted image_generation for replay-only image-gen calls", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        tools: [{ type: "image_generation" }],
        input: [{
          type: "function_call",
          namespace: "image_gen",
          name: "imagegen",
          call_id: "call_replay",
          arguments: "{}",
        }],
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string }>;
      input: Array<{ name?: string; namespace?: string }>;
    };

    expect(body.tools).toEqual([{ type: "image_generation" }]);
    expect(body.input[0]).toMatchObject({
      type: "function_call",
      name: "image_gen__imagegen",
      call_id: "call_replay",
    });
    expect(body.input[0]).not.toHaveProperty("namespace");
  });

  test("keyed platform preserves hosted image_generation for a bare image_gen function", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [
          { type: "function", name: "image_gen", parameters: {} },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };

    expect(body.tools).toEqual([
      { type: "function", name: "image_gen", parameters: { type: "object" } },
      { type: "image_generation" },
    ]);
  });

  test("keyed platform keeps hosted image_generation when no conflicting tool is declared", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [
          { type: "function", name: "shell", parameters: {} },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: { type: string }[] };

    expect(body.tools).toHaveLength(2);
    expect(body.tools.some(t => t.type === "image_generation")).toBe(true);
  });

  test("forward backend preserves the private image_gen namespace and hosted tool", () => {
    // The ChatGPT backend understands the private namespace; lowering it would change native behavior.
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [],
        tools: [
          {
            type: "namespace",
            name: "image_gen",
            tools: [{ type: "function", name: "imagegen", parameters: {} }],
          },
          { type: "image_generation" },
        ],
        tool_choice: { type: "function", name: "image_gen.imagegen" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string; name?: string; tools?: Array<{ name?: string }> }>;
      tool_choice: { type: string; name: string };
    };

    expect(body.tools).toHaveLength(2);
    expect(body.tools.some(t => t.type === "image_generation")).toBe(true);
    expect(body.tools.some(t =>
      t.type === "namespace"
      && t.name === "image_gen"
      && t.tools?.some(inner => inner.name === "imagegen")
    )).toBe(true);
    expect(body.tool_choice).toEqual({ type: "function", name: "image_gen.imagegen" });
  });
});

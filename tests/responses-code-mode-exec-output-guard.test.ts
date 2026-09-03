/**
 * Codex code-mode exec is a client-owned freeform tool whose V8 program must
 * explicitly emit nested helper results. Routed Responses models need the
 * shared echo rule before execution and an exact diagnostic after a uniquely
 * paired empty wrapper, without rewriting unrelated or ambiguous history.
 */
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import {
  CODE_MODE_RESULT_ECHO_SENTENCE,
  EMPTY_EXEC_OUTPUT_REGEX,
  EMPTY_EXEC_OUTPUT_MESSAGE,
  FAILED_EXEC_OUTPUT_MESSAGE,
} from "../src/adapters/exec-tool-result-normalize";
import { EMPTY_TOOL_OUTPUT_ANNOTATION } from "../src/adapters/empty-tool-output-annotation";
import { ROUTED_PROGRESS_CONTRACT } from "../src/fork/routed-progress-contract";
import {
  namespacedToolName,
  type OcxProviderConfig,
  type OcxTool,
  type OcxToolChoice,
} from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const SUCCESS_EMPTY_WRAPPER = "Script completed\nWall time 0.2 seconds\nOutput:\n";
const FAILED_EMPTY_WRAPPER = "Script failed\nWall time 0.2 seconds\nOutput:\n";
const LEGACY_SUCCESSFUL_WRAPPER_REGEX = /^(?:(?:Script completed|Command finished|Execution finished)[^\n]*\n+)?(?:Wall time[^\n]*\n+)?(?:Output:\s*)?(?:<empty>)?\s*$/;
const BASE_INSTRUCTIONS = "BASE CODE-MODE INSTRUCTIONS";
const MISSING_INSTRUCTIONS = Symbol("missing instructions");

const THIRD_PARTY: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://ark.example/api/plan/v3",
  responsesPath: "/responses",
  authMode: "key",
  apiKey: "test-key",
};

const OPENAI_API: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authMode: "key",
  apiKey: "test-key",
};

const CHATGPT_FORWARD: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
};

const NONCANONICAL_FORWARD: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://forward.example/v1",
  authMode: "forward",
};

const CODE_MODE_EXEC: OcxTool = {
  name: "exec",
  description: "Run JavaScript in a V8 isolate.",
  parameters: {},
  freeform: true,
};

const STRUCTURED_EXEC: OcxTool = {
  name: "exec",
  description: "Run a structured command.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const WAIT_TOOL: OcxTool = {
  name: "wait",
  description: "Wait for a cell.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const BARE_SHELL: OcxTool = {
  name: "exec_command",
  description: "Run shell directly.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const NAMESPACED_SHELL: OcxTool = {
  namespace: "mcp__docker",
  name: "shell_command",
  description: "Run shell in Docker.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

function wireTool(tool: OcxTool): Record<string, unknown> {
  const name = namespacedToolName(tool.namespace, tool.name);
  return tool.freeform === true
    ? { type: "custom", name, description: tool.description, format: { type: "text" } }
    : { type: "function", name, description: tool.description, parameters: tool.parameters };
}

function wireToolChoice(choice: OcxToolChoice): unknown {
  if (typeof choice === "string") return choice;
  if ("allowedTools" in choice) {
    return {
      type: "allowed_tools",
      mode: choice.mode,
      tools: choice.allowedTools.map(name => ({
        type: name === "exec" ? "custom" : "function",
        name,
      })),
    };
  }
  return { type: choice.name === "exec" ? "custom" : "function", name: choice.name };
}

function pairedCustomExec(
  output: unknown = SUCCESS_EMPTY_WRAPPER,
  callId = "call_exec",
): Array<Record<string, unknown>> {
  return [
    { type: "custom_tool_call", id: "ctc_exec", call_id: callId, name: "exec", input: "noop" },
    { type: "custom_tool_call_output", call_id: callId, output },
  ];
}

type BuildOptions = {
  provider?: OcxProviderConfig;
  contextTools?: OcxTool[];
  toolChoice?: OcxToolChoice;
  instructions?: unknown | typeof MISSING_INSTRUCTIONS;
  input?: unknown[];
  compaction?: boolean;
  annotateEmpty?: boolean;
  stateless?: boolean;
};

function build(options: BuildOptions = {}): {
  body: Record<string, unknown>;
  rawBody: Record<string, unknown>;
  rawBodySnapshot: Record<string, unknown>;
  contextTools: OcxTool[];
} {
  const contextTools = options.contextTools ?? [CODE_MODE_EXEC, WAIT_TOOL];
  const toolChoice = options.toolChoice ?? "auto";
  const baseProvider = options.provider ?? THIRD_PARTY;
  const provider: OcxProviderConfig = {
    ...baseProvider,
    ...(options.annotateEmpty ? { annotateEmptyToolOutputs: true } : {}),
    ...(options.stateless ? { statelessResponses: true } : {}),
  };
  const rawBody: Record<string, unknown> = {
    model: "glm-5.3-flash",
    input: options.input ?? pairedCustomExec(),
    tools: contextTools.map(wireTool),
    tool_choice: wireToolChoice(toolChoice),
    stream: true,
    ...(options.instructions === MISSING_INSTRUCTIONS
      ? {}
      : { instructions: options.instructions ?? BASE_INSTRUCTIONS }),
  };
  const rawBodySnapshot = structuredClone(rawBody);
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
  const request = adapter.buildRequest({
    modelId: "glm-5.3-flash",
    context: { messages: [], tools: contextTools },
    stream: true,
    options: { toolChoice },
    _rawBody: rawBody,
    ...(options.compaction ? { _compactionRequest: true } : {}),
  }, { headers: new Headers({ "thread-id": "thread-code-mode-output-guard" }) });
  return {
    body: JSON.parse(request.body) as Record<string, unknown>,
    rawBody,
    rawBodySnapshot,
    contextTools,
  };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function outputFor(body: Record<string, unknown>, callId: string): unknown {
  const input = body.input as Array<Record<string, unknown>>;
  return input.find(item => (
    (item.type === "custom_tool_call_output" || item.type === "function_call_output")
    && item.call_id === callId
  ))?.output;
}

describe("Responses code-mode exec output guard", () => {
  test("adds the shared echo rule once before the fresh routed progress contract", () => {
    const { body } = build();
    const instructions = String(body.instructions);

    expect(instructions).toContain(BASE_INSTRUCTIONS);
    expect(occurrences(instructions, CODE_MODE_RESULT_ECHO_SENTENCE)).toBe(1);
    expect(occurrences(instructions, ROUTED_PROGRESS_CONTRACT)).toBe(1);
    expect(instructions.indexOf(CODE_MODE_RESULT_ECHO_SENTENCE))
      .toBeLessThan(instructions.indexOf(ROUTED_PROGRESS_CONTRACT));
  });

  test("does not duplicate caller-supplied echo or progress contracts", () => {
    for (const instructions of [
      `${BASE_INSTRUCTIONS}\n\n${CODE_MODE_RESULT_ECHO_SENTENCE}`,
      `${BASE_INSTRUCTIONS}\n\n${ROUTED_PROGRESS_CONTRACT}`,
      `${BASE_INSTRUCTIONS}\n\n${ROUTED_PROGRESS_CONTRACT}\n\n${CODE_MODE_RESULT_ECHO_SENTENCE}`,
    ]) {
      const body = build({ instructions }).body;
      const outbound = String(body.instructions);
      expect(occurrences(outbound, CODE_MODE_RESULT_ECHO_SENTENCE)).toBe(1);
      expect(occurrences(outbound, ROUTED_PROGRESS_CONTRACT)).toBe(1);
      expect(outbound).toContain(instructions);
    }
  });

  const gateCases: Array<{
    label: string;
    options: BuildOptions;
    expected: boolean;
  }> = [
    { label: "third-party code mode", options: {}, expected: true },
    { label: "official OpenAI API", options: { provider: OPENAI_API }, expected: false },
    { label: "canonical ChatGPT forward", options: { provider: CHATGPT_FORWARD }, expected: false },
    { label: "structured exec", options: { contextTools: [STRUCTURED_EXEC, WAIT_TOOL] }, expected: false },
    { label: "bare shell bridge", options: { contextTools: [CODE_MODE_EXEC, BARE_SHELL] }, expected: false },
    { label: "namespaced MCP shell", options: { contextTools: [CODE_MODE_EXEC, NAMESPACED_SHELL] }, expected: true },
    { label: "tool choice none", options: { toolChoice: "none" }, expected: false },
    {
      label: "allowed tools exclude exec",
      options: { toolChoice: { allowedTools: ["wait"], mode: "auto" } },
      expected: false,
    },
    { label: "routed compaction", options: { compaction: true }, expected: false },
    { label: "missing instructions", options: { instructions: MISSING_INSTRUCTIONS }, expected: false },
    { label: "non-string instructions", options: { instructions: { text: BASE_INSTRUCTIONS } }, expected: false },
  ];

  for (const { label, options, expected } of gateCases) {
    test(`shares one eligibility decision for ${label}`, () => {
      const body = build(options).body;
      const instructions = typeof body.instructions === "string" ? body.instructions : "";
      expect(instructions.includes(CODE_MODE_RESULT_ECHO_SENTENCE)).toBe(expected);
      expect(JSON.stringify(body).includes(EMPTY_EXEC_OUTPUT_MESSAGE)).toBe(expected);
      expect(outputFor(body, "call_exec"))
        .toBe(expected ? EMPTY_EXEC_OUTPUT_MESSAGE : SUCCESS_EMPTY_WRAPPER);
    });
  }

  test("normalizes successful and failed wrappers only on a unique custom exec pair", () => {
    expect(outputFor(build().body, "call_exec")).toBe(EMPTY_EXEC_OUTPUT_MESSAGE);
    expect(outputFor(
      build({ input: pairedCustomExec(FAILED_EMPTY_WRAPPER, "call_failed") }).body,
      "call_failed",
    )).toBe(FAILED_EXEC_OUTPUT_MESSAGE);
  });

  test("leaves function and local-shell history unchanged inside an otherwise eligible request", () => {
    const input = [
      ...pairedCustomExec(SUCCESS_EMPTY_WRAPPER, "call_exec"),
      { type: "function_call", call_id: "call_fn_exec", name: "exec", arguments: "{}" },
      { type: "function_call_output", call_id: "call_fn_exec", output: SUCCESS_EMPTY_WRAPPER },
      { type: "function_call", call_id: "call_shell", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call_shell", output: SUCCESS_EMPTY_WRAPPER },
      { type: "function_call", call_id: "call_named_shell", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_named_shell", output: SUCCESS_EMPTY_WRAPPER },
      { type: "function_call", call_id: "call_named_local", name: "local_shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_named_local", output: SUCCESS_EMPTY_WRAPPER },
      { type: "local_shell_call", call_id: "call_local_item", name: "local_shell", action: {} },
      { type: "function_call_output", call_id: "call_local_item", output: SUCCESS_EMPTY_WRAPPER },
    ];
    const body = build({ input }).body;
    expect(outputFor(body, "call_exec")).toBe(EMPTY_EXEC_OUTPUT_MESSAGE);
    expect(outputFor(body, "call_fn_exec")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(outputFor(body, "call_shell")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(outputFor(body, "call_named_shell")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(outputFor(body, "call_named_local")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(outputFor(body, "call_local_item")).toBe(SUCCESS_EMPTY_WRAPPER);
  });

  test("requires the paired custom exec call to be bare and unnamespaced", () => {
    const body = build({
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_namespaced_exec",
          namespace: "mcp__sandbox",
          name: "exec",
          input: "noop",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_namespaced_exec",
          output: SUCCESS_EMPTY_WRAPPER,
        },
      ],
    }).body;
    expect(outputFor(body, "call_namespaced_exec")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
  });

  test("does not cross-pair function and custom wire kinds", () => {
    const body = build({
      input: [
        { type: "function_call", call_id: "call_cross_fn", name: "exec", arguments: "{}" },
        { type: "custom_tool_call_output", call_id: "call_cross_fn", output: SUCCESS_EMPTY_WRAPPER },
        { type: "custom_tool_call", call_id: "call_cross_custom", name: "exec", input: "noop" },
        { type: "function_call_output", call_id: "call_cross_custom", output: SUCCESS_EMPTY_WRAPPER },
      ],
    }).body;
    expect(outputFor(body, "call_cross_fn")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(outputFor(body, "call_cross_custom")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
  });

  for (const [label, calls] of [
    ["identical exec duplicates", [
      { type: "custom_tool_call", call_id: "call_dup", name: "exec", input: "noop" },
      { type: "custom_tool_call", call_id: "call_dup", name: "exec", input: "noop" },
    ]],
    ["different exec duplicates", [
      { type: "custom_tool_call", call_id: "call_dup", name: "exec", input: "one" },
      { type: "custom_tool_call", call_id: "call_dup", name: "exec", input: "two" },
    ]],
    ["exec plus non-exec duplicate", [
      { type: "custom_tool_call", call_id: "call_dup", name: "exec", input: "noop" },
      { type: "custom_tool_call", call_id: "call_dup", name: "other", input: "noop" },
    ]],
  ] as const) {
    test(`skips ${label}`, () => {
      const body = build({
        input: [
          ...calls,
          { type: "custom_tool_call_output", call_id: "call_dup", output: SUCCESS_EMPTY_WRAPPER },
        ],
      }).body;
      expect(outputFor(body, "call_dup")).toBe(SUCCESS_EMPTY_WRAPPER);
      expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
    });
  }

  test("leaves non-exec, non-string, and ordinary non-empty custom outputs unchanged", () => {
    const objectOutput = { result: "structured" };
    const body = build({
      input: [
        { type: "custom_tool_call", call_id: "call_other", name: "other", input: "noop" },
        { type: "custom_tool_call_output", call_id: "call_other", output: SUCCESS_EMPTY_WRAPPER },
        { type: "custom_tool_call", call_id: "call_object", name: "exec", input: "noop" },
        { type: "custom_tool_call_output", call_id: "call_object", output: objectOutput },
        { type: "custom_tool_call", call_id: "call_normal", name: "exec", input: "noop" },
        { type: "custom_tool_call_output", call_id: "call_normal", output: "normal stdout" },
      ],
    }).body;
    expect(outputFor(body, "call_other")).toBe(SUCCESS_EMPTY_WRAPPER);
    expect(outputFor(body, "call_object")).toBe(JSON.stringify(objectOutput));
    expect(outputFor(body, "call_normal")).toBe("normal stdout");
    expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
  });

  test("keeps generic empty annotation ahead of exec-specific diagnosis", () => {
    const body = build({
      annotateEmpty: true,
      input: pairedCustomExec(""),
    }).body;
    expect(outputFor(body, "call_exec")).toBe(EMPTY_TOOL_OUTPUT_ANNOTATION);
    expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
  });

  test("keeps call-ID-less output on the predecessor truthful carrier path", () => {
    const body = build({
      input: [{ type: "custom_tool_call_output", name: "exec", output: SUCCESS_EMPTY_WRAPPER }],
    }).body;
    expect(JSON.stringify(body)).toContain("original call_id missing");
    expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
  });

  test("normalizes an eligible paired wrapper on noncanonical forward and stateless routes", () => {
    for (const options of [
      { provider: NONCANONICAL_FORWARD },
      { stateless: true },
    ] satisfies BuildOptions[]) {
      const body = build(options).body;
      expect(String(body.instructions)).toContain(CODE_MODE_RESULT_ECHO_SENTENCE);
      expect(outputFor(body, "call_exec")).toBe(EMPTY_EXEC_OUTPUT_MESSAGE);
    }
  });

  test("is a no-op for unpaired stateful output and preserves existing forward/stateless policy", () => {
    const unpaired = [
      { type: "custom_tool_call_output", call_id: "call_orphan", output: SUCCESS_EMPTY_WRAPPER },
    ];

    const stateful = build({ input: unpaired }).body;
    expect(outputFor(stateful, "call_orphan")).toBe(SUCCESS_EMPTY_WRAPPER);

    for (const options of [
      { provider: NONCANONICAL_FORWARD },
      { stateless: true },
    ] satisfies BuildOptions[]) {
      const body = build({ ...options, input: unpaired }).body;
      expect(JSON.stringify(body)).toContain("[tool output for call_orphan]");
      expect(JSON.stringify(body)).not.toContain(EMPTY_EXEC_OUTPUT_MESSAGE);
    }
  });

  test("does not mutate raw body, input items, or logical tools while normalizing", () => {
    const input = pairedCustomExec();
    const contextTools = [CODE_MODE_EXEC, WAIT_TOOL];
    const rawInputSnapshot = structuredClone(input);
    const toolsSnapshot = structuredClone(contextTools);
    const result = build({ input, contextTools });

    expect(result.rawBody).toEqual(result.rawBodySnapshot);
    expect(result.rawBody.instructions).toBe(BASE_INSTRUCTIONS);
    expect(input).toEqual(rawInputSnapshot);
    expect(contextTools).toEqual(toolsSnapshot);
    expect(result.rawBody.input).toBe(input);
    expect(result.rawBody.tools).toEqual(contextTools.map(wireTool));
    expect(result.contextTools).toBe(contextTools);
    expect(outputFor(result.body, "call_exec")).toBe(EMPTY_EXEC_OUTPUT_MESSAGE);
  });

  test("preserves the legacy successful-wrapper grammar on a bounded short corpus", () => {
    const corpus = [
      "",
      " ",
      "<empty>",
      "  <empty>",
      "Output:",
      "Output:   ",
      "Output:\t\n <empty>\r\n",
      "Output:<empty><empty>",
      "Output: payload",
      "Script completed\n",
      "Script completed detail\nOutput:",
      "Command finished with suffix\n\nWall time 0.2s\nOutput: <empty>",
      "Execution finished\r\nOutput:",
      "Execution finished without newline",
      "Wall time 1s\nOutput:",
      "Wall time without newline",
      "Script failed\nOutput:",
      "Script completed\n<empty>",
      "Script completed\n  <empty>",
      "Script completed\n\nWall time 1s\n\nOutput:\n<empty>",
    ];

    for (const value of corpus) {
      expect(EMPTY_EXEC_OUTPUT_REGEX.test(value))
        .toBe(LEGACY_SUCCESSFUL_WRAPPER_REGEX.test(value));
    }
  });

  test("classifies a long successful-wrapper near-match in bounded CPU work", () => {
    const warmup = `Output:${" ".repeat(8_000)}x`;
    const malformed = `Output:${" ".repeat(64_000)}x`;

    build({ input: pairedCustomExec(warmup, "call_warmup") });

    const before = process.cpuUsage();
    const body = build({ input: pairedCustomExec(malformed, "call_long") }).body;
    const spent = process.cpuUsage(before);
    const cpuMs = (spent.user + spent.system) / 1000;

    expect(outputFor(body, "call_long")).toBe(malformed);
    expect(cpuMs).toBeLessThan(250);
  });
});

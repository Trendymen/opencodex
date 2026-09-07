import { toolChoiceToolPredicate, type OcxParsedRequest, type OcxProviderConfig } from "../types";
import { isOpenAiOperatedResponsesDestination } from "../providers/openai-tiers";
import { CODE_MODE_RESULT_ECHO_SENTENCE, normalizeEmptyExecToolResultText } from "./exec-tool-result-normalize";
import { isBareShellBridgeTool, isCodexCodeModeExecTool } from "./tool-catalog-nudge";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Inspect the whole result, not just its empty header: later text or media is real output. */
function textOnlyOutput(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return undefined;
  if (!output.every(part => record(part)
    && ["text", "input_text", "output_text"].includes(String(part.type))
    && typeof part.text === "string")) return undefined;
  return output.map(part => part.text).join("\n");
}

function withExecInputGuidance(tool: unknown): unknown {
  if (!record(tool) || tool.type !== "function" || tool.name !== "exec" || tool.namespace !== undefined) return tool;
  if (!record(tool.parameters) || !record(tool.parameters.properties) || !record(tool.parameters.properties.input)) return tool;
  return { ...tool, parameters: { ...tool.parameters, properties: {
    ...tool.parameters.properties,
    input: {
      ...tool.parameters.properties.input,
      description: `JavaScript source for unified exec; do not provide a bare shell command. ${CODE_MODE_RESULT_ECHO_SENTENCE}`,
    },
  } } };
}

function uniqueBareCustomExecCallIds(body: unknown): Set<string> {
  if (!record(body) || !Array.isArray(body.input)) return new Set();
  const provenance = new Map<string, {
    itemCount: number;
    bareCustomExecCallCount: number;
    customOutputCount: number;
  }>();
  for (const item of body.input) {
    if (!record(item) || typeof item.call_id !== "string" || item.call_id.trim().length === 0) continue;
    const occurrence = provenance.get(item.call_id) ?? {
      itemCount: 0,
      bareCustomExecCallCount: 0,
      customOutputCount: 0,
    };
    occurrence.itemCount += 1;
    if (item.type === "custom_tool_call") {
      if (item.name === "exec" && item.namespace === undefined) occurrence.bareCustomExecCallCount += 1;
    } else if (item.type === "custom_tool_call_output") {
      occurrence.customOutputCount += 1;
    }
    provenance.set(item.call_id, occurrence);
  }
  return new Set([...provenance].flatMap(([callId, occurrence]) => (
    occurrence.itemCount === 2
    && occurrence.bareCustomExecCallCount === 1
    && occurrence.customOutputCount === 1
      ? [callId]
      : []
  )));
}

/** Native routed Responses needs the same first-call/output contract as translated adapters. */
export function normalizeResponsesCodeMode(body: unknown, parsed: OcxParsedRequest, provider: OcxProviderConfig): unknown {
  if (!record(body) || parsed._compactionRequest || isOpenAiOperatedResponsesDestination(provider)) return body;
  const visible = parsed.context.tools?.filter(toolChoiceToolPredicate(parsed.options.toolChoice, parsed.context.tools));
  if (!visible?.some(isCodexCodeModeExecTool) || visible.some(isBareShellBridgeTool)) return body;
  if (typeof body.instructions !== "string") return body;
  const instructions = body.instructions;
  const input = Array.isArray(body.input) ? body.input : undefined;
  const execCalls = uniqueBareCustomExecCallIds(parsed._rawBody);
  return {
    ...body,
    instructions: instructions.includes(CODE_MODE_RESULT_ECHO_SENTENCE)
      ? instructions : [instructions, CODE_MODE_RESULT_ECHO_SENTENCE].filter(Boolean).join("\n\n"),
    ...(Array.isArray(body.tools) ? { tools: body.tools.map(withExecInputGuidance) } : {}),
    ...(input ? { input: input.map(item => {
      if (!record(item)) return item;
      if (item.type === "additional_tools" && Array.isArray(item.tools)) {
        return { ...item, tools: item.tools.map(withExecInputGuidance) };
      }
      if ((item.type !== "function_call_output" && item.type !== "custom_tool_call_output")
        || typeof item.call_id !== "string" || !execCalls.has(item.call_id)) return item;
      const text = textOnlyOutput(item.output);
      const normalized = text === undefined ? undefined : normalizeEmptyExecToolResultText(text, { toolName: "exec" });
      return normalized === undefined ? item : { ...item, output: normalized };
    }) } : {}),
  };
}

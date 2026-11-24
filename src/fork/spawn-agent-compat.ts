import { collectResponsesToolGroups } from "../responses/tool-groups";
import { isOpenAiOperatedResponsesDestination } from "../providers/openai-tiers-destination";
import { isBackendTaskCiphertext, OMITTED_ENCRYPTED_CONTENT_TEXT } from "../lib/agent-task-ciphertext";
import type { OcxProviderConfig } from "../types";

const FORK_TURNS_GUIDANCE = "This field's JSON type is string. Its value must be `none`, `all`, or a positive integer string. For three turns, use `{\"fork_turns\":\"3\"}`; the string content is only `3`, without quote characters. Do not JSON.stringify this field value separately.";
const SPAWN_AGENT_KEY = "collaboration__spawn_agent";
const PLAIN_MESSAGE_GUIDANCE = "Write the complete task or message as readable plain text in this field. Do not encrypt, encode, or replace it with an opaque token.";
export const COLLABORATION_MESSAGE_NAMES: ReadonlySet<string> = new Set(["spawn_agent", "send_message", "followup_task"]);
export const KIMI_PLAINTEXT_AGENT_ERROR_CODE = "unreadable_agent_tool_message";
const ORIGINAL_ENCRYPTED_AGENT_PERMISSION = Symbol("kimi-original-encrypted-agent-permission");
type ProviderWithOriginalAgentPermission = OcxProviderConfig & { [ORIGINAL_ENCRYPTED_AGENT_PERMISSION]?: boolean };
const SAFE_PARAMETERS_KEYS = new Set(["type", "properties", "required", "additionalProperties", "description", "title"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUnconstrainedForkTurnsString(parameters: Record<string, unknown> | undefined): boolean {
  if (!parameters || parameters.type !== "object" || !isObject(parameters.properties)) return false;
  if (!Object.keys(parameters).every(key => SAFE_PARAMETERS_KEYS.has(key))) return false;
  const forkTurns = parameters.properties.fork_turns;
  if (!isObject(forkTurns) || forkTurns.type !== "string") return false;
  return Object.keys(forkTurns).every(key => key === "type" || key === "description")
    && (forkTurns.description === undefined || typeof forkTurns.description === "string");
}

type AuthorizedFunctionSchema = { name: string; namespace?: string; parameters?: Record<string, unknown> };

export function preserveKimiAgentTaskRoutePermission(projected: OcxProviderConfig, original: OcxProviderConfig): OcxProviderConfig {
  const result: ProviderWithOriginalAgentPermission = { ...projected, [ORIGINAL_ENCRYPTED_AGENT_PERMISSION]: original.allowEncryptedV2AgentTasks === true };
  return result;
}

export function isKimiPlaintextAgentMessageRoute(
  provider: OcxProviderConfig,
  modelId: string,
  plaintextDecision: boolean | undefined,
): boolean {
  return plaintextDecision === true && provider.authMode !== "forward" && !isOpenAiOperatedResponsesDestination(provider)
    && !((provider as ProviderWithOriginalAgentPermission)[ORIGINAL_ENCRYPTED_AGENT_PERMISSION] ?? (provider.allowEncryptedV2AgentTasks === true))
    && provider.arkKimiResponsesModels?.includes(modelId) === true;
}

function withPlainMessageGuidance(
  tool: unknown,
  authorized: ReadonlyMap<string, AuthorizedFunctionSchema> | undefined,
): unknown {
  if (!isObject(tool) || tool.type !== "function" || typeof tool.name !== "string"
    || !COLLABORATION_MESSAGE_NAMES.has(tool.name) || !isObject(tool.parameters)
    || tool.parameters.type !== "object" || !isObject(tool.parameters.properties)) return tool;
  const schema = authorized?.get(`collaboration__${tool.name}`);
  if (schema?.namespace !== "collaboration" || schema.name !== tool.name) return tool;
  const message = tool.parameters.properties.message;
  if (!isObject(message) || message.type !== "string"
    || (message.description !== undefined && typeof message.description !== "string")) return tool;
  const description = message.description ?? "";
  if (description.includes(PLAIN_MESSAGE_GUIDANCE)) return tool;
  return { ...tool, parameters: { ...tool.parameters, properties: { ...tool.parameters.properties,
    message: { ...message, description: description ? `${description}\n\n${PLAIN_MESSAGE_GUIDANCE}` : PLAIN_MESSAGE_GUIDANCE },
  } } };
}

function withForkTurnsGuidance(
  tool: unknown,
  authorized: ReadonlyMap<string, AuthorizedFunctionSchema>,
): unknown {
  const authorizedSchema = authorized.get(SPAWN_AGENT_KEY);
  if (!isObject(tool) || tool.type !== "function" || tool.name !== "spawn_agent" || !isObject(tool.parameters)
    || !hasUnconstrainedForkTurnsString(tool.parameters)
    || authorizedSchema?.namespace !== "collaboration" || authorizedSchema.name !== "spawn_agent") return tool;
  const properties = tool.parameters.properties as Record<string, unknown>;
  const forkTurns = properties.fork_turns as Record<string, unknown>;
  const description = typeof forkTurns.description === "string" ? forkTurns.description : "";
  if (description.includes(FORK_TURNS_GUIDANCE)) return tool;
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...properties,
        fork_turns: {
          ...forkTurns,
          description: description ? `${description}\n\n${FORK_TURNS_GUIDANCE}` : FORK_TURNS_GUIDANCE,
        },
      },
    },
  };
}

function withCollaborationSpawnAgentGuidance(
  tools: unknown[],
  authorized: ReadonlyMap<string, AuthorizedFunctionSchema>,
  plaintextAuthorized: ReadonlyMap<string, AuthorizedFunctionSchema> | undefined,
): unknown[] {
  let changed = false;
  const next = tools.map(tool => {
    if (!isObject(tool) || tool.type !== "namespace" || tool.name !== "collaboration" || !Array.isArray(tool.tools)) return tool;
    let childrenChanged = false;
    const children = tool.tools.map(child => {
      const nextChild = withPlainMessageGuidance(withForkTurnsGuidance(child, authorized), plaintextAuthorized);
      childrenChanged ||= nextChild !== child;
      return nextChild;
    });
    if (!childrenChanged) return tool;
    changed = true;
    return { ...tool, tools: children };
  });
  return changed ? next : tools;
}

export function addSpawnAgentForkTurnsGuidance(
  body: unknown,
  authorized: ReadonlyMap<string, AuthorizedFunctionSchema>,
  plaintextAuthorized?: ReadonlyMap<string, AuthorizedFunctionSchema>,
): unknown {
  if (!isObject(body)) return body;
  const groups = collectResponsesToolGroups(body);
  if (groups.length === 0) return body;
  let changed = false;
  const tools = Array.isArray(body.tools) ? withCollaborationSpawnAgentGuidance(body.tools, authorized, plaintextAuthorized) : body.tools;
  changed ||= tools !== body.tools;
  let input = body.input;
  if (Array.isArray(body.input)) {
    let inputChanged = false;
    const next = body.input.map(item => {
      if (!isObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const tools = withCollaborationSpawnAgentGuidance(item.tools, authorized, plaintextAuthorized);
      if (tools === item.tools) return item;
      inputChanged = true;
      return { ...item, tools };
    });
    if (inputChanged) {
      changed = true;
      input = next;
    }
  }
  return changed ? { ...body, ...(tools !== body.tools ? { tools } : {}), ...(input !== body.input ? { input } : {}) } : body;
}

function isAuthorizedSpawnAgentSchema(schema: { name: string; namespace?: string; parameters?: Record<string, unknown> }): boolean {
  return schema.namespace === "collaboration" && schema.name === "spawn_agent"
    && hasUnconstrainedForkTurnsString(schema.parameters);
}

function isAcceptedForkTurnsValue(value: string): boolean {
  if (value === "none" || value === "all") return true;
  return /^[1-9][0-9]*$/.test(value) && value.length <= 16 && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}

function skipWhitespace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  return index;
}

function stringEnd(text: string, index: number): number | undefined {
  if (text[index] !== '"') return undefined;
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (text[cursor] === '"') return cursor + 1;
  }
  return undefined;
}

function valueEnd(text: string, index: number): number | undefined {
  if (text[index] === '"') return stringEnd(text, index);
  if (text[index] !== "{" && text[index] !== "[") {
    let cursor = index;
    while (cursor < text.length && !",}] \t\r\n".includes(text[cursor]!)) cursor += 1;
    return cursor > index ? cursor : undefined;
  }
  let depth = 0;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const char = text[cursor]!;
    if (char === '"') {
      const end = stringEnd(text, cursor);
      if (end === undefined) return undefined;
      cursor = end - 1;
    } else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return undefined;
}

function topLevelStringMember(text: string, key: string): { start: number; end: number; value: string } | undefined {
  let cursor = skipWhitespace(text, 0);
  if (text[cursor] !== "{") return undefined;
  cursor = skipWhitespace(text, cursor + 1);
  let latest: { start: number; end: number; value: string } | undefined;
  let found = false;
  while (text[cursor] !== "}") {
    const keyEnd = stringEnd(text, cursor);
    if (keyEnd === undefined) return undefined;
    let memberName: unknown;
    try { memberName = JSON.parse(text.slice(cursor, keyEnd)); } catch { return undefined; }
    cursor = skipWhitespace(text, keyEnd);
    if (text[cursor] !== ":") return undefined;
    const start = skipWhitespace(text, cursor + 1);
    const end = valueEnd(text, start);
    if (end === undefined) return undefined;
    if (memberName === key && text[start] === '"') {
      if (found) return undefined;
      found = true;
      try {
        const value = JSON.parse(text.slice(start, end));
        if (typeof value === "string") latest = { start, end, value };
      } catch { return undefined; }
    } else if (memberName === key) return undefined;
    cursor = skipWhitespace(text, end);
    if (text[cursor] === "}") break;
    if (text[cursor] !== ",") return undefined;
    cursor = skipWhitespace(text, cursor + 1);
  }
  return latest;
}

export function omitOpaqueKimiCollaborationHistory(body: unknown): unknown {
  if (!isObject(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map(item => {
    if (!isObject(item) || item.type !== "function_call" || item.namespace !== "collaboration"
      || typeof item.name !== "string" || !COLLABORATION_MESSAGE_NAMES.has(item.name)) return item;
    if (typeof item.arguments === "string") {
      let args: unknown;
      try { args = JSON.parse(item.arguments); } catch { return item; }
      if (!isObject(args) || typeof args.message !== "string" || !isBackendTaskCiphertext(args.message.trim())) return item;
      const member = topLevelStringMember(item.arguments, "message");
      if (!member || member.value !== args.message) return item;
      changed = true;
      return { ...item, arguments: `${item.arguments.slice(0, member.start)}${JSON.stringify(OMITTED_ENCRYPTED_CONTENT_TEXT)}${item.arguments.slice(member.end)}` };
    }
    if (isObject(item.arguments) && typeof item.arguments.message === "string" && isBackendTaskCiphertext(item.arguments.message.trim())) {
      changed = true;
      return { ...item, arguments: { ...item.arguments, message: OMITTED_ENCRYPTED_CONTENT_TEXT } };
    }
    return item;
  });
  return changed ? { ...body, input } : body;
}

export function repairSpawnAgentForkTurnsArguments(
  argumentsText: string,
  schema: { name: string; namespace?: string; parameters?: Record<string, unknown> },
): string {
  if (!isAuthorizedSpawnAgentSchema(schema)) return argumentsText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return argumentsText;
  }
  if (!isObject(parsed) || typeof parsed.fork_turns !== "string") return argumentsText;
  const quoted = parsed.fork_turns;
  if (quoted.length < 2 || quoted[0] !== '"' || quoted.at(-1) !== '"') return argumentsText;
  let decoded: unknown;
  try {
    decoded = JSON.parse(quoted);
  } catch {
    return argumentsText;
  }
  if (typeof decoded !== "string" || JSON.stringify(decoded) !== quoted || !isAcceptedForkTurnsValue(decoded)) return argumentsText;
  const member = topLevelStringMember(argumentsText, "fork_turns");
  if (!member || member.value !== quoted) return argumentsText;
  return `${argumentsText.slice(0, member.start)}${JSON.stringify(decoded)}${argumentsText.slice(member.end)}`;
}

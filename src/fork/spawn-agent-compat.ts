import { collectResponsesToolGroups } from "../responses/tool-groups";

const FORK_TURNS_GUIDANCE = "This field's JSON type is string. Its value must be `none`, `all`, or a positive integer string. For three turns, use `{\"fork_turns\":\"3\"}`; the string content is only `3`, without quote characters. Do not JSON.stringify this field value separately.";
const SPAWN_AGENT_KEY = "collaboration__spawn_agent";
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
): unknown[] {
  let changed = false;
  const next = tools.map(tool => {
    if (!isObject(tool) || tool.type !== "namespace" || tool.name !== "collaboration" || !Array.isArray(tool.tools)) return tool;
    let childrenChanged = false;
    const children = tool.tools.map(child => {
      const nextChild = withForkTurnsGuidance(child, authorized);
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
): unknown {
  if (!isObject(body)) return body;
  const groups = collectResponsesToolGroups(body);
  if (groups.length === 0) return body;
  let changed = false;
  const tools = Array.isArray(body.tools) ? withCollaborationSpawnAgentGuidance(body.tools, authorized) : body.tools;
  changed ||= tools !== body.tools;
  let input = body.input;
  if (Array.isArray(body.input)) {
    let inputChanged = false;
    const next = body.input.map(item => {
      if (!isObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const tools = withCollaborationSpawnAgentGuidance(item.tools, authorized);
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

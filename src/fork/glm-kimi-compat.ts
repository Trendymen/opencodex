/** Exact Ark/Kimi and Zhipu GLM Responses compatibility for the relay fork. */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { OcxProviderConfig } from "../types";
import { isOpenAiOperatedResponsesDestination } from "../providers/openai-tiers";
import { debugProviderDiagnostic } from "../lib/debug";
import { getConfigDir } from "../config/paths";
import { isOwnedConfigPath, recordOwnedConfigPath } from "../lib/config-ownership";

const ARK_AGENT_PLAN_V3 = "https://ark.cn-beijing.volces.com/api/plan/v3";

/** True when the model family is OpenAI's own GPT line (gpt-*, o3/o4-mini, codex-*,
 *  chatgpt-*). Third-party re-hosts of other families never match this. */
function isOpenAiGptModelFamily(modelId: string): boolean {
  const normalized = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  return /^(chatgpt|gpt|codex)([-_.]|$)/.test(normalized) || /^o[34]([-_]|$)/.test(normalized);
}
const ZHIPU_CODEX_RESPONSES = "https://open.bigmodel.cn/api/v1";
const KIMI_SCHEMA_MAX_DEPTH = 32;
const KIMI_SCHEMA_MAX_NODES = 4_096;

export type KimiToolSchemaLoweringDiagnostic = Readonly<{
  tools: ReadonlyArray<Readonly<{
    name: string;
    originalBytes: number;
    loweredBytes: number;
  }>>;
}>;

export type GlmKimiOutboundCompatibilityResult = Readonly<{
  body: unknown;
  threadIdTag?: string;
  kimiToolSchemaLowering?: KimiToolSchemaLoweringDiagnostic;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function usesVolcengineAgentPlanResponses(provider: OcxProviderConfig): boolean {
  return provider.adapter === "openai-responses"
    && provider.baseUrl.replace(/\/+$/, "") === ARK_AGENT_PLAN_V3;
}

export function isVolcengineAgentPlanKimi(provider: OcxProviderConfig, modelId: string): boolean {
  return modelId === "kimi-k3" && usesVolcengineAgentPlanResponses(provider);
}

function isZhipuCodexGlmSchemaTarget(provider: OcxProviderConfig, modelId: string): boolean {
  return provider.adapter === "openai-responses"
    && provider.baseUrl.replace(/\/+$/, "") === ZHIPU_CODEX_RESPONSES
    && (modelId === "glm-5.3" || modelId === "glm-5.3-flash");
}

function usesProviderToolSchemaLowering(provider: OcxProviderConfig, modelId: string): boolean {
  return isVolcengineAgentPlanKimi(provider, modelId)
    || isZhipuCodexGlmSchemaTarget(provider, modelId);
}

function debugOpaqueTag(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const loggedKimiToolSchemaCatalogs = new Set<string>();
const MAX_KIMI_TOOL_SCHEMA_CATALOGS = 16;
const MAX_KIMI_TOOL_SCHEMA_CATALOG_FILE_BYTES = 1024 * 1024;
const MAX_KIMI_TOOL_SCHEMA_CATALOG_TOTAL_BYTES = 4 * 1024 * 1024;
const KIMI_TOOL_SCHEMA_CATALOG_DIR = "kimi-tool-schema-catalogs";

function collectKimiFunctionTools(body: unknown): Array<Record<string, unknown>> {
  if (!isPlainObject(body)) return [];
  const groups: unknown[][] = [];
  if (Array.isArray(body.tools)) groups.push(body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) groups.push(item.tools);
    }
  }
  return groups.flatMap(tools => tools.filter(tool => isPlainObject(tool) && tool.type === "function" && typeof tool.name === "string" && isPlainObject(tool.parameters)) as Record<string, unknown>[]);
}

export function persistKimiToolSchemaCatalog(args: {
  body: unknown;
  provider: OcxProviderConfig;
  modelId: string;
  threadIdTag?: string;
  url: string;
}): void {
  if (!isVolcengineAgentPlanKimi(args.provider, args.modelId) || !isPlainObject(args.body)) return;
  const tools = collectKimiFunctionTools(args.body).map(tool => ({ name: tool.name, parameters: tool.parameters }));
  if (tools.length === 0) return;
  let serialized: string;
  try {
    serialized = JSON.stringify(tools);
  } catch {
    return;
  }
  const serializedBytes = Buffer.byteLength(serialized, "utf8") + 1;
  if (serializedBytes > MAX_KIMI_TOOL_SCHEMA_CATALOG_FILE_BYTES) return;
  const catalogHash = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
  if (loggedKimiToolSchemaCatalogs.has(catalogHash)) return;
  if (loggedKimiToolSchemaCatalogs.size >= MAX_KIMI_TOOL_SCHEMA_CATALOGS) loggedKimiToolSchemaCatalogs.clear();
  try {
    const dir = getConfigDir();
    const catalogDir = join(dir, KIMI_TOOL_SCHEMA_CATALOG_DIR);
    const existed = existsSync(catalogDir);
    if (existed) {
      if (!isOwnedConfigPath(dir, catalogDir)) return;
    } else {
      if (!recordOwnedConfigPath(dir, catalogDir)) return;
      mkdirSync(catalogDir, { mode: 0o700 });
    }
    const entry = lstatSync(catalogDir);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return;
    const rootReal = realpathSync.native(dir);
    const catalogReal = realpathSync.native(catalogDir);
    const relativePath = relative(rootReal, catalogReal);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return;
    try { chmodSync(catalogDir, 0o700); } catch { /* best-effort */ }
    const path = join(catalogDir, `kimi-tool-schema-catalog-${catalogHash}.json`);
    const prior = readdirSync(catalogDir)
      .filter(name => /^kimi-tool-schema-catalog-[a-f0-9]{16}\.json$/.test(name))
      .map(name => {
        const entryPath = join(catalogDir, name);
        const stat = lstatSync(entryPath);
        return { name, path: entryPath, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    const targetExists = prior.some(entry => entry.path === path);
    let projectedBytes = prior.reduce((total, entry) => total + entry.size, 0) + (targetExists ? 0 : serializedBytes);
    let projectedCount = prior.length + (targetExists ? 0 : 1);
    for (const existing of prior) {
      if (projectedCount <= MAX_KIMI_TOOL_SCHEMA_CATALOGS
        && projectedBytes <= MAX_KIMI_TOOL_SCHEMA_CATALOG_TOTAL_BYTES) break;
      if (existing.path === path) continue;
      try {
        unlinkSync(existing.path);
        projectedBytes -= existing.size;
        projectedCount -= 1;
      } catch { /* best-effort bounded diagnostics */ }
    }
    if (projectedCount > MAX_KIMI_TOOL_SCHEMA_CATALOGS
      || projectedBytes > MAX_KIMI_TOOL_SCHEMA_CATALOG_TOTAL_BYTES) return;
    try {
      writeFileSync(path, `${serialized}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      const existing = lstatSync(path);
      if (!existing.isFile() || existing.isSymbolicLink()) return;
    }
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    loggedKimiToolSchemaCatalogs.add(catalogHash);
  } catch { /* diagnostics must never affect provider requests */ }
  let host = ""; let pathname = "";
  try { const parsed = new URL(args.url); host = parsed.host; pathname = parsed.pathname; } catch { pathname = "invalid-url"; }
  debugProviderDiagnostic("openai-responses", "kimi-tool-schema-catalog", { model: args.modelId, ...(args.threadIdTag ? { threadIdTag: args.threadIdTag } : {}), host, pathname, catalogHash, tools });
}

function appendTrailingUserTurnForPrefillRestrictedModel(
  body: unknown,
  provider: OcxProviderConfig,
  modelId: string,
): unknown {
  // Prefill rejection is a third-party Responses behavior: official OpenAI-operated
  // destinations (ChatGPT Codex forward, api.openai.com) accept assistant tails, and
  // GPT-family models served by third parties may legitimately rely on prefill. Every
  // other openai-responses destination gets a trailing user turn when the input ends
  // with an assistant message.
  if (provider.adapter !== "openai-responses") return body;
  if (isOpenAiOperatedResponsesDestination(provider)) return body;
  if (isOpenAiGptModelFamily(modelId)) return body;
  if (!isPlainObject(body) || !Array.isArray(body.input) || body.input.length === 0) return body;
  const last = body.input[body.input.length - 1];
  if (!isPlainObject(last) || last.type !== "message" || last.role !== "assistant") return body;
  return {
    ...body,
    input: [
      ...body.input,
      { type: "message", role: "user", content: [{ type: "input_text", text: "(continue)" }] },
    ],
  };
}

function normalizeVolcengineAgentPlanAssistantContent(body: unknown, provider: OcxProviderConfig): unknown {
  if (!usesVolcengineAgentPlanResponses(provider) || !isPlainObject(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.flatMap(item => {
    if (!isPlainObject(item)
      || (item.type !== undefined && item.type !== "message")
      || item.role !== "assistant"
      || !Array.isArray(item.content)) return [item];
    const content = item.content.filter(part => !isPlainObject(part)
      || (part.type !== "output_text" && part.type !== "input_text")
      || (typeof part.text === "string" && part.text.trim().length > 0));
    if (content.length === item.content.length && content.length > 0) return [item];
    changed = true;
    return content.length > 0 ? [{ ...item, content }] : [];
  });
  return changed ? { ...body, input } : body;
}

function localDefinition(ref: unknown, definitions: Record<string, unknown>): unknown {
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) return undefined;
  return definitions[ref.slice("#/$defs/".length)];
}

function primitiveSchemaValues(value: unknown): unknown[] {
  if (!isPlainObject(value)) return [];
  if (Array.isArray(value.enum)) return value.enum.filter(entry => entry === null || ["string", "number", "boolean"].includes(typeof entry));
  if (value.const === null || ["string", "number", "boolean"].includes(typeof value.const)) return [value.const];
  return [];
}

function mergeKimiSchemaProperty(left: unknown, right: unknown): unknown {
  if (!isPlainObject(left)) return right;
  if (!isPlainObject(right)) return left;
  const values = [...primitiveSchemaValues(left), ...primitiveSchemaValues(right)];
  const uniqueValues = [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
  const properties: Record<string, unknown> = {};
  const leftProperties = isPlainObject(left.properties) ? left.properties : {};
  const rightProperties = isPlainObject(right.properties) ? right.properties : {};
  for (const key of new Set([...Object.keys(leftProperties), ...Object.keys(rightProperties)])) {
    properties[key] = key in leftProperties && key in rightProperties
      ? mergeKimiSchemaProperty(leftProperties[key], rightProperties[key])
      : key in leftProperties ? leftProperties[key] : rightProperties[key];
  }
  const merged: Record<string, unknown> = { ...left, ...right };
  if (uniqueValues.length > 0) {
    delete merged.const;
    merged.enum = uniqueValues;
  }
  if (Object.keys(properties).length > 0) {
    merged.type = "object";
    merged.properties = properties;
    merged.additionalProperties = true;
  }
  return merged;
}

type KimiSchemaLoweringContext = { nodes: number };

function schemaTypes(value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  if (typeof value.type === "string") return [value.type];
  if (Array.isArray(value.type)) return value.type.filter((entry): entry is string => typeof entry === "string");
  return primitiveSchemaValues(value).map(entry => entry === null ? "null" : typeof entry);
}

function downlevelKimiToolSchema(
  value: unknown,
  definitions: Record<string, unknown>,
  resolving = new Set<string>(),
  context: KimiSchemaLoweringContext = { nodes: 0 },
  depth = 0,
): unknown {
  if (depth > KIMI_SCHEMA_MAX_DEPTH || ++context.nodes > KIMI_SCHEMA_MAX_NODES) {
    throw new RangeError("Kimi automation schema lowering budget exceeded");
  }
  if (Array.isArray(value)) return value.map(entry => downlevelKimiToolSchema(entry, definitions, resolving, context, depth + 1));
  if (!isPlainObject(value)) return value;
  const referenced = localDefinition(value.$ref, definitions);
  if (referenced !== undefined && typeof value.$ref === "string") {
    if (resolving.has(value.$ref)) return { type: "object", additionalProperties: true };
    const next = new Set(resolving);
    next.add(value.$ref);
    const loweredReference = downlevelKimiToolSchema(referenced, definitions, next, context, depth + 1);
    const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
    if (Object.keys(siblings).length === 0) return loweredReference;
    return mergeKimiSchemaProperty(
      loweredReference,
      downlevelKimiToolSchema(siblings, definitions, resolving, context, depth + 1),
    );
  }
  const unionBranches = [
    ...(Array.isArray(value.oneOf) ? value.oneOf : []),
    ...(depth === 0 && Array.isArray(value.anyOf) ? value.anyOf : []),
    ...(Array.isArray(value.allOf) ? value.allOf : []),
  ].map(branch => downlevelKimiToolSchema(branch, definitions, resolving, context, depth + 1));
  const properties: Record<string, unknown> = {};
  const propertySources = [
    isPlainObject(value.properties)
      ? { properties: Object.fromEntries(Object.entries(value.properties).map(([key, property]) => [
        key,
        downlevelKimiToolSchema(property, definitions, resolving, context, depth + 1),
      ])) }
      : undefined,
    ...unionBranches,
  ];
  for (const branch of propertySources) {
    if (!isPlainObject(branch) || !isPlainObject(branch.properties)) continue;
    for (const [key, property] of Object.entries(branch.properties)) {
      properties[key] = key in properties ? mergeKimiSchemaProperty(properties[key], property) : property;
    }
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (["$defs", "$ref", "oneOf", "allOf", "properties", "required", "additionalProperties"].includes(key) || (depth === 0 && key === "anyOf")) continue;
    output[key] = downlevelKimiToolSchema(entry, definitions, resolving, context, depth + 1);
  }
  if (Object.keys(properties).length > 0) {
    output.type = "object";
    output.properties = properties;
    output.additionalProperties = true;
  } else {
    const scalarValues = unionBranches.flatMap(primitiveSchemaValues);
    const everyBranchHasValues = unionBranches.length > 0 && unionBranches.every(branch => primitiveSchemaValues(branch).length > 0);
    if (everyBranchHasValues && scalarValues.length > 0) {
      output.enum = [...new Map(scalarValues.map(entry => [JSON.stringify(entry), entry])).values()];
    }
    const types = [...new Set([value, ...unionBranches].flatMap(schemaTypes))];
    if (types.length === 1) output.type = types[0];
    else if (types.length > 1) output.type = types;
  }
  return output;
}

function containsKimiUnsupportedSchemaFeature(value: unknown, depth = 0): boolean {
  if (Array.isArray(value)) return value.some(entry => containsKimiUnsupportedSchemaFeature(entry, depth + 1));
  if (!isPlainObject(value)) return false;
  if (["$defs", "$ref", "oneOf", "allOf"].some(key => Object.hasOwn(value, key))) return true;
  if (depth === 0 && Object.hasOwn(value, "anyOf")) return true;
  return Object.values(value).some(entry => containsKimiUnsupportedSchemaFeature(entry, depth + 1));
}

function lowerKimiFunctionToolSchemas(
  body: unknown,
  provider: OcxProviderConfig,
  modelId: string,
): { body: unknown; diagnostic?: KimiToolSchemaLoweringDiagnostic } {
  if (!usesProviderToolSchemaLowering(provider, modelId) || !isPlainObject(body)) return { body };
  const loweredTools: Array<{ name: string; originalBytes: number; loweredBytes: number }> = [];
  const lowerGroup = (tools: unknown[]): unknown[] => tools.map(tool => {
    if (!isPlainObject(tool) || tool.type !== "function" || typeof tool.name !== "string" || !isPlainObject(tool.parameters) || !containsKimiUnsupportedSchemaFeature(tool.parameters)) return tool;
    const definitions = isPlainObject(tool.parameters.$defs) ? tool.parameters.$defs : {};
    const parameters = downlevelKimiToolSchema(tool.parameters, definitions);
    loweredTools.push({ name: tool.name, originalBytes: Buffer.byteLength(JSON.stringify(tool.parameters), "utf8"), loweredBytes: Buffer.byteLength(JSON.stringify(parameters), "utf8") });
    return { ...tool, parameters };
  });
  const tools = Array.isArray(body.tools) ? lowerGroup(body.tools) : body.tools;
  const input = Array.isArray(body.input) ? body.input.map(item => isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools) ? { ...item, tools: lowerGroup(item.tools) } : item) : body.input;
  return loweredTools.length > 0 ? { body: { ...body, ...(Array.isArray(tools) ? { tools } : {}), ...(Array.isArray(input) ? { input } : {}) }, diagnostic: { tools: loweredTools } } : { body };
}

export function applyGlmKimiOutboundCompatibility(args: {
  body: unknown;
  provider: OcxProviderConfig;
  modelId: string;
  threadId?: string | null;
  url?: string;
}): GlmKimiOutboundCompatibilityResult {
  const kimiTrace = isVolcengineAgentPlanKimi(args.provider, args.modelId);
  const threadIdTag = debugOpaqueTag(args.threadId);
  let host = "";
  let pathname = "";
  try {
    const parsed = new URL(args.url ?? "");
    host = parsed.host;
    pathname = parsed.pathname;
  } catch {
    pathname = "invalid-url";
  }
  const traceContext = {
    ...(threadIdTag ? { threadIdTag } : {}),
    host,
    pathname,
  };
  if (kimiTrace) {
    debugProviderDiagnostic("openai-responses", "kimi-schema-trace", {
      stage: "build-start",
      model: args.modelId,
      ...traceContext,
    });
  }
  let body = normalizeVolcengineAgentPlanAssistantContent(args.body, args.provider);
  body = appendTrailingUserTurnForPrefillRestrictedModel(body, args.provider, args.modelId);
  let lowered: { body: unknown; diagnostic?: KimiToolSchemaLoweringDiagnostic };
  try {
    lowered = lowerKimiFunctionToolSchemas(body, args.provider, args.modelId);
  } catch (error) {
    if (kimiTrace) {
      debugProviderDiagnostic("openai-responses", "kimi-schema-trace", {
        stage: "schema-error",
        model: args.modelId,
        ...traceContext,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256),
      });
    }
    lowered = { body };
  }
  if (kimiTrace && lowered.diagnostic) {
    debugProviderDiagnostic("openai-responses", "kimi-schema-trace", {
      stage: "schema-lowered",
      model: args.modelId,
      ...traceContext,
      ...lowered.diagnostic,
    });
  }
  return {
    body: lowered.body,
    ...(threadIdTag ? { threadIdTag } : {}),
    ...(kimiTrace && lowered.diagnostic ? { kimiToolSchemaLowering: lowered.diagnostic } : {}),
  };
}

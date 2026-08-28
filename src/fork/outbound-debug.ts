/** Redacted outbound Responses shape diagnostics for relay compatibility work. */

import type { OcxProviderConfig } from "../types";
import { debugProviderDiagnostic } from "../lib/debug";
import { isDebugEnabled } from "../lib/debug-settings";
import type { KimiToolSchemaLoweringDiagnostic } from "./glm-kimi-compat";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function debugTypeSummary(values: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const type = isPlainObject(value) && typeof value.type === "string" ? value.type : typeof value;
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function debugSchemaFeatures(value: unknown): string[] {
  const seen = new Set<string>();
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!isPlainObject(entry)) return;
    for (const key of ["$defs", "$ref", "oneOf", "anyOf", "allOf", "additionalProperties"]) {
      if (Object.hasOwn(entry, key)) seen.add(key);
    }
    for (const child of Object.values(entry)) visit(child);
  };
  visit(value);
  return [...seen].sort();
}

function debugToolSummary(values: unknown[]): Record<string, unknown> {
  const names: string[] = [];
  let nestedToolCount = 0;
  for (const value of values) {
    if (!isPlainObject(value)) continue;
    if (typeof value.name === "string") names.push(value.name);
    if (Array.isArray(value.tools)) nestedToolCount += value.tools.length;
  }
  return {
    count: values.length,
    typeCounts: debugTypeSummary(values),
    nameSample: names.slice(0, 16),
    execPresent: names.includes("exec"),
    nestedToolCount,
    schemaSummary: values.flatMap(value => {
      if (!isPlainObject(value) || typeof value.name !== "string") return [];
      const parameters = value.parameters;
      return [{
        name: value.name,
        parameterBytes: parameters === undefined ? 0 : Buffer.byteLength(JSON.stringify(parameters), "utf8"),
        schemaFeatures: debugSchemaFeatures(parameters),
      }];
    }).slice(0, 64),
  };
}

function debugInputTail(values: unknown[]): Record<string, unknown>[] {
  return values.slice(-4).map(value => {
    if (!isPlainObject(value)) return { kind: typeof value };
    return {
      ...(typeof value.type === "string" ? { type: value.type } : {}),
      ...(typeof value.role === "string" ? { role: value.role } : {}),
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.call_id === "string" ? { hasCallId: true } : {}),
    };
  });
}

export function debugResponsesOutboundShape(args: {
  url: string;
  provider: OcxProviderConfig;
  model: string;
  body: unknown;
  bodyBytes: number;
  convertedCustomToolNames?: ReadonlySet<string>;
  convertedToolSearchNames?: ReadonlySet<string>;
  convertedNamespaceAliases?: ReadonlyMap<string, unknown>;
  kimiToolSchemaLowering?: KimiToolSchemaLoweringDiagnostic;
  threadIdTag?: string;
}): void {
  if (!isDebugEnabled()) return;
  if (!isPlainObject(args.body)) return;
  const body = args.body;
  const input = Array.isArray(body.input) ? body.input : [];
  const inputTypes = input.map(item => isPlainObject(item) && typeof item.type === "string" ? item.type : typeof item);
  const additionalTools = input.flatMap(item => isPlainObject(item)
    && item.type === "additional_tools" && Array.isArray(item.tools) ? item.tools : []);
  let host = "";
  let pathname = "";
  try {
    const parsed = new URL(args.url);
    host = parsed.host;
    pathname = parsed.pathname;
  } catch {
    pathname = "invalid-url";
  }
  const reasoning = isPlainObject(body.reasoning)
    ? {
        keys: Object.keys(body.reasoning).sort(),
        ...(typeof body.reasoning.effort === "string" ? { effort: body.reasoning.effort } : {}),
      }
    : { kind: typeof body.reasoning };
  debugProviderDiagnostic("openai-responses", "outbound-shape", {
    host,
    pathname,
    model: args.model,
    ...(args.threadIdTag ? { threadIdTag: args.threadIdTag } : {}),
    authMode: args.provider.authMode,
    stream: body.stream === true,
    store: body.store,
    partialPresent: Object.hasOwn(body, "partial"),
    reasoning,
    toolChoice: body.tool_choice,
    parallelToolCalls: body.parallel_tool_calls,
    previousResponseIdPresent: typeof body.previous_response_id === "string" && body.previous_response_id.length > 0,
    topLevelTools: debugToolSummary(Array.isArray(body.tools) ? body.tools : []),
    additionalTools: debugToolSummary(additionalTools),
    input: {
      count: input.length,
      typeCounts: debugTypeSummary(input),
      typeSample: inputTypes.slice(0, 24),
      tail: debugInputTail(input),
    },
    bodyBytes: args.bodyBytes,
    convertedCustomToolNames: args.convertedCustomToolNames ? [...args.convertedCustomToolNames] : [],
    convertedToolSearchNames: args.convertedToolSearchNames ? [...args.convertedToolSearchNames] : [],
    convertedNamespaceAliasCount: args.convertedNamespaceAliases?.size ?? 0,
    ...(args.kimiToolSchemaLowering ? { kimiToolSchemaLowering: args.kimiToolSchemaLowering } : {}),
  });
}

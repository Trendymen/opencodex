import { canonicalizeReasoningEfforts, isDeclaredReasoningEffort } from "../reasoning-effort";
import { routedSlug } from "../providers/slug-codec";
import type { OcxCustomModel } from "../types";

const INPUT_MODALITIES = new Set(["text", "image", "audio"]);
const TOOL_MODES = new Set(["code_mode_only", "shell"]);

export type CustomModelSalvageResult = Readonly<{
  value: OcxCustomModel[] | undefined;
  changed: boolean;
  droppedRows: number;
  changedFields: number;
}>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length > 0 ? result : undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function salvageStringList(
  value: unknown,
  allowed: (entry: string) => boolean,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const entry of value) {
    const normalized = trimmed(entry);
    if (!normalized || !allowed(normalized) || result.includes(normalized)) continue;
    result.push(normalized);
  }
  return result.length > 0 ? result : undefined;
}

function salvageRow(record: Record<string, unknown>): OcxCustomModel | undefined {
  const id = trimmed(record.id);
  const provider = trimmed(record.provider);
  const modelId = trimmed(record.modelId);
  if (!id || !provider || !modelId) return undefined;

  const row: Record<string, unknown> = { ...record, id, provider, modelId };

  const displayName = trimmed(record.displayName);
  if (displayName && !displayName.includes("/")) row.displayName = displayName;
  else delete row.displayName;

  if (typeof record.contextWindow === "number"
    && Number.isFinite(record.contextWindow)
    && Number.isInteger(record.contextWindow)
    && record.contextWindow > 0) row.contextWindow = record.contextWindow;
  else delete row.contextWindow;

  const modalities = salvageStringList(record.inputModalities, value => INPUT_MODALITIES.has(value));
  if (modalities) row.inputModalities = modalities;
  else delete row.inputModalities;

  if (Array.isArray(record.reasoningEfforts) && record.reasoningEfforts.length === 0) {
    row.reasoningEfforts = [];
  } else {
    const efforts = salvageStringList(record.reasoningEfforts, isDeclaredReasoningEffort);
    if (efforts) row.reasoningEfforts = canonicalizeReasoningEfforts(efforts);
    else delete row.reasoningEfforts;
  }

  const ladder = Array.isArray(row.reasoningEfforts) ? row.reasoningEfforts as string[] : undefined;
  const defaultEffort = trimmed(record.defaultReasoningEffort);
  if (defaultEffort && ladder && ladder.length > 0 && ladder.includes(defaultEffort)) {
    row.defaultReasoningEffort = defaultEffort;
  } else {
    delete row.defaultReasoningEffort;
  }

  if (typeof record.codexToolMode === "string" && TOOL_MODES.has(record.codexToolMode)) {
    row.codexToolMode = record.codexToolMode;
  } else {
    delete row.codexToolMode;
  }

  const addedAt = trimmed(record.addedAt);
  if (addedAt) row.addedAt = addedAt;
  else delete row.addedAt;

  return row as unknown as OcxCustomModel;
}

export function salvageCustomModelsForLoad(value: unknown): CustomModelSalvageResult {
  if (value === undefined) {
    return { value: undefined, changed: false, droppedRows: 0, changedFields: 0 };
  }
  if (!Array.isArray(value)) {
    return { value: undefined, changed: true, droppedRows: 1, changedFields: 0 };
  }

  const result: OcxCustomModel[] = [];
  const ids = new Set<string>();
  let droppedRows = 0;
  let changedFields = 0;

  for (const entry of value) {
    if (!isPlainRecord(entry)) {
      droppedRows += 1;
      continue;
    }
    const row = salvageRow(entry);
    if (!row) {
      droppedRows += 1;
      continue;
    }
    if (ids.has(row.id)) {
      droppedRows += 1;
      continue;
    }
    ids.add(row.id);
    if (!sameJson(entry, row)) changedFields += 1;
    result.push(row);
  }

  const normalized = result.length > 0 ? result : undefined;
  return {
    value: normalized,
    changed: droppedRows > 0 || changedFields > 0 || !sameJson(value, normalized),
    droppedRows,
    changedFields,
  };
}

function invalid(field: string, detail: string): string {
  return `customModels.${field}: ${detail}`;
}

export function customModelsCandidateError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "customModels must be an array";
  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isPlainRecord(entry)) return invalid(String(index), "must be an object");
    for (const field of ["id", "provider", "modelId"] as const) {
      if (typeof entry[field] !== "string" || entry[field].length === 0 || entry[field] !== entry[field].trim()) {
        return invalid(`${index}.${field}`, "must be a non-empty trimmed string");
      }
    }
    if (entry.displayName !== undefined
      && (typeof entry.displayName !== "string"
        || entry.displayName.length === 0
        || entry.displayName !== entry.displayName.trim()
        || entry.displayName.includes("/"))) {
      return invalid(`${index}.displayName`, "must be a non-empty trimmed string without /");
    }
    if (entry.contextWindow !== undefined
      && (typeof entry.contextWindow !== "number"
        || !Number.isFinite(entry.contextWindow)
        || !Number.isInteger(entry.contextWindow)
        || entry.contextWindow <= 0)) {
      return invalid(`${index}.contextWindow`, "must be a positive integer");
    }
    if (entry.inputModalities !== undefined) {
      if (!Array.isArray(entry.inputModalities)) return invalid(`${index}.inputModalities`, "must be an array");
      for (const modality of entry.inputModalities) {
        if (typeof modality !== "string" || !INPUT_MODALITIES.has(modality)) {
          return invalid(`${index}.inputModalities`, "contains an unsupported modality");
        }
      }
    }
    let ladder: string[] | undefined;
    if (entry.reasoningEfforts !== undefined) {
      if (!Array.isArray(entry.reasoningEfforts)) return invalid(`${index}.reasoningEfforts`, "must be an array");
      for (const effort of entry.reasoningEfforts) {
        if (typeof effort !== "string" || !isDeclaredReasoningEffort(effort)) {
          return invalid(`${index}.reasoningEfforts`, "contains an unsupported effort");
        }
      }
      ladder = canonicalizeReasoningEfforts(entry.reasoningEfforts as string[]);
    }
    if (entry.defaultReasoningEffort !== undefined
      && (typeof entry.defaultReasoningEffort !== "string"
        || !ladder
        || ladder.length === 0
        || !ladder.includes(entry.defaultReasoningEffort))) {
      return invalid(`${index}.defaultReasoningEffort`, "must belong to a non-empty reasoningEfforts ladder");
    }
    if (entry.codexToolMode !== undefined
      && (typeof entry.codexToolMode !== "string" || !TOOL_MODES.has(entry.codexToolMode))) {
      return invalid(`${index}.codexToolMode`, "must be code_mode_only or shell");
    }
    if (entry.addedAt !== undefined
      && (typeof entry.addedAt !== "string" || entry.addedAt.length === 0 || entry.addedAt !== entry.addedAt.trim())) {
      return invalid(`${index}.addedAt`, "must be a non-empty trimmed string");
    }
    const id = entry.id as string;
    const slug = routedSlug(entry.provider as string, entry.modelId as string);
    if (ids.has(id)) return invalid(`${index}.id`, "duplicate id");
    if (slugs.has(slug)) return invalid(`${index}.modelId`, "duplicate routed identity");
    ids.add(id);
    slugs.add(slug);
  }
  return null;
}

export function knownCustomModelProjection(model: OcxCustomModel): OcxCustomModel {
  return {
    id: model.id,
    provider: model.provider,
    modelId: model.modelId,
    ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.inputModalities !== undefined ? { inputModalities: [...model.inputModalities] } : {}),
    ...(model.reasoningEfforts !== undefined ? { reasoningEfforts: [...model.reasoningEfforts] } : {}),
    ...(model.defaultReasoningEffort !== undefined ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    ...(model.codexToolMode !== undefined ? { codexToolMode: model.codexToolMode } : {}),
    ...(model.addedAt !== undefined ? { addedAt: model.addedAt } : {}),
  };
}

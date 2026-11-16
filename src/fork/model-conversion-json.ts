import { parseModelConversionJson } from "./model-conversion-response";

function container(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

function compatible(left: unknown, right: unknown, raw: unknown): boolean {
  return container(left) && container(right) && container(raw)
    && Array.isArray(left) === Array.isArray(right)
    && Array.isArray(left) === Array.isArray(raw)
    && (!Array.isArray(left) || left.length === (right as unknown[]).length);
}

export function overlayConvertedJson(json: string, original: unknown, converted: unknown): {
  text: string;
  metadata?: Record<string, unknown>;
} {
  const raw = parseModelConversionJson(json);
  if (!compatible(original, converted, raw)) throw new Error("Invalid conversion JSON");
  const rawRecord = raw as Record<string, unknown>;
  const metadata = !Array.isArray(raw) && Object.hasOwn(rawRecord, "metadata")
    && rawRecord.metadata !== null && typeof rawRecord.metadata === "object" && !Array.isArray(rawRecord.metadata)
    ? rawRecord.metadata as Record<string, unknown> : undefined;
  const pending: Array<{ raw: Record<string, unknown>; before: Record<string, unknown>; after: Record<string, unknown> }> = [{
    raw: raw as Record<string, unknown>, before: original as Record<string, unknown>, after: converted as Record<string, unknown>,
  }];
  while (pending.length) {
    const { raw: target, before, after } = pending.pop()!;
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) delete target[key];
    }
    for (const key of Object.keys(after)) {
      const oldValue = before[key];
      const newValue = after[key];
      if (Object.hasOwn(before, key) && Object.is(oldValue, newValue)) continue;
      const rawValue = target[key];
      if (compatible(oldValue, newValue, rawValue)) {
        pending.push({ raw: rawValue as Record<string, unknown>, before: oldValue as Record<string, unknown>, after: newValue as Record<string, unknown> });
      } else {
        Object.defineProperty(target, key, { value: newValue, enumerable: true, configurable: true, writable: true });
      }
    }
  }
  return { text: JSON.stringify(raw), ...(metadata === undefined ? {} : { metadata }) };
}

import type { ConversionProtocol } from "./model-conversion-request";
import { parseModelConversionJson } from "./model-conversion-response";

type Span = { start: number; end: number };
type InputEntry = { value: unknown; reasoning?: Span };
type Replacement = Span & { bytes: Uint8Array };
type RecordValue = Record<string, unknown>;

export type ScannedConversionJson = {
  bytes: Uint8Array;
  value: RecordValue;
  fields: Map<string, Span>;
  input: InputEntry[];
  closing: number;
  hasProperties: boolean;
  projectionBytes: number;
  metadata?: RecordValue;
};

export class ConversionScanFallback extends Error {}

const selected = new Set(["model", "type", "reasoning", "reasoning_effort", "service_tier", "metadata", "client_metadata", "system", "output_config", "thinking"]);
const projectionLimit = 1024 * 1024;
const itemLimit = 100_000;
const depthLimit = 128;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const streamSettled = new WeakMap<ReadableStream<Uint8Array>, Promise<void>>();
const streamLengths = new WeakMap<ReadableStream<Uint8Array>, number>();

function own(object: RecordValue, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class Scanner {
  index = 0;
  nodes = 0;
  projectionBytes = 0;

  constructor(readonly bytes: Uint8Array) {}

  fail(): never { throw new ConversionScanFallback(); }
  byte(): number { return this.bytes[this.index] ?? -1; }
  whitespace(): void {
    while (this.byte() === 32 || this.byte() === 9 || this.byte() === 10 || this.byte() === 13) this.index++;
  }
  string(): void {
    if (this.byte() !== 34) this.fail();
    this.index++;
    while (this.index < this.bytes.length) {
      const c = this.bytes[this.index++]!;
      if (c === 34) return;
      if (c < 32) this.fail();
      if (c === 92) {
        const next = this.bytes[this.index++];
        if (next === 117) {
          for (let j = 0; j < 4; j++) {
            const digit = this.bytes[this.index++];
            if (digit === undefined || !(digit >= 48 && digit <= 57 || digit >= 65 && digit <= 70 || digit >= 97 && digit <= 102)) this.fail();
          }
        } else if (next === undefined || ![34, 47, 92, 98, 102, 110, 114, 116].includes(next)) this.fail();
      } else if (c >= 128) {
        const n = c >= 194 && c <= 223 ? 1 : c >= 224 && c <= 239 ? 2 : c >= 240 && c <= 244 ? 3 : this.fail();
        const first = this.bytes[this.index];
        if (first === undefined || first < 128 || first > 191 || c === 224 && first < 160 || c === 237 && first > 159
          || c === 240 && first < 144 || c === 244 && first > 143) this.fail();
        for (let j = 0; j < n; j++) {
          const part = this.bytes[this.index++];
          if (part === undefined || part < 128 || part > 191) this.fail();
        }
      }
    }
    this.fail();
  }
  key(): string {
    const start = this.index;
    this.string();
    if (this.index - start > 4096) this.fail();
    return JSON.parse(decoder.decode(this.bytes.subarray(start, this.index))) as string;
  }
  number(): void {
    if (this.byte() === 45) this.index++;
    if (this.byte() === 48) this.index++;
    else {
      if (this.byte() < 49 || this.byte() > 57) this.fail();
      while (this.byte() >= 48 && this.byte() <= 57) this.index++;
    }
    if (this.byte() === 46) {
      this.index++;
      if (this.byte() < 48 || this.byte() > 57) this.fail();
      while (this.byte() >= 48 && this.byte() <= 57) this.index++;
    }
    if (this.byte() === 69 || this.byte() === 101) {
      this.index++;
      if (this.byte() === 43 || this.byte() === 45) this.index++;
      if (this.byte() < 48 || this.byte() > 57) this.fail();
      while (this.byte() >= 48 && this.byte() <= 57) this.index++;
    }
  }
  value(depth = 0): Span {
    if (depth > depthLimit || ++this.nodes > itemLimit * 20) this.fail();
    this.whitespace();
    const start = this.index;
    const c = this.byte();
    if (c === 34) this.string();
    else if (c === 123) {
      this.index++; this.whitespace();
      if (this.byte() !== 125) for (;;) {
        this.key(); this.whitespace();
        if (this.byte() !== 58) this.fail();
        this.index++; this.value(depth + 1); this.whitespace();
        if (this.byte() === 125) break;
        if (this.byte() !== 44) this.fail();
        this.index++; this.whitespace();
      }
      this.index++;
    } else if (c === 91) {
      this.index++; this.whitespace();
      if (this.byte() !== 93) for (;;) {
        this.value(depth + 1); this.whitespace();
        if (this.byte() === 93) break;
        if (this.byte() !== 44) this.fail();
        this.index++;
      }
      this.index++;
    } else if (c === 45 || c >= 48 && c <= 57) this.number();
    else {
      const literal = c === 116 ? "true" : c === 102 ? "false" : c === 110 ? "null" : this.fail();
      for (let j = 0; j < literal.length; j++) if (this.bytes[this.index++] !== literal.charCodeAt(j)) this.fail();
    }
    return { start, end: this.index };
  }
  parse(span: Span): unknown {
    if (span.end - span.start > projectionLimit) this.fail();
    this.projectionBytes += span.end - span.start;
    if (this.projectionBytes > 8 * projectionLimit) this.fail();
    return JSON.parse(decoder.decode(this.bytes.subarray(span.start, span.end)));
  }
  input(): { span: Span; entries: InputEntry[]; value: unknown } {
    this.whitespace();
    const start = this.index;
    if (this.byte() !== 91) {
      const span = this.value();
      return { span, entries: [], value: null };
    }
    this.index++; this.whitespace();
    const entries: InputEntry[] = [];
    if (this.byte() !== 93) for (;;) {
      if (entries.length >= itemLimit) this.fail();
      this.whitespace();
      if (this.byte() !== 123) {
        this.value(1); entries.push({ value: null });
      } else {
        this.index++; this.whitespace();
        let type: Span | undefined;
        let reasoning: Span | undefined;
        if (this.byte() !== 125) for (;;) {
          const key = this.key(); this.whitespace();
          if (this.byte() !== 58) this.fail();
          this.index++;
          const field = this.value(2);
          if (key === "type") type = field;
          if (key === "reasoning") reasoning = field;
          this.whitespace();
          if (this.byte() === 125) break;
          if (this.byte() !== 44) this.fail();
          this.index++; this.whitespace();
        }
        this.index++;
        const item: RecordValue = {};
        if (type) own(item, "type", this.parse(type));
        if (item.type === "configuration_update" && reasoning) own(item, "reasoning", this.parse(reasoning));
        entries.push({ value: item, ...(reasoning ? { reasoning } : {}) });
      }
      this.whitespace();
      if (this.byte() === 93) break;
      if (this.byte() !== 44) this.fail();
      this.index++;
    }
    this.index++;
    return { span: { start, end: this.index }, entries, value: entries.map(entry => entry.value) };
  }
}

export function scanConversionJson(bytes: Uint8Array, _protocol: ConversionProtocol): ScannedConversionJson {
  const scanner = new Scanner(bytes);
  scanner.whitespace();
  if (scanner.byte() !== 123) scanner.fail();
  scanner.index++; scanner.whitespace();
  const hasProperties = scanner.byte() !== 125;
  const value: RecordValue = {};
  const fields = new Map<string, Span>();
  let input: InputEntry[] = [];
  if (hasProperties) for (;;) {
    const key = scanner.key(); scanner.whitespace();
    if (scanner.byte() !== 58) scanner.fail();
    scanner.index++;
    if (key === "input") {
      const result = scanner.input();
      fields.set(key, result.span); own(value, key, result.value); input = result.entries;
    } else {
      const field = scanner.value(1);
      if (selected.has(key)) { fields.set(key, field); own(value, key, scanner.parse(field)); }
    }
    scanner.whitespace();
    if (scanner.byte() === 125) break;
    if (scanner.byte() !== 44) scanner.fail();
    scanner.index++; scanner.whitespace();
  }
  const closing = scanner.index++;
  scanner.whitespace();
  if (scanner.index !== bytes.length) scanner.fail();
  const metadataField = fields.get("metadata");
  const metadata = isRecord(value.metadata) && metadataField
    ? parseModelConversionJson(decoder.decode(bytes.subarray(metadataField.start, metadataField.end))) as RecordValue : undefined;
  return { bytes, value, fields, input, closing, hasProperties, projectionBytes: scanner.projectionBytes, ...(metadata === undefined ? {} : { metadata }) };
}

function replacement(span: Span, after: unknown): Replacement {
  const text = JSON.stringify(after);
  if (text === undefined) throw new ConversionScanFallback();
  return { ...span, bytes: encoder.encode(text) };
}

function replaceValue(
  bytes: Uint8Array,
  span: Span,
  before: unknown,
  after: unknown,
  field: string,
  replacements: Replacement[],
): void {
  if (!isRecord(before) || !isRecord(after)) {
    if (Array.isArray(before) && Array.isArray(after)) throw new ConversionScanFallback();
    replacements.push(replacement(span, after));
    return;
  }
  const allowed = field === "reasoning" || field === "output_config" ? "effort" : field === "thinking" ? "type" : undefined;
  if (!allowed) throw new ConversionScanFallback();
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) throw new ConversionScanFallback();
  const changed = Object.keys(after).filter(key => !Object.hasOwn(before, key) || !Object.is(before[key], after[key]));
  if (changed.some(key => key !== allowed)) throw new ConversionScanFallback();
  if (changed.length === 0) return;
  const scanner = new Scanner(bytes);
  scanner.index = span.start;
  if (scanner.byte() !== 123) scanner.fail();
  scanner.index++; scanner.whitespace();
  const hasProperties = scanner.byte() !== 125;
  let target: Span | undefined;
  if (hasProperties) for (;;) {
    const key = scanner.key(); scanner.whitespace();
    if (scanner.byte() !== 58) scanner.fail();
    scanner.index++;
    const value = scanner.value(1);
    if (key === allowed) target = value;
    scanner.whitespace();
    if (scanner.byte() === 125) break;
    if (scanner.byte() !== 44) scanner.fail();
    scanner.index++; scanner.whitespace();
  }
  const closing = scanner.index++;
  if (scanner.index !== span.end) scanner.fail();
  if (target) replacements.push(replacement(target, after[allowed]));
  else {
    const text = JSON.stringify(after[allowed]);
    if (text === undefined) throw new ConversionScanFallback();
    replacements.push({ start: closing, end: closing, bytes: encoder.encode(`${hasProperties ? "," : ""}${JSON.stringify(allowed)}:${text}`) });
  }
}

function conversionSpans(scan: ScannedConversionJson, converted: unknown): { replacements: Replacement[]; length: number } {
  if (!isRecord(converted)) throw new ConversionScanFallback();
  const replacements: Replacement[] = [];
  const added: string[] = [];
  for (const key of Object.keys(scan.value)) if (!Object.hasOwn(converted, key)) throw new ConversionScanFallback();
  for (const key of Object.keys(converted)) {
    if (Object.is(scan.value[key], converted[key])) continue;
    const span = scan.fields.get(key);
    if (!span) {
      const text = JSON.stringify(converted[key]);
      if (text === undefined) throw new ConversionScanFallback();
      added.push(`${JSON.stringify(key)}:${text}`); continue;
    }
    if (key === "input" && Array.isArray(scan.value.input) && Array.isArray(converted.input)) {
      if (scan.value.input.length !== converted.input.length) throw new ConversionScanFallback();
      for (let i = 0; i < scan.input.length; i++) {
        const before = scan.input[i]!;
        const after = converted.input[i];
        if (Object.is(before.value, after)) continue;
        if (!before.reasoning || !isRecord(before.value) || !isRecord(after) || !Object.hasOwn(after, "reasoning")) throw new ConversionScanFallback();
        for (const key of new Set([...Object.keys(before.value), ...Object.keys(after)])) {
          if (key !== "reasoning" && (!Object.hasOwn(before.value, key) || !Object.hasOwn(after, key) || !Object.is(before.value[key], after[key]))) {
            throw new ConversionScanFallback();
          }
        }
        replaceValue(scan.bytes, before.reasoning, before.value.reasoning, after.reasoning, "reasoning", replacements);
      }
    } else replaceValue(scan.bytes, span, scan.value[key], converted[key], key, replacements);
  }
  if (added.length) replacements.push({ start: scan.closing, end: scan.closing, bytes: encoder.encode(`${scan.hasProperties ? "," : ""}${added.join(",")}`) });
  replacements.sort((a, b) => a.start - b.start);
  let last = 0;
  for (const item of replacements) { if (item.start < last) throw new ConversionScanFallback(); last = item.end; }
  const length = replacements.reduce((total, item) => total + item.bytes.length - (item.end - item.start), scan.bytes.length);
  return { replacements, length };
}

export function applyConversionSpans(scan: ScannedConversionJson, converted: unknown): ReadableStream<Uint8Array> {
  const { replacements, length } = conversionSpans(scan, converted);
  return spanStream(scan.bytes, replacements, length);
}

export function applyConversionSpansText(scan: ScannedConversionJson, converted: unknown): string {
  const { replacements, length } = conversionSpans(scan, converted);
  const output = new Uint8Array(length);
  let sourceOffset = 0;
  let outputOffset = 0;
  for (const item of replacements) {
    const prefix = scan.bytes.subarray(sourceOffset, item.start);
    output.set(prefix, outputOffset);
    outputOffset += prefix.length;
    output.set(item.bytes, outputOffset);
    outputOffset += item.bytes.length;
    sourceOffset = item.end;
  }
  output.set(scan.bytes.subarray(sourceOffset), outputOffset);
  return decoder.decode(output);
}

function spanStream(bytes: Uint8Array, replacements: Replacement[], length: number): ReadableStream<Uint8Array> {
  let source: Uint8Array | undefined = bytes;
  bytes = new Uint8Array();
  let offset = 0;
  let next = 0;
  let finish!: () => void;
  const settled = new Promise<void>(resolve => { finish = resolve; });
  const done = () => { source = undefined; replacements.length = 0; finish(); };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!source) { controller.close(); return; }
      const item = replacements[next];
      const end = item?.start ?? source.length;
      if (offset < end) {
        const chunkEnd = Math.min(end, offset + 64 * 1024);
        controller.enqueue(new Uint8Array(source.subarray(offset, chunkEnd))); offset = chunkEnd;
      } else if (item) {
        controller.enqueue(item.bytes); offset = item.end; next++;
      }
      if (offset === source.length && next === replacements.length) { done(); controller.close(); }
    },
    cancel() { done(); },
  }, { highWaterMark: 0 });
  streamSettled.set(stream, settled);
  streamLengths.set(stream, length);
  return stream;
}

export function conversionStreamSettled(stream: ReadableStream<Uint8Array>): Promise<void> {
  return streamSettled.get(stream) ?? Promise.reject(new Error("Unknown conversion stream"));
}

export function conversionStreamByteLength(stream: ReadableStream<Uint8Array>): number {
  const length = streamLengths.get(stream);
  if (length === undefined) throw new Error("Unknown conversion stream");
  return length;
}

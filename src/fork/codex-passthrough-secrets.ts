import { SENSITIVE_KEY_PATTERN } from "../lib/redact";
import { readBoundedResponseBody, BOUNDED_BODY_MAX_BYTES, BOUNDED_BODY_TIMEOUT_MS } from "../lib/bounded-body";
import { TranslatorBudgetExceededError, type TranslatorBudget } from "../lib/translator-budget";
import type { CodexAuthContext } from "../codex/auth-context";
import { createOutboundCredentialMask } from "../server/responses/terminal-error-redaction";
import { createSseBlockBuffer, sseDataPayload, replaceSseDataPayload, type SseBlockRewrite } from "../server/sse-payload-rewrite";

export type PrivateCredentialSource = "caller" | "pool" | "stored-main" | "configuration";
export class CodexPrivateCredentialProtectionError extends Error {
  readonly code = "upstream_error_protection_failed";
  constructor() { super("Upstream error could not be delivered safely."); }
}
export interface CodexPrivateCredentialGuard {
  mask(text: string): string;
  protectHeaders(headers: Headers): Headers;
  protectJson(text: string): { changed: boolean; text: string };
  blockRewrite: SseBlockRewrite;
}

function credential(name: string, value: string): string {
  return /^(?:authorization|proxy-authorization)$/i.test(name) ? value.replace(/^\S+\s+/, "") : value;
}

export function codexPrivateCredentialSources(auth: CodexAuthContext | undefined, substituteMain: boolean,
  configuredHeaders: Record<string, string> | undefined): ReadonlyMap<string, PrivateCredentialSource> {
  const sources = new Map<string, PrivateCredentialSource>();
  for (const name of Object.keys(configuredHeaders ?? {})) sources.set(name.toLowerCase(), "configuration");
  if (auth?.kind === "pool") sources.set("authorization", "pool");
  else if (auth?.kind === "main-pool" || auth?.kind === "main" && substituteMain) sources.set("authorization", "stored-main");
  return sources;
}

export function codexPrivateProtectionFailure(): Response {
  return new Response(JSON.stringify({ error: { type: "upstream_error", code: "upstream_error_protection_failed",
    message: "Upstream error could not be delivered safely." } }), { status: 502, headers: { "content-type": "application/json" } });
}

export function createCodexPrivateCredentialGuard(input: {
  outboundHeaders: Headers | Readonly<Record<string, string>>; callerHeaders: Headers; sources: ReadonlyMap<string, PrivateCredentialSource>; translatorBudget: TranslatorBudget;
}): CodexPrivateCredentialGuard | undefined {
  const held = new Set([...input.callerHeaders].filter(([name]) => SENSITIVE_KEY_PATTERN.test(name)).map(([name, value]) => credential(name, value)));
  const privateHeaders: Record<string, string> = {};
  const wireHeaders = input.outboundHeaders instanceof Headers ? input.outboundHeaders : new Headers(input.outboundHeaders);
  const outbound = input.outboundHeaders instanceof Headers ? [...input.outboundHeaders] : Object.entries(input.outboundHeaders);
  for (const [name, rawValue] of outbound) {
    const source = input.sources.get(name.toLowerCase()) ?? input.sources.get(name);
    if (!source || source === "caller" || !SENSITIVE_KEY_PATTERN.test(name)
      || wireHeaders.get(name) === input.callerHeaders.get(name)) continue;
    const value = input.outboundHeaders instanceof Headers ? rawValue : new Headers([[name, rawValue]]).get(name)!;
    if (!value || held.has(credential(name, value))) continue;
    privateHeaders[name] = value;
  }
  if (!Object.keys(privateHeaders).length) return undefined;
  const literalMask = createOutboundCredentialMask(privateHeaders);
  const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const jsonEscapes: Record<string, string> = { '"': '\\"', "\\": "\\\\", "/": "\\/", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
  const encodedSecrets = new RegExp(Object.entries(privateHeaders).map(([name, value]) => credential(name, value))
    .sort((a, b) => b.length - a.length).map(secret => secret.split("").map(letter => {
      const unicode = letter.charCodeAt(0).toString(16).padStart(4, "0").replace(/[a-f]/g, hex => `[${hex}${hex.toUpperCase()}]`);
      return `(?:${escaped(letter)}|\\\\u${unicode}${jsonEscapes[letter] ? `|${escaped(jsonEscapes[letter]!)}` : ""})`;
    }).join("")).join("|"), "g");
  const mask = (text: string): string => literalMask(text).replace(encodedSecrets, "[REDACTED]");
  const protectJson = (text: string): { changed: boolean; text: string } => {
    let changed = false;
    try {
      JSON.parse(text);
      const safe = text.replace(/"(?:\\.|[^"\\])*"/g, token => {
        const decoded = JSON.parse(token) as string; const masked = literalMask(decoded);
        if (masked === decoded) return token; changed = true; return JSON.stringify(masked);
      });
      return { changed, text: safe };
    }
    catch { throw new CodexPrivateCredentialProtectionError(); }
  };
  const blockRewrite: SseBlockRewrite = block => {
    const payload = sseDataPayload(block);
    let safe = block;
    if (payload && payload !== "[DONE]") {
      const protectedJson = protectJson(payload);
      const record = JSON.parse(payload) as { type?: unknown; response?: { status?: unknown } } | null;
      const failed = record?.type === "error" || record?.type === "response.failed" || record?.type === "response.incomplete"
        || record?.type === "response.done" && record.response?.status !== "completed";
      if (failed && new TextEncoder().encode(block).byteLength > BOUNDED_BODY_MAX_BYTES) throw new CodexPrivateCredentialProtectionError();
      if (protectedJson.changed) safe = replaceSseDataPayload(block, protectedJson.text);
    }
    return [safe.split(/(\r\n|\r|\n)/).map(line => line.startsWith("data:") ? line : mask(line)).join("")];
  };
  return { mask, protectJson, blockRewrite, protectHeaders(headers) {
    const safe = new Headers(headers); for (const [name, value] of safe) {
      if (mask(name) !== name) throw new CodexPrivateCredentialProtectionError();
      const masked = mask(value); if (masked !== value) safe.set(name, masked);
    } return safe;
  } };
}

export async function readCodexPrivateErrorText(response: Response, guard: CodexPrivateCredentialGuard, signal?: AbortSignal): Promise<string> {
  try {
    const bounded = await readBoundedResponseBody(response, { signal, fatalUtf8: true });
    if (!bounded.displaySafe || bounded.truncated || bounded.oversized) throw new CodexPrivateCredentialProtectionError();
    return response.headers.get("content-type")?.toLowerCase().includes("json")
      ? guard.protectJson(bounded.text).text : guard.mask(bounded.text);
  } catch (error) { if (signal?.aborted) throw error; throw new CodexPrivateCredentialProtectionError(); }
}

export async function protectCodexPrivateSse(body: ReadableStream<Uint8Array>, guard: CodexPrivateCredentialGuard,
  budget: TranslatorBudget): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); const encoder = new TextEncoder();
  const buffer = createSseBlockBuffer(budget);
  const raw: Array<{ bytes: Uint8Array; end: number; release(): void }> = [];
  let received = 0; let verified = 0; let released = 0; let changed = false; let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: number | undefined = performance.now() + BOUNDED_BODY_TIMEOUT_MS;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; deadline = undefined; };
  const dispose = () => { clearTimer(); buffer.clear(); for (const chunk of raw) chunk.release(); raw.length = 0; };
  const releaseReader = () => { try { reader.releaseLock(); } catch { /* pending read */ } };
  const fail = (cause?: unknown) => {
    if (stopped) return; stopped = true; dispose();
    const error = cause ?? new CodexPrivateCredentialProtectionError(); controller.error(error);
    void reader.cancel(error).catch(() => {}); releaseReader();
  };
  const emitRaw = (end: number) => {
    while (raw.length && raw[0]!.end <= end) { const chunk = raw.shift()!; controller.enqueue(chunk.bytes); released = chunk.end; chunk.release(); }
  };
  const emitHeldPrefix = (end: number) => {
    let start = released;
    for (const chunk of raw) {
      if (start >= end) break;
      const length = Math.min(chunk.end, end) - start;
      if (length > 0) controller.enqueue(chunk.bytes.subarray(0, length));
      start = chunk.end;
    }
    for (const chunk of raw) chunk.release(); raw.length = 0;
  };
  const processBlock = (block: string, delimiter: string) => {
    const output = guard.blockRewrite(block)[0]!;
    if (!changed && output !== block) { emitHeldPrefix(verified); changed = true; }
    verified += encoder.encode(block + delimiter).byteLength;
    if (changed) { controller.enqueue(encoder.encode(output + delimiter)); released = verified; }
    else emitRaw(verified);
  };
  const protectedBody = new ReadableStream<Uint8Array>({
    start(value) { controller = value; timer = setTimeout(() => fail(), BOUNDED_BODY_TIMEOUT_MS); },
    async pull() {
      try {
        for (;;) {
          if (deadline !== undefined && performance.now() >= deadline) { fail(); return; }
          const next = await reader.read(); if (stopped) return;
          if (next.done) {
            buffer.append(decoder.decode());
            const tail = buffer.tail(); if (tail) processBlock(tail, ""); else emitRaw(received);
            stopped = true; dispose(); controller.close(); reader.releaseLock(); return;
          }
          if (next.value.byteLength === 0) continue;
          received += next.value.byteLength;
          if (!changed) {
            const reservation = budget.reserveTransient(next.value.byteLength, { kind: "retained_collectors" }); reservation.commitRetained();
            raw.push({ bytes: next.value, end: received, release: () => budget.releaseRetained(next.value.byteLength, { kind: "retained_collectors" }) });
          }
          buffer.append(decoder.decode(next.value, { stream: true }));
          const previousRelease = released;
          let block: { block: string; delimiter: string } | null;
          while ((block = buffer.next())) processBlock(block.block, block.delimiter);
          buffer.compact();
          if (released > 0 && received === verified && buffer.isEmpty()) clearTimer();
          else if (timer === undefined) { deadline = performance.now() + BOUNDED_BODY_TIMEOUT_MS; timer = setTimeout(() => fail(), BOUNDED_BODY_TIMEOUT_MS); }
          if (released > previousRelease) return;
        }
      } catch (error) {
        const safelyDelivered = buffer.isEmpty() && raw.length === 0
          && !(error instanceof CodexPrivateCredentialProtectionError) && !(error instanceof TranslatorBudgetExceededError);
        fail(safelyDelivered ? error : undefined);
      }
    },
    cancel(reason) { if (stopped) return; stopped = true; dispose(); void reader.cancel(reason).catch(() => {}); releaseReader(); },
  });
  const primed = protectedBody.getReader();
  let first: Awaited<ReturnType<typeof primed.read>>;
  try { first = await primed.read(); }
  catch (error) { await primed.cancel(error).catch(() => {}); primed.releaseLock(); throw error; }
  if (first.done) primed.releaseLock();
  return new ReadableStream<Uint8Array>({
    start(output) { if (first.done) output.close(); else output.enqueue(first.value); },
    async pull(output) { try { const next = await primed.read(); if (next.done) { output.close(); primed.releaseLock(); } else output.enqueue(next.value); }
      catch (error) { output.error(error); primed.releaseLock(); } },
    cancel(reason) { void primed.cancel(reason).finally(() => { try { primed.releaseLock(); } catch { /* pending read */ } }).catch(() => {}); },
  });
}

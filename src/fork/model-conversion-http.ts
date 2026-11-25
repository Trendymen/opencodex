import type { Server } from "bun";
import { codexCompatibleUrl } from "../codex/context-compat";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { resolveConcurrentInboundBodyLimitBytes } from "../lib/inbound-body-policy";
import { createTranslatorBudget, finalizeTranslatorBudgetResponse } from "../lib/translator-budget";
import { isAllowedRequestOrigin, requestPolicyView, resolveApiAuth, resolveResponsesApiAuth, withCors } from "../server/auth-cors";
import { createInboundBodyBudget, type InboundBodyBudget, type InboundBodyLease } from "../server/inbound-body-budget";
import { readBoundedJsonRequestBody, resolveInboundBodyLimitBytes } from "../server/request-decompress";
import { relaySseWithPayloadRewrite } from "../server/sse-payload-rewrite";
import type { OcxConfig } from "../types";
import type { ModelConversionRule } from "./model-conversion-config";
import { overlayConvertedJson } from "./model-conversion-json";
import { applyConversionSpans, ConversionScanFallback, conversionStreamByteLength, conversionStreamSettled, scanConversionJson } from "./model-conversion-json-scan";
import { readConversionBytes } from "./model-conversion-read";
import { convertModelRequest, type ConversionProtocol, type ConversionTurn } from "./model-conversion-request";
import { modelConversionTokenCount, parseModelConversionJson, restoreModelHeaders, restoreModelJsonPayload, type ModelConversionResponseContext } from "./model-conversion-response";

export type ModelConversionFetch<T> = (req: Request, server: Server<T>) => Response | undefined | Promise<Response | undefined>;
export type ModelConversionDeps = {
  config: () => OcxConfig;
  rules: ReadonlyMap<string, readonly ModelConversionRule[]>;
  getRules?: () => ReadonlyMap<string, readonly ModelConversionRule[]>;
  boundBodyLimit?: number;
  responseBodyLimit?: number;
  bodyBudget?: InboundBodyBudget;
};

const COPY_ALLOWANCE = 32;
const RESPONSE_COPY_ALLOWANCE = 8;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const convertedResponsePeers = new WeakMap<Request, string | null>();

export function convertedResponsePeerAddress(request: Request): string | null | undefined {
  return convertedResponsePeers.get(request);
}

const ROUTES = new Map<string, ConversionProtocol>([
  ["/v1/responses", "responses"],
  ["/v1/responses/compact", "compact"],
  ["/v1/chat/completions", "chat"],
  ["/v1/messages", "messages"],
  ["/v1/messages/count_tokens", "messages"],
]);

type Prepared =
  | { kind: "passthrough"; observed: number }
  | { kind: "reject"; observed: number; status: number; code: string }
  | { kind: "converted"; observed: number; retainedMetadata: number; body: string | ReadableStream<Uint8Array>; turn: ConversionTurn; context: ModelConversionResponseContext };

type BodyMonitor = { body: WeakRef<ReadableStream<Uint8Array>>; request?: WeakRef<Request>; used: boolean; resolve: () => void };
const monitoredBodies = new Set<BodyMonitor>();
let monitorTimer: ReturnType<typeof setInterval> | undefined;

function finishBodyMonitor(monitor: BodyMonitor): void {
  if (!monitoredBodies.delete(monitor)) return;
  monitor.resolve();
  if (monitoredBodies.size === 0 && monitorTimer) { clearInterval(monitorTimer); monitorTimer = undefined; }
}

function inspectBodyMonitor(monitor: BodyMonitor): void {
  const body = monitor.body.deref();
  if (!body) { finishBodyMonitor(monitor); return; }
  if (monitor.request?.deref()?.bodyUsed) monitor.used = true;
  if (!monitor.used) return;
  if (body.locked) return;
  try {
    const reader = body.getReader();
    const closed = reader.closed;
    const status = Bun.peek.status(closed);
    void closed.catch(() => {});
    reader.releaseLock();
    // Releasing a reader also rejects a pending closed promise on a readable stream.
    if (status !== "pending") finishBodyMonitor(monitor);
  } catch { /* The current reader retains ownership. */ }
}

function bodySettled(body: ReadableStream<Uint8Array> | null, request?: Request, used = false): Promise<void> {
  if (!body) return Promise.resolve();
  return new Promise(resolve => {
    const monitor = { body: new WeakRef(body), ...(request ? { request: new WeakRef(request) } : {}), used, resolve };
    monitoredBodies.add(monitor);
    inspectBodyMonitor(monitor);
    monitorTimer ??= setInterval(() => { for (const item of monitoredBodies) inspectBodyMonitor(item); }, 100);
    monitorTimer.unref?.();
  });
}

function requestBodySettled(request: Request): Promise<void> {
  return bodySettled(request.body, request, request.bodyUsed);
}

function responseFor(protocol: ConversionProtocol, status: number, code: string): Response {
  const message = code === "server_busy" ? "Model conversion capacity is currently unavailable."
      : code === "inbound_body_too_large" ? "Model conversion request exceeds the available body limit."
      : code === "invalid_request_error" ? "Invalid model conversion request."
        : "Model conversion response could not be safely processed.";
  const type = status === 503 ? (protocol === "messages" ? "overloaded_error" : "server_error")
    : status >= 500 ? (protocol === "messages" ? "api_error" : "server_error") : "invalid_request_error";
  return Response.json({ ...(protocol === "messages" ? { type: "error" } : {}), error: { type, code, message } }, {
    status, ...(status === 503 ? { headers: { "Retry-After": "1" } } : {}),
  });
}

function discard(body: ReadableStream<Uint8Array> | null, reason: unknown): Promise<void> {
  if (!body) return Promise.resolve();
  if (body.locked) return bodySettled(body, undefined, true);
  try { return body.cancel(reason).catch(() => {}); }
  catch { return bodySettled(body); }
}

function releaseBudgets(lease: InboundBodyLease, requestBudget: ReturnType<typeof createTranslatorBudget>, responseBudget: ReturnType<typeof createTranslatorBudget>): () => void {
  let released = false;
  return () => { if (!released) { released = true; requestBudget.dispose(); responseBudget.dispose(); lease.release(); } };
}

function shrinkWhenRead(lease: InboundBodyLease, requestBudget: ReturnType<typeof createTranslatorBudget>, bytes: number, settled: Promise<unknown>): void {
  void settled.then(() => { requestBudget.dispose(); lease.shrink(bytes); });
}

function trackResponseSource(response: Response): {
  response: Response;
  settled: Promise<void>;
  cancel(reason: unknown): Promise<void>;
} {
  if (!response.body) return { response, settled: Promise.resolve(), cancel: async () => {} };
  const reader = response.body.getReader();
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  let done = false;
  let cancelling: Promise<void> | undefined;
  const finish = () => {
    if (done) return;
    done = true;
    try { reader.releaseLock(); } finally { settle(); }
  };
  const cancel = (reason: unknown) => {
    if (done) return settled;
    cancelling ??= Promise.resolve().then(() => reader.cancel(reason)).catch(() => {}).finally(finish);
    return cancelling;
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (cancelling) return;
        if (result.done) { finish(); controller.close(); }
        else controller.enqueue(result.value);
      } catch (error) {
        if (cancelling) return;
        finish(); controller.error(error);
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), settled, cancel };
}

function retainLease(response: Response, signal: AbortSignal, release: () => void): Response {
  if (!response.body) { release(); return response; }
  const reader = response.body.getReader();
  let done = false;
  let cancelling: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (done) return;
    done = true;
    signal.removeEventListener("abort", abort);
    try { reader.releaseLock(); } finally { release(); }
  };
  const cancel = (reason: unknown) => {
    cancelling ??= Promise.resolve().then(() => reader.cancel(reason)).catch(() => {}).finally(finish);
    return cancelling;
  };
  const abort = () => { if (!done) { controller.error(signal.reason); void cancel(signal.reason); } };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    async pull(streamController) {
      try {
        const result = await reader.read();
        if (cancelling) return;
        if (result.done) { finish(); streamController.close(); }
        else streamController.enqueue(result.value);
      } catch (error) {
        if (cancelling) return;
        finish(); streamController.error(error);
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function countedClone(request: Request, observed: { wire: number }): Request {
  const clone = request.clone();
  if (!clone.body) return clone;
  const reader = clone.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else { observed.wire += next.value.byteLength; controller.enqueue(next.value); }
      } catch (error) { controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
  return new Request(clone.url, { method: clone.method, headers: clone.headers, body, signal: clone.signal });
}

async function prepareRequestLegacy(
  request: Request,
  protocol: ConversionProtocol,
  rules: readonly ModelConversionRule[],
  getConfig: () => OcxConfig,
  maxBytes: number,
  budget: ReturnType<typeof createTranslatorBudget>,
): Promise<Prepared> {
  const observed = { wire: 0 };
  let json = "";
  let textBytes = 0;
  let serializedBytes = 0;
  let releaseText: (() => void) | undefined;
  let body: unknown;
  try {
    body = await readBoundedJsonRequestBody(countedClone(request, observed), maxBytes, budget, {
      onDecodedJson(capture) {
        json = capture.jsonText;
        textBytes = capture.textBytes;
        serializedBytes = capture.serializedBytes;
        releaseText = capture.takeTextLease();
      },
    });
  } catch {
    return { kind: "passthrough", observed: Math.max(1, observed.wire * 2) };
  }
  const copies = () => Math.max(1, observed.wire * 2 + textBytes * 2 + serializedBytes * 4);
  try {
    const config = getConfig();
    const converted = convertModelRequest(body, rules, config, undefined, protocol);
    if (!converted.turn) return { kind: "passthrough", observed: copies() };
    const result = overlayConvertedJson(json, body, converted.value);
    const bytes = Buffer.byteLength(result.text, "utf8");
    if (bytes > maxBytes) return { kind: "reject", observed: copies(), status: 413, code: "inbound_body_too_large" };
    const turn = { ...converted.turn, ...(result.metadata === undefined ? {} : { clientMetadata: result.metadata }) };
    const context = converted.turn.clientMetadata === undefined ? {} : {
      coreClientMetadata: JSON.parse(JSON.stringify(converted.turn.clientMetadata)) as Record<string, unknown>,
    };
    const retainedMetadata = 2 * (result.metadata === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.metadata)))
      + 2 * (context.coreClientMetadata === undefined ? 0 : Buffer.byteLength(JSON.stringify(context.coreClientMetadata))) + 1024;
    return { kind: "converted", observed: Math.max(copies() + bytes, retainedMetadata), retainedMetadata, body: result.text, turn, context };
  } catch {
    return { kind: "reject", observed: copies(), status: 400, code: "invalid_request_error" };
  } finally {
    releaseText?.();
  }
}

async function prepareRequest(
  request: Request,
  protocol: ConversionProtocol,
  rules: readonly ModelConversionRule[],
  getConfig: () => OcxConfig,
  maxBytes: number,
  budget: ReturnType<typeof createTranslatorBudget>,
): Promise<Prepared> {
  const encoding = (request.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (encoding && encoding !== "identity") return prepareRequestLegacy(request, protocol, rules, getConfig, maxBytes, budget);
  const observed = { wire: 0 };
  let bytes: Uint8Array;
  try { bytes = await readConversionBytes(countedClone(request, observed), maxBytes); }
  catch { return { kind: "passthrough", observed: Math.max(1, observed.wire * 2) }; }
  try {
    const scan = scanConversionJson(bytes, protocol);
    const config = getConfig();
    const copies = () => Math.max(1, observed.wire * 2 + bytes.buffer.byteLength + scan.projectionBytes * 32 + scan.input.length * 128);
    if (copies() > maxBytes * COPY_ALLOWANCE) throw new ConversionScanFallback();
    const converted = convertModelRequest(scan.value, rules, config, undefined, protocol);
    if (!converted.turn) return { kind: "passthrough", observed: copies() };
    const body = applyConversionSpans(scan, converted.value);
    const length = conversionStreamByteLength(body);
    if (length > maxBytes) { void body.cancel(); return { kind: "reject", observed: copies(), status: 413, code: "inbound_body_too_large" }; }
    const turn = { ...converted.turn, ...(scan.metadata === undefined ? {} : { clientMetadata: scan.metadata }) };
    const context = converted.turn.clientMetadata === undefined ? {} : {
      coreClientMetadata: JSON.parse(JSON.stringify(converted.turn.clientMetadata)) as Record<string, unknown>,
    };
    const retainedMetadata = 2 * (scan.metadata === undefined ? 0 : Buffer.byteLength(JSON.stringify(scan.metadata)))
      + 2 * (context.coreClientMetadata === undefined ? 0 : Buffer.byteLength(JSON.stringify(context.coreClientMetadata))) + 1024;
    if (copies() + retainedMetadata > maxBytes * COPY_ALLOWANCE) { void body.cancel(); throw new ConversionScanFallback(); }
    budget.observeAcceptedRequestCopy(bytes.buffer.byteLength + scan.projectionBytes);
    return { kind: "converted", observed: Math.max(copies() + retainedMetadata, retainedMetadata), retainedMetadata,
      body, turn, context };
  } catch (error) {
    if (error instanceof ConversionScanFallback) {
      bytes = new Uint8Array();
      return prepareRequestLegacy(request, protocol, rules, getConfig, maxBytes, budget);
    }
    return { kind: "reject", observed: Math.max(1, observed.wire * 2 + bytes.buffer.byteLength), status: 400, code: "invalid_request_error" };
  }
}

async function restoreResponse(
  response: Response,
  request: Request,
  protocol: ConversionProtocol,
  turn: ConversionTurn,
  context: ModelConversionResponseContext,
  budget: ReturnType<typeof createTranslatorBudget>,
  responseLimit: number,
  countTokens: boolean,
): Promise<Response> {
  const headers = restoreModelHeaders(response.headers, turn, context);
  if (!response.body) { budget.dispose(); return new Response(null, { status: response.status, statusText: response.statusText, headers }); }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "text/event-stream") {
    const body = relaySseWithPayloadRewrite(response.body, payload => restoreModelJsonPayload(payload, turn, protocol, context), budget);
    return finalizeTranslatorBudgetResponse(new Response(body, { status: response.status, statusText: response.statusText, headers }), budget, request.signal);
  }
  if (contentType !== "application/json") {
    void discard(response.body, "unsupported model response");
    throw new Error("Unsupported response content type");
  }
  const read = await readBoundedResponseBytes(response, { maxBytes: responseLimit, signal: request.signal, inactivityTimeoutMs: 300_000 });
  if (read.oversized) throw new Error("Model response exceeded the limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
  let output: string;
  if (countTokens && response.ok) {
    const value = parseModelConversionJson(text);
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "input_tokens")) throw new Error("Invalid token count");
    const tokens = modelConversionTokenCount((value as Record<string, unknown>).input_tokens);
    if (tokens === undefined) throw new Error("Invalid token count");
    output = JSON.stringify({ input_tokens: tokens });
  } else output = restoreModelJsonPayload(text, turn, protocol, context);
  const outputBytes = Buffer.byteLength(output, "utf8");
  if (outputBytes > responseLimit) throw new Error("Model response exceeded the limit");
  budget.observeAcceptedRequestCopy(outputBytes);
  const body = new Response(output, { status: response.status, statusText: response.statusText, headers });
  return finalizeTranslatorBudgetResponse(body, budget, request.signal);
}

export function wrapModelConversionFetch<T>(original: ModelConversionFetch<T>, deps: ModelConversionDeps): ModelConversionFetch<T> {
  const configuredResponseLimit = deps.responseBodyLimit;
  const responseLimit = typeof configuredResponseLimit === "number" && Number.isSafeInteger(configuredResponseLimit)
    && configuredResponseLimit > 0 && configuredResponseLimit <= MAX_RESPONSE_BYTES ? configuredResponseLimit : MAX_RESPONSE_BYTES;
  const responseAllowance = responseLimit * RESPONSE_COPY_ALLOWANCE;
  const capacity = COPY_ALLOWANCE * resolveConcurrentInboundBodyLimitBytes(deps.config().maxConcurrentInboundBodyBytes) + 2 * responseAllowance;
  const pool = deps.bodyBudget ?? createInboundBodyBudget(capacity);
  return (request, server) => {
    const path = codexCompatibleUrl(request.url).pathname;
    const protocol = ROUTES.get(path);
    if (!protocol || request.method !== "POST" || request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return original.call(server, request, server);
    }
    const policy = requestPolicyView(deps.config(), "0.0.0.0");
    const admission = protocol === "messages" ? resolveApiAuth(request, policy) : resolveResponsesApiAuth(request, policy);
    const rules = admission?.kind === "configured" ? (deps.getRules?.() ?? deps.rules).get(admission.keyId) : undefined;
    if (admission?.kind !== "configured" || !rules?.length || !isAllowedRequestOrigin(request, policy)) return original.call(server, request, server);
    const responsePeer = protocol === "responses" ? server.requestIP?.(request)?.address ?? null : null;
    const sameAdmission = () => {
      const currentPolicy = requestPolicyView(deps.config(), "0.0.0.0");
      const current = protocol === "messages" ? resolveApiAuth(request, currentPolicy) : resolveResponsesApiAuth(request, currentPolicy);
      return current?.kind === "configured" && current.keyId === admission.keyId
        && current.contextPrincipalId === admission.contextPrincipalId && isAllowedRequestOrigin(request, currentPolicy);
    };
    return (async () => {
      const configuredLimit = resolveInboundBodyLimitBytes(deps.config().maxInboundBodyBytes);
      const bound = deps.boundBodyLimit;
      const maxBytes = typeof bound === "number" && Number.isSafeInteger(bound) && bound > 0
        ? Math.min(configuredLimit, bound) : configuredLimit;
      const requestAllowance = maxBytes * COPY_ALLOWANCE;
      const allowance = requestAllowance + responseAllowance;
      let lease: InboundBodyLease | null;
      try { lease = await pool.acquire(allowance, request.signal); }
      catch (error) {
        if (request.signal.aborted) throw error;
        return sameAdmission() ? withCors(responseFor(protocol, 503, "server_busy"), request, requestPolicyView(deps.config(), "0.0.0.0"))
          : original.call(server, request, server);
      }
      if (!lease) return sameAdmission() ? withCors(responseFor(protocol, 503, "server_busy"), request, requestPolicyView(deps.config(), "0.0.0.0"))
        : original.call(server, request, server);
      const requestBudget = createTranslatorBudget();
      const responseBudget = createTranslatorBudget({ maxTurnBytes: responseLimit });
      const release = releaseBudgets(lease, requestBudget, responseBudget);
      let cancellation: Promise<void> | undefined;
      let responseSettled = Promise.resolve();
      let rewrittenSettled = Promise.resolve();
      const passThrough = async () => {
        const settled = requestBodySettled(request);
        try { return await original.call(server, request, server); }
        finally { void settled.then(release); }
      };
      try {
        if (!sameAdmission()) { release(); return original.call(server, request, server); }
        let prepared: Prepared | undefined = await prepareRequest(request, protocol, rules, deps.config, maxBytes, requestBudget);
        if (prepared.observed > requestAllowance) {
          cancellation = discard(request.body, "model conversion capacity exceeded");
          return retainLease(withCors(responseFor(protocol, 413, "inbound_body_too_large"), request, policy), request.signal,
            () => { void cancellation!.finally(release); });
        }
        if (request.signal.aborted) throw request.signal.reason;
        if (!sameAdmission() || prepared.kind === "passthrough") { lease.shrink(prepared.observed); return passThrough(); }
        lease.shrink(prepared.observed + (prepared.kind === "converted" ? responseAllowance : 0));
        cancellation = discard(request.body, "model conversion");
        const releaseAfterCancel = () => { void Promise.allSettled([cancellation!, rewrittenSettled, responseSettled]).then(release); };
        if (prepared.kind === "reject") {
          const response = withCors(responseFor(protocol, prepared.status, prepared.code), request, policy);
          return retainLease(response, request.signal, releaseAfterCancel);
        }
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        const { turn, context, retainedMetadata } = prepared;
        let rewritten: Request | undefined = new Request(request.url, { method: request.method, headers, body: prepared.body, signal: request.signal });
        if (protocol === "responses") convertedResponsePeers.set(rewritten, responsePeer);
        const observedRequest = requestBodySettled(rewritten);
        rewrittenSettled = typeof prepared.body === "string" ? observedRequest
          : Promise.race([observedRequest, conversionStreamSettled(prepared.body)]);
        const responsePromise = original.call(server, rewritten, server);
        prepared = undefined;
        rewritten = undefined;
        shrinkWhenRead(lease, requestBudget, responseAllowance + retainedMetadata, Promise.all([cancellation, rewrittenSettled]));
        const response = await responsePromise;
        if (!response) { releaseAfterCancel(); return response; }
        const tracked = trackResponseSource(response);
        responseSettled = tracked.settled;
        let restored: Response;
        try { restored = await restoreResponse(tracked.response, request, protocol, turn, context, responseBudget, responseLimit, path === "/v1/messages/count_tokens"); }
        catch (error) {
          void tracked.cancel(error);
          if (request.signal.aborted) throw error;
          restored = withCors(responseFor(protocol, 502, "model_conversion_response_error"), request, policy);
        }
        return retainLease(restored, request.signal, releaseAfterCancel);
      } catch (error) {
        cancellation ??= discard(request.body, error);
        void Promise.allSettled([cancellation, rewrittenSettled, responseSettled]).then(release);
        throw error;
      }
    })();
  };
}

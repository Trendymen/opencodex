/**
 * Eager bounded single-reader SSE relay (#314 WP2) + createSseInspector
 * extraction locks. Fixtures follow the deterministic pull-count pattern from
 * devlog/_plan/260723_win_mem_safestream/020 — no wall-clock assertions except
 * via the injectable clock/short drain windows.
 */
import { describe, expect, test } from "bun:test";
import {
  adapterEofIncompleteFrame,
  createSseInspector,
  doneFrame,
  MAX_TAIL_ERROR_MESSAGE_CHARS,
} from "../src/server/relay";
import { relaySseEagerBounded, type EagerRelayHooks } from "../src/server/relay-eager";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import type { SseBlockRewrite } from "../src/server/sse-payload-rewrite";
import type { RequestLogContext } from "../src/server/request-log";
import { MAX_CLIENT_SSE_FRAME_BYTES } from "../src/server/sse-frame-buffer";

import { watchdogMs } from "./helpers/ci-watchdog";
const enc = new TextEncoder();

function sse(event: string): Uint8Array {
  return enc.encode(`data: ${event}\n\n`);
}

const COMPLETED = JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } });
const DELTA = JSON.stringify({ type: "response.output_text.delta", delta: "hi" });
const FAILED_EVENT_MARKER = "event: response.failed\ndata: ";

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function failedPayload(text: string): {
  type: string;
  response: {
    status: string;
    error: { code: string; message: string };
    incomplete_details?: unknown;
  };
} {
  const payload = text.split(FAILED_EVENT_MARKER)[1]?.split("\n")[0];
  if (!payload) throw new Error("missing response.failed payload");
  return JSON.parse(payload);
}

type Recorded = {
  terminals: Array<{ status: string; httpStatus?: number }>;
  completed: unknown[];
  cancels: number;
  dones: number;
  disposes: number;
  synthetics: string[];
};

function makeHooks(): { hooks: EagerRelayHooks; rec: Recorded; inspector: ReturnType<typeof createSseInspector> } {
  const rec: Recorded = { terminals: [], completed: [], cancels: 0, dones: 0, disposes: 0, synthetics: [] };
  const inspector = createSseInspector({
    onTerminal: (status, httpStatus) => rec.terminals.push({ status, httpStatus }),
    onCompletedResponse: r => rec.completed.push(r),
  });
  const hooks: EagerRelayHooks = {
    inspectChunk: c => inspector.feed(c),
    finishInspection: () => inspector.finish(),
    disposeInspection: () => { rec.disposes += 1; inspector.dispose(); },
    sawTerminal: () => inspector.reported(),
    onSynthetic: kind => rec.synthetics.push(kind),
    onClientCancel: () => { rec.cancels += 1; },
    onDone: () => { rec.dones += 1; },
  };
  return { hooks, rec, inspector };
}

/** Upstream with externally controlled chunk release + pull counting. */
function controlledUpstream(): {
  stream: ReadableStream<Uint8Array>;
  push: (chunk: Uint8Array) => void;
  close: () => void;
  fail: (err: Error) => void;
  pullCount: () => number;
} {
  let pulls = 0;
  const pending: Array<{ resolve: (r: ReadableStreamReadResult<Uint8Array>) => void }> = [];
  const queue: Array<{ kind: "chunk"; value: Uint8Array } | { kind: "close" } | { kind: "fail"; err: Error }> = [];
  const controllerQueue: Uint8Array[] = [];
  let closed = false;
  let failure: Error | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const flush = () => {
    if (!controllerRef) return;
    while (controllerQueue.length) controllerRef.enqueue(controllerQueue.shift()!);
    if (failure) { try { controllerRef.error(failure); } catch { /* done */ } return; }
    if (closed) { try { controllerRef.close(); } catch { /* done */ } }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controllerRef = controller; flush(); },
    pull() { pulls += 1; },
  }, { highWaterMark: 0 });
  return {
    stream,
    push: chunk => { controllerQueue.push(chunk); flush(); },
    close: () => { closed = true; flush(); },
    fail: err => { failure = err; flush(); },
    pullCount: () => pulls,
  };
}

async function settle(ms = 0): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
}

  describe("fork relay-eager block-rewrite flush", () => {
  test("neither relay races reads against a shared abort promise", async () => {
    // Retention shape, not behavior: racing every read against ONE never-settled
    // promise attaches a reaction per completed read and holds it until abort, so a
    // long stream retains O(chunk-count) callbacks. Both relays relay identically
    // either way, which is exactly why no behavioral assertion catches a regression
    // here — relay.ts already states the rule in prose at its own drain, and this
    // pins it for both files. The sanctioned shape is: cancel the reader on abort.
    const eager = await Bun.file(new URL("../src/server/relay-eager.ts", import.meta.url)).text();
    const relay = await Bun.file(new URL("../src/server/relay.ts", import.meta.url)).text();

    // Strip comments first: both files DESCRIBE the banned shape in prose, and the
    // rule is about the code, not the explanation of why the code avoids it.
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const [name, source] of [["relay-eager.ts", eager], ["relay.ts", relay]] as const) {
      const racesReads = /Promise\.race\(\s*\[\s*reader\.read\(\)/.test(stripComments(source));
      expect(`${name} races reads: ${racesReads}`).toBe(`${name} races reads: false`);
    }
    // And the eager producer must keep the reader-cancel wake-up that replaced it.
    expect(eager).toMatch(/reader\.cancel\(upstream\.signal\.reason\)/);
  });

  test("a terminal frame settling in the same tick as abort is still recorded", async () => {
    // Post-cancel drain: the terminal arrives, and the drain deadline aborts
    // upstream in the same tick. Honoring the signal before examining the settled
    // read discarded that frame, so the turn was accounted as a cancel instead of
    // the completion it actually reached.
    const up = controlledUpstream();
    const { hooks, rec } = makeHooks();
    const upstream = new AbortController();
    const relayed = relaySseEagerBounded(up.stream, upstream, hooks);
    const reading = readAll(relayed);

    up.push(sse(DELTA));
    await settle();
    // Enqueue the terminal and abort without yielding in between.
    up.push(enc.encode(`event: response.completed\ndata: ${COMPLETED}\n\n`));
    upstream.abort(new Error("drain window expired"));
    up.close();
    await reading;

    expect(rec.terminals.map(t => t.status)).toContain("completed");
  });

  test("rewrites complete blocks across fragmented chunks and flushes the tail at EOF", async () => {
    const up = controlledUpstream();
    const { hooks } = makeHooks();
    hooks.rewritePayload = (payload: string) => payload.replaceAll("image_gen__gen", "RESTORED");
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    const reading = readAll(relayed);

    const aliased = `data: {"type":"response.output_item.done","item":{"name":"image_gen__gen"}}\n\n`;
    // Fragment mid-block: the rewrite must wait for the complete SSE block.
    up.push(enc.encode(aliased.slice(0, 30)));
    await settle();
    up.push(enc.encode(aliased.slice(30)));
    up.push(enc.encode(`event: response.completed\ndata: ${COMPLETED}\n\n`));
    up.push(enc.encode(`data: {"type":"trailing-partial"`));
    up.close();

    const text = await reading;
    expect(text).toContain("RESTORED");
    expect(text).not.toContain("image_gen__gen");
    expect(text).toContain("response.completed");
    // The protocol terminal ends the client stream; bytes produced after it
    // belong to the gateway's retained connection and must not hold Codex open.
    expect(text).not.toContain("trailing-partial");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

test("flushes retained block-rewrite output at EOF", async () => {
    const up = controlledUpstream();
    const { hooks } = makeHooks();
    hooks.rewriteBlocks = Object.assign(
      (block: string): readonly string[] => block.includes('"type":"held"') ? [] : [block],
      { flush: (): readonly string[] => ['data: {"type":"flush"}'] },
    ) as SseBlockRewrite;
    const reading = readAll(relaySseEagerBounded(up.stream, new AbortController(), hooks));

    up.push(enc.encode('data: {"type":"held"}\n\n'));
    up.close();

    expect(await reading).toContain('data: {"type":"flush"}');
  });

  

test("flushes held block-rewrite output before its synthetic failed tail", async () => {
    const { hooks } = makeHooks();
    hooks.rewriteBlocks = Object.assign(
      (block: string): readonly string[] => block.includes('"type":"held"') ? [] : [block],
      { flush: (): readonly string[] => ['data: {"type":"flush"}'] },
    ) as SseBlockRewrite;
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);

    up.push(enc.encode('data: {"type":"held"}\n\n'));
    up.fail(new Error("socket reset"));
    const output = await readAll(relayed);

    expect(output.indexOf('"type":"flush"')).toBeLessThan(output.indexOf('"type":"response.failed"'));
  });

  
});

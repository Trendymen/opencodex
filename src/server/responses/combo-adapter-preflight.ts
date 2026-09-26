import type { AdapterEvent } from "../../types";
import { preflightAdapterEvents, type AdapterEventPreflight } from "../../adapters/run-turn-queue";

export const COMBO_PREFLIGHT_STALLED = Symbol("combo preflight stalled");
export const COMBO_PREFLIGHT_ABORTED = Symbol("combo preflight aborted");

export async function preflightComboAdapterEvents(
  source: AsyncIterable<AdapterEvent>,
  classifyFirstEvent: (event: AdapterEvent) => Extract<AdapterEvent, { type: "error" }> | undefined,
  signal: AbortSignal | undefined,
  stallTimeoutMs: number,
  stop: () => void,
): Promise<AdapterEventPreflight | typeof COMBO_PREFLIGHT_STALLED | typeof COMBO_PREFLIGHT_ABORTED> {
  const upstream = source[Symbol.asyncIterator]();
  let guarding = true;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try { void upstream.return?.().catch(() => undefined); } catch { /* Cleanup must not replace the preflight result. */ }
  };
  const guarded: AsyncIterator<AdapterEvent> = {
    next() {
      if (!guarding) return upstream.next();
      if (signal?.aborted) {
        stop();
        close();
        return Promise.reject(COMBO_PREFLIGHT_ABORTED);
      }
      return new Promise<IteratorResult<AdapterEvent>>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const fail = (reason: typeof COMBO_PREFLIGHT_STALLED | typeof COMBO_PREFLIGHT_ABORTED): void => {
          if (settled) return;
          settled = true;
          cleanup();
          stop();
          close();
          reject(reason);
        };
        const onAbort = (): void => fail(COMBO_PREFLIGHT_ABORTED);
        const timer = setTimeout(() => fail(COMBO_PREFLIGHT_STALLED), stallTimeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        if (settled) return;
        try {
          void upstream.next().then(
            result => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(result);
            },
            error => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(error);
            },
          );
        } catch (error) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(error);
          }
        }
      });
    },
    return(value) {
      guarding = false;
      if (closed) return Promise.resolve({ done: true, value: value as AdapterEvent });
      closed = true;
      return upstream.return?.(value) ?? Promise.resolve({ done: true, value: value as AdapterEvent });
    },
  };
  try {
    return await preflightAdapterEvents({ [Symbol.asyncIterator]: () => guarded }, classifyFirstEvent);
  } catch (error) {
    if (error === COMBO_PREFLIGHT_STALLED || error === COMBO_PREFLIGHT_ABORTED) return error;
    stop();
    close();
    throw error;
  } finally {
    guarding = false;
  }
}

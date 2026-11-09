import type { ResponsesSendBudget } from "./request-send-budget";
import { readDisplaySafeErrorText } from "./core-errors";
import { inheritAccountAutoPauseResponse } from "../../lib/account-auto-pause-response";

/** Dispose the failed exchange before projecting a refresh refusal or rethrowing its original error. */
export function createAutoPauseRefreshErrorMapper(
  response: Response,
  upstream: { abort(): void },
  cleanup: () => void,
  refusal: (error: unknown) => Response | undefined,
  cancelled: () => boolean,
  cancelledResponse: () => Response,
): (error: unknown) => { failed: Response } | undefined {
  return error => {
    const clientCancelled = cancelled();
    try { void response.body?.cancel().catch(() => {}); } catch { /* closed */ }
    cleanup();
    upstream.abort();
    const failed = clientCancelled ? cancelledResponse() : refusal(error);
    return failed ? { failed } : undefined;
  };
}

const moves = new WeakMap<object, number>();
/** One same-provider credential move, funded by the existing recovery owner. */
export async function recoverAutoPausedAccount<T>(options: {
  requestKey: object;
  remaining?: number;
  reserve: ResponsesSendBudget["reserveCredentialHop"];
  refresh: () => Promise<boolean>;
  /** Map a known refresh refusal; unknown errors still propagate after unused-hop cleanup. */
  mapRefreshError?: (error: unknown) => T | undefined;
  setPermit: (permit: ResponsesSendBudget["pendingHopPermit"]) => void;
} & ({ response: Response; signal: AbortSignal; refetch: (failure: Response) => Promise<T> }
  | { response?: undefined; signal?: AbortSignal; refetch: () => Promise<T> })): Promise<T | undefined> {
  const count = moves.get(options.requestKey) ?? 0;
  if (count >= 3 || options.remaining !== undefined && options.remaining <= 0 || options.response?.body?.locked) return;
  const hop = options.reserve("auth-recovery", "account-auto-pause", true);
  if (!hop.allowed) return;
  try {
    options.signal?.throwIfAborted();
    let refreshed: boolean;
    try { refreshed = await options.refresh(); }
    catch (error) {
      const failure = options.mapRefreshError?.(error);
      if (failure !== undefined) return failure;
      throw error;
    }
    if (!refreshed) return;
    options.signal?.throwIfAborted();
    if (!options.response) {
      moves.set(options.requestKey, count + 1);
      options.setPermit(hop.permit);
      return await options.refetch();
    }
    if (options.response.body?.locked) return;
    // Retain bounded terminal bytes and release the old lease before replacement admission.
    const text = await readDisplaySafeErrorText(options.response, options.signal, "");
    options.signal.throwIfAborted();
    const headers = new Headers(options.response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    const failure = inheritAccountAutoPauseResponse(options.response, new Response(text, {
      status: options.response.status, statusText: options.response.statusText, headers,
    }));
    moves.set(options.requestKey, count + 1);
    options.setPermit(hop.permit);
    return await options.refetch(failure);
  } finally {
    options.setPermit(undefined);
    hop.permit?.release();
  }
}

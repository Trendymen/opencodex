import type { ResponsesSendBudget } from "./request-send-budget";
import { readDisplaySafeErrorText } from "./core-errors";
import { inheritAccountAutoPauseResponse } from "../../lib/account-auto-pause-response";

const moves = new WeakMap<object, number>();
/** One same-provider credential move, funded by the existing recovery owner. */
export async function recoverAutoPausedAccount<T>(options: {
  requestKey: object;
  response: Response;
  signal: AbortSignal;
  remaining?: number;
  reserve: ResponsesSendBudget["reserveCredentialHop"];
  refresh: () => Promise<boolean>;
  refetch: (failure: Response) => Promise<T>;
  setPermit: (permit: ResponsesSendBudget["pendingHopPermit"]) => void;
}): Promise<T | undefined> {
  const count = moves.get(options.requestKey) ?? 0;
  if (count >= 3 || options.remaining !== undefined && options.remaining <= 0 || options.response.body?.locked) return;
  const hop = options.reserve("auth-recovery", "account-auto-pause", true);
  if (!hop.allowed) return;
  try {
    options.signal.throwIfAborted();
    if (!await options.refresh()) return;
    options.signal.throwIfAborted();
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

import { readBoundedResponseBytes } from "../lib/bounded-body";

export async function readConversionBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && declared.trim() !== "") {
    const length = Number(declared);
    if (Number.isFinite(length) && length >= 0 && length > limit) {
      const error = new Error("Request body too large");
      if (request.body && !request.body.locked) {
        try { void request.body.cancel(error).catch(() => {}); } catch {}
      }
      throw error;
    }
  }
  const result = await readBoundedResponseBytes(new Response(request.body), { maxBytes: limit, signal: request.signal });
  if (result.oversized) throw new Error("Request body too large");
  return result.bytes;
}

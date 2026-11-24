export const OMITTED_ENCRYPTED_CONTENT_TEXT = "[encrypted content omitted]";

/** A broad shape check for unknown encrypted slots. */
export function looksLikeUnknownOpaqueSlot(payload: string): boolean {
  return payload.length >= 64 && /^[A-Za-z0-9+/=_-]+$/.test(payload);
}

/** This token-shape check does not establish ciphertext authenticity. */
export function backendTaskCiphertextRuns(payload: string): string[] {
  return payload.match(/gAAAA[A-Za-z0-9+/=_-]{59,}/g)
    ?.filter(looksLikeUnknownOpaqueSlot) ?? [];
}

export function isBackendTaskCiphertext(payload: string): boolean {
  const runs = backendTaskCiphertextRuns(payload);
  return runs.length === 1 && runs[0] === payload;
}

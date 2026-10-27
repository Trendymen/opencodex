/** Ark quota presentation compatibility for the relay fork. */

export type ArkQuotaClientError = Readonly<{
  body: string;
  status: 400;
}>;

/**
 * Codex Desktop reserves HTTP 429 for the logged-in ChatGPT account quota UI.
 * Keep Ark's independent quota window in the App by rendering it as a client
 * error, only when the vendor's own body clearly describes usage exhaustion.
 */
export function arkQuotaClientError(bodyText: string): ArkQuotaClientError | undefined {
  try {
    const payload = JSON.parse(bodyText) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const error = (payload as { error?: unknown }).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
    const record = error as { message?: unknown; code?: unknown };
    const message = record.message;
    if (typeof message !== "string" || message.trim().length === 0) return undefined;
    const normalizedMessage = message.trim();
    if (record.code === "usage_limit_reached") return undefined;
    if (!/^You have exceeded the(?: (?:\d+-hour|weekly))? usage (?:quota|limit)\.\s+It will reset at \d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\s*\+0800\s*CST\./i.test(normalizedMessage)) {
      return undefined;
    }
    return {
      body: JSON.stringify({
        error: {
          message,
          type: "invalid_request_error",
          code: "volcengine_usage_quota_exhausted",
        },
      }),
      status: 400,
    };
  } catch {
    return undefined;
  }
}

export function rendersArkQuotaAsClientError(providerName: string): boolean {
  return providerName === "volcengine-agent-plan";
}

import { describe, expect, test } from "bun:test";
import { formatErrorResponse } from "../src/bridge";
import {
  DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC,
  resolveClientRetryAfter,
} from "../src/lib/retry-after";
import { formatPassthroughUpstreamError } from "../src/server/responses/passthrough-error";
import { consumeComboFailure } from "../src/server/responses/core";

describe("fork Ark quota error rendering", () => {
test("renders an Ark permanent usage quota as non-retryable client error", async () => {
  const message = "You have exceeded the 5-hour usage quota. It will reset at 2026-08-27 14:49:40 +0800 CST. Request id: 0217878012954335f505d6745d4b07a5efbd0dd2f16cfcb68c210";
  const response = formatPassthroughUpstreamError(429, JSON.stringify({
    error: { message, code: "QuotaExhausted" },
  }), {
    headers: new Headers({ "retry-after": "120", "content-type": "application/json" }),
    renderQuotaAsClientError: true,
  });
  expect(response.status).toBe(400);
  expect(response.headers.get("Retry-After")).toBeNull();
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toEqual({
    error: {
      message,
      type: "invalid_request_error",
      code: "volcengine_usage_quota_exhausted",
    },
  });
});


});

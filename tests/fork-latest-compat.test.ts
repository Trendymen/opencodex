import { describe, expect, test } from "bun:test";
import { arkQuotaClientError, rendersArkQuotaAsClientError } from "../src/fork/ark-quota-display";
import { functionCallOutputText } from "../src/fork/custom-tool-output";

describe("latest relay compatibility extractions", () => {
  test("stringifies custom tool outputs without losing text, refusal, null, or opaque data", () => {
    expect(functionCallOutputText("plain")).toBe("plain");
    expect(functionCallOutputText([
      { type: "input_text", text: "first" },
      { type: "refusal", refusal: "denied" },
      { type: "input_text", text: "last" },
    ])).toBe("first\ndenied\nlast");
    expect(functionCallOutputText(null)).toBe("null");
    expect(functionCallOutputText([{ type: "image", image_url: "opaque" }])).toBe(
      JSON.stringify([{ type: "image", image_url: "opaque" }]),
    );
  });

  test("maps only an Ark usage quota body into a non-retryable client error", () => {
    const originalMessage = "  You have exceeded the 5-hour usage quota. It will reset at 2026-08-27 14:49:40 +0800 CST. Request id: 0217878012954335f505d6745d4b07a5efbd0dd2f16cfcb68c210  ";
    expect(arkQuotaClientError(JSON.stringify({ error: { message: originalMessage, code: "QuotaExhausted" } }))).toEqual({
      status: 400,
      body: JSON.stringify({
        error: {
          message: originalMessage,
          type: "invalid_request_error",
          code: "volcengine_usage_quota_exhausted",
        },
      }),
    });
    expect(arkQuotaClientError(JSON.stringify({ error: { message: "vendor overloaded" } }))).toBeUndefined();
    expect(arkQuotaClientError(JSON.stringify({
      error: { code: "usage_limit_reached", message: "Your usage limit has been reached" },
    }))).toBeUndefined();
    expect(rendersArkQuotaAsClientError("volcengine-agent-plan")).toBe(true);
    expect(rendersArkQuotaAsClientError("another-provider")).toBe(false);
  });
});

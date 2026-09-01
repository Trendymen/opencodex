import { describe, expect, test } from "bun:test";
import {
  arkQuotaClientError,
  rendersArkQuotaAsClientError,
} from "../src/fork/ark-quota-display";

const reset = "It will reset at 2026-09-08 10:00:00 +0800 CST.";

function body(message: string, code = "QuotaExhausted"): string {
  return JSON.stringify({ error: { message, code } });
}

describe("Fork Ark weekly quota compatibility", () => {
  test("accepts no-window, numeric-hour, and weekly quota forms", () => {
    for (const prefix of [
      "You have exceeded the usage quota.",
      "You have exceeded the 5-hour usage quota.",
      "You have exceeded the weekly usage quota.",
    ]) {
      const message = `${prefix} ${reset} Request id: redacted`;
      expect(arkQuotaClientError(body(message))).toEqual({
        status: 400,
        body: JSON.stringify({
          error: {
            message,
            type: "invalid_request_error",
            code: "volcengine_usage_quota_exhausted",
          },
        }),
      });
    }
  });

  test("keeps the accepted window vocabulary closed", () => {
    for (const window of ["monthly", "week", "rolling-weekly"]) {
      expect(arkQuotaClientError(body(
        `You have exceeded the ${window} usage quota. ${reset}`,
      ))).toBeUndefined();
    }
  });

  test("requires the strict reset timestamp and timezone", () => {
    for (const message of [
      "You have exceeded the weekly usage quota. It will reset tomorrow.",
      "You have exceeded the weekly usage quota. It will reset at 2026-09-08 10:00:00 UTC.",
      "You have exceeded the weekly usage quota. It will reset at 2026-09-08 10:00:00 +0800.",
    ]) {
      expect(arkQuotaClientError(body(message))).toBeUndefined();
    }
  });

  test("does not remap malformed, legacy ChatGPT, or ordinary overload errors", () => {
    expect(arkQuotaClientError("not-json")).toBeUndefined();
    expect(arkQuotaClientError(body("Your usage limit has been reached", "usage_limit_reached")))
      .toBeUndefined();
    expect(arkQuotaClientError(body("vendor overloaded"))).toBeUndefined();
  });

  test("keeps quota rendering scoped to the Volcengine Agent Plan provider", () => {
    expect(rendersArkQuotaAsClientError("volcengine-agent-plan")).toBe(true);
    expect(rendersArkQuotaAsClientError("another-provider")).toBe(false);
  });
});

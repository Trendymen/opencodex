import { describe, expect, test } from "bun:test";
import {
  createReasoningSummaryChannelPayloadRewrite,
  routeUsesContentChannelReasoning,
  rewriteReasoningSummaryInJson,
  rewriteReasoningSummaryInJsonString,
} from "../src/server/responses-reasoning-summary-rewrite";

const rewrite = createReasoningSummaryChannelPayloadRewrite();

function apply(payload: unknown): unknown {
  return JSON.parse(rewrite(JSON.stringify(payload)));
}

describe("fork reasoning summary upstream preservation", () => {
  const blobItem = {
      type: "reasoning",
      id: "rs_1",
      status: "completed",
      encrypted_content: "gAAAAAB-upstream-issued-blob",
      content: [{ type: "reasoning_text", text: "thinking" }],
      summary: [],
    };
  const payload0 = { type: "response.output_item.done", output_index: 0, item: blobItem };
  test("preserve an upstream summary when opaque state also carries raw content", () => {
        const item = {
          ...blobItem,
          summary: [{ type: "summary_text", text: "upstream summary" }],
        };
        const payload = { type: "response.output_item.done", output_index: 0, item };
        expect(apply(payload)).toEqual(payload);
      });

});

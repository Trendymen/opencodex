import { describe, expect, test } from "bun:test";
import { rewriteRoutedCustomToolsForUpstream } from "../../src/responses/custom-tool-compat";

describe("fork custom tool output lowering", () => {
  test("lowers custom output content parts to the function_call_output string wire", () => {
    const tools = [{ type: "custom", name: "exec", description: "Run", format: { type: "text" } }];
    const rewritten = rewriteRoutedCustomToolsForUpstream({
      tools,
      input: [
        { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "1 + 1" },
        {
          type: "custom_tool_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "completed" },
            { type: "refusal", refusal: "policy denied" },
            { type: "input_text", text: "last" },
          ],
        },
      ],
    });
    const body = rewritten.body as { input: Array<Record<string, unknown>> };
    expect(body.input[1]).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
      output: "completed\npolicy denied\nlast",
    });
    const samples: Array<[unknown, string]> = [
      ["plain", "plain"],
      [null, "null"],
      [[{ type: "image", image_url: "opaque" }], JSON.stringify([{ type: "image", image_url: "opaque" }])],
    ];
    for (const [output, expected] of samples) {
      const result = rewriteRoutedCustomToolsForUpstream({
        tools,
        input: [
          { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "1 + 1" },
          { type: "custom_tool_call_output", call_id: "call_1", output },
        ],
      });
      expect((result.body as { input: Array<Record<string, unknown>> }).input[1]).toMatchObject({
        type: "function_call_output", call_id: "call_1", output: expected,
      });
    }
  });
});

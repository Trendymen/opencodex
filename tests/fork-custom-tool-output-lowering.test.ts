import { describe, expect, test } from "bun:test";
import { rewriteRoutedCustomToolsForUpstream } from "../src/responses/custom-tool-compat";

function convertedInputDescription(name: string): string | undefined {
  const result = rewriteRoutedCustomToolsForUpstream({
    tools: [{ type: "custom", name, description: "client tool", format: { type: "text" } }],
  });
  const body = result.body as {
    tools?: Array<{
      parameters?: { properties?: { input?: { description?: string } } };
    }>;
  };
  return body.tools?.[0]?.parameters?.properties?.input?.description;
}

describe("fork custom tool output lowering", () => {
  
  test("lowers custom output content parts to the function_call_output string wire", () => {
    const rewritten = rewriteRoutedCustomToolsForUpstream({
      tools: [{ type: "custom", name: "exec", description: "Run", format: { type: "text" } }],
      input: [
        { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "1 + 1" },
        {
          type: "custom_tool_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "completed" },
            { type: "refusal", refusal: "policy denied" },
          ],
        },
      ],
    });
    const body = rewritten.body as { input: Array<Record<string, unknown>> };
    expect(body.input[1]).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
      output: "completed\npolicy denied",
    });
  });

});

import { describe, expect, test } from "bun:test";
import { chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { parseRequest } from "../../src/responses/parser";

// Issue #4503 coverage note: the Pi/Anthropic rows in the image-parts group in chat-completions-endpoint.test.ts
// reach the shared userContentToBlocks helper through the user branch only, so a
// regression confined to the role:"tool" branch — the tool_call_id gate, the
// input_image presence check, or the input_text/input_image filter that decides
// between structured output and a flattened string — would survive the suite. Feed
// the same foreign shapes through a direct tool envelope so the branch itself is
// under test rather than covered by composition.
describe("chatCompletionsToResponsesBody tool-result image parts", () => {
  test.each([
    { part: { type: "image", data: "aGVsbG8=", mimeType: "image/png" }, expected: { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" } },
    { part: { type: "image", data: "aGVsbG8=", mediaType: "image/jpeg" }, expected: { type: "input_image", image_url: "data:image/jpeg;base64,aGVsbG8=" } },
    { part: { type: "image", data: "data:image/webp;base64,aGVsbG8=", mimeType: "image/png" }, expected: { type: "input_image", image_url: "data:image/webp;base64,aGVsbG8=" } },
    { part: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" } }, expected: { type: "input_image", image_url: "data:image/jpeg;base64,aGVsbG8=" } },
    { part: { type: "image", source: { type: "url", url: "https://example.com/claude.png" } }, expected: { type: "input_image", image_url: "https://example.com/claude.png" } },
  ])("normalizes a non-OpenAI image part inside a direct tool result: %j", ({ part, expected }) => {
    const body = chatCompletionsToResponsesBody({
      model: "mock/test-model",
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_shot", type: "function", function: { name: "screenshot", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_shot", content: [
          { type: "text", text: "captured" },
          part,
        ] },
      ],
    });
    expect(body.input).toEqual([
      { type: "function_call", call_id: "call_shot", name: "screenshot", arguments: "{}" },
      { type: "function_call_output", call_id: "call_shot", output: [
        { type: "input_text", text: "captured" },
        expected,
      ] },
    ]);
    // The endpoint replays this body verbatim, so a shape parseRequest rejects
    // would surface as a 500 on a well-formed client request.
    expect(() => parseRequest(body)).not.toThrow();
  });
});

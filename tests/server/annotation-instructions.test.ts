import { describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses/core";
import { rewriteAnnotationInstructionsInPlace } from "../../src/server/responses/annotation-instructions";
import type { OcxConfig } from "../../src/types";

/**
 * The desktop client injects this block as a user message ahead of the annotation selections. Its
 * examples wrap the directive in backticks, which is the shape models copy and the client then
 * renders as literal code instead of a chip. The copy below is the client's own text, taken from a
 * session: it is the fixture the rewrite has to recognize, so a client that rewords the block shows
 * up as a mismatch instead of passing silently.
 */
const TICK = "`";
const CLIENT_BLOCK = [
  "# Response annotations:",
  "Each item contains text selected from an earlier Codex response and may include a user comment."
    + " Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as"
    + " context and address every comment. For every annotation you address, include its inline"
    + " directive " + TICK + ':codex-annotation{index="N"}' + TICK + ", where N is its one-based"
    + " array position (for example, " + TICK + ':codex-annotation{index="1"}' + TICK
    + "). Do not use unstructured annotation labels.",
].join("\n");

/** The block plus the parts that have to survive the rewrite: the selections and the request. */
const messageText = (block: string): string => "\n" + block
  + "\n<response-annotations>\n"
  + '[{"text":"问题出在客户端","source":{"messageId":"m1","startOffset":2,"endOffset":9}}]\n'
  + "</response-annotations>\n\n## My request:\n不如说初中模型对客户端展示规则的理解吧？\n";

const userMessage = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

/** The smallest upstream stream the passthrough forwards, so the request itself is the subject. */
const upstreamSse = [
  { type: "response.created", response: { id: "resp_annotation", status: "in_progress", output: [] } },
  { type: "response.completed", response: { id: "resp_annotation", status: "completed", output: [] } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");

const textOf = (input: { content: { text?: string }[] }[]): string => input[0].content[0].text ?? "";

describe("annotation instruction rewrite", () => {
  test("the request path rewrites what a native passthrough sends upstream", async () => {
    // The rewrite sits before parseRequest so that every consumer sees it, and the passthrough is
    // the consumer that never parses: it serializes the same raw body. This drives one request
    // through the handler and reads what went out.
    const originalFetch = globalThis.fetch;
    let upstreamBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = typeof init?.body === "string" ? init.body : "";
      return new Response(upstreamSse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const config = {
        defaultProvider: "passthrough",
        providers: {
          passthrough: {
            adapter: "openai-responses",
            baseUrl: "https://passthrough.example.test/v1",
            authMode: "key",
            apiKey: "test-key",
          },
        },
      } as OcxConfig;
      const text = messageText(CLIENT_BLOCK);
      const response = await handleResponses(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "passthrough-model", input: [userMessage(text)], stream: true }),
        }),
        config,
        { model: "", provider: "" },
        { abortSignal: AbortSignal.timeout(5_000) },
      );
      await response.text();

      expect(response.status).toBe(200);
      expect(upstreamBody).toContain("Write it as bare, unescaped text");
      expect(upstreamBody).not.toContain("unquoted directive");
      const sent = JSON.parse(upstreamBody) as { input: { content: { text?: string }[] }[] };
      const sentText = sent.input
        .flatMap(item => item.content ?? [])
        .map(part => part.text ?? "")
        .find(value => value.includes("<response-annotations>"));
      expect(sentText).toBeDefined();
      expect(sentText!.slice(sentText!.indexOf("<response-annotations>")))
        .toBe(text.slice(text.indexOf("<response-annotations>")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the client's block is replaced and the rest of the message is byte-identical", () => {
    const text = messageText(CLIENT_BLOCK);
    const input = [userMessage(text)];
    expect(rewriteAnnotationInstructionsInPlace(input)).toEqual({ rewritten: 1, unrecognized: 0 });
    const rewritten = textOf(input);
    // The selections are the model's evidence and the request is what it has to answer: both the
    // offsets into the quoted response and the user's own words have to arrive untouched.
    expect(rewritten.slice(rewritten.indexOf("<response-annotations>")))
      .toBe(text.slice(text.indexOf("<response-annotations>")));
  });

  test("the replacement asks for a bare directive and its example is bare", () => {
    const input = [userMessage(messageText(CLIENT_BLOCK))];
    rewriteAnnotationInstructionsInPlace(input);
    const rewritten = textOf(input);
    expect(rewritten).toContain('include its inline directive :codex-annotation{index="N"}');
    expect(rewritten).toContain("Write it as bare, unescaped text");
    // Nothing in the instruction block stays backticked: the example is the part a model copies.
    expect(rewritten.slice(0, rewritten.indexOf("<response-annotations>"))).not.toContain(TICK);
  });

  test("a second pass is a no-op, including the mismatch counter", () => {
    const input = [userMessage(messageText(CLIENT_BLOCK))];
    rewriteAnnotationInstructionsInPlace(input);
    const once = textOf(input);
    expect(rewriteAnnotationInstructionsInPlace(input)).toEqual({ rewritten: 0, unrecognized: 0 });
    expect(textOf(input)).toBe(once);
  });

  test("a wording this module does not know is left alone and reported", () => {
    const text = messageText("# Response annotations:\nReworded by a newer client.");
    const input = [userMessage(text)];
    expect(rewriteAnnotationInstructionsInPlace(input)).toEqual({ rewritten: 0, unrecognized: 1 });
    expect(textOf(input)).toBe(text);
  });

  test("a request without the block reports nothing", () => {
    const input = [userMessage("just a normal question")];
    expect(rewriteAnnotationInstructionsInPlace(input)).toEqual({ rewritten: 0, unrecognized: 0 });
    expect(textOf(input)).toBe("just a normal question");
  });

  test("assistant text and non-text parts are never touched", () => {
    const assistant = { type: "message", role: "assistant", content: [{ type: "output_text", text: messageText(CLIENT_BLOCK) }] };
    const userOutput = { type: "message", role: "user", content: [{ type: "output_text", text: messageText(CLIENT_BLOCK) }] };
    const input = [assistant, userOutput];
    expect(rewriteAnnotationInstructionsInPlace(input)).toEqual({ rewritten: 0, unrecognized: 0 });
    expect(input[0].content[0].text).toContain(CLIENT_BLOCK);
    expect(input[1].content[0].text).toContain(CLIENT_BLOCK);
  });

  test("the block is found in a later part of a multi-part message", () => {
    const input = [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "preamble" },
        { type: "input_text", text: messageText(CLIENT_BLOCK) },
      ],
    }];
    expect(rewriteAnnotationInstructionsInPlace(input)).toEqual({ rewritten: 1, unrecognized: 0 });
    expect(input[0].content[0].text).toBe("preamble");
    expect(input[0].content[1].text).toContain("Write it as bare, unescaped text");
  });

  test("a body without an input array is not a crash", () => {
    expect(rewriteAnnotationInstructionsInPlace(undefined)).toEqual({ rewritten: 0, unrecognized: 0 });
    expect(rewriteAnnotationInstructionsInPlace("input as a string")).toEqual({ rewritten: 0, unrecognized: 0 });
    expect(rewriteAnnotationInstructionsInPlace([null, 7, "text"])).toEqual({ rewritten: 0, unrecognized: 0 });
  });
});

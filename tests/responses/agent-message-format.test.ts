import { expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { parseRequest } from "../../src/responses/parser";
import type { OcxProviderConfig } from "../../src/types";

const provider = (overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig => ({
  adapter: "openai-responses",
  baseUrl: "https://gateway.example.test/v1",
  authMode: "key",
  apiKey: "synthetic-key",
  ...overrides,
});

const structuredContent = [
  { type: "input_text", text: "Child result" },
  { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
  { type: "input_file", filename: "assignment.txt", file_data: "data:text/plain;base64,SGVsbG8=" },
];

function body(model: string, content: unknown) {
  return {
    model,
    stream: true,
    input: [{
      type: "agent_message",
      id: "amsg_fixture",
      author: "/root/reader",
      recipient: "/root/checker",
      content,
    }],
  };
}

async function buildWire(
  raw: ReturnType<typeof body>,
  upstream: OcxProviderConfig,
  resolvedModelId?: string,
) {
  const parsed = parseRequest(raw);
  if (resolvedModelId !== undefined) {
    parsed.modelId = resolvedModelId;
    parsed._rawBody = { ...raw, model: resolvedModelId };
  }
  const budget = createTranslatorBudget();
  try {
    const request = await createResponsesPassthroughAdapter(upstream).buildRequest(parsed, {
      headers: new Headers(),
      translatorBudget: budget,
    });
    return { parsed, wire: JSON.parse(request.body as string) };
  } finally {
    budget.dispose();
  }
}

test.each([
  ["xAI early pass", provider({ baseUrl: "https://api.x.ai/v1", agentMessageFormat: "preserve" }), "grok-4.6"],
  ["third-party forward late pass", provider({ authMode: "forward", agentMessageFormat: "preserve" }), "qwen3-coder-plus"],
])("preserve blocks %s conversion", async (_name, upstream, model) => {
  const raw = body(model, structuredContent);
  const original = structuredClone(raw);
  const { parsed, wire } = await buildWire(raw, upstream);

  expect(wire.input).toEqual(original.input);
  expect(parsed._rawBody).toBe(raw);
  expect(raw).toEqual(original);
});

test("user_message converts a third-party GPT structured message with identity and media intact", async () => {
  const raw = body("gpt-5.6", structuredContent);
  const original = structuredClone(raw);
  const { parsed, wire } = await buildWire(raw, provider({ agentMessageFormat: "user_message" }));

  expect(wire.input[0]).toEqual({
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: 'Agent message {"author":"/root/reader","recipient":"/root/checker"}' },
      ...structuredContent,
    ],
  });
  expect(parsed._rawBody).toBe(raw);
  expect(raw).toEqual(original);
});

test("user_message converts a third-party forward string without changing its bytes", async () => {
  const content = "  child result\nwith trailing whitespace\n ";
  const raw = body("qwen3-coder-plus", content);
  const original = structuredClone(raw);
  const { wire } = await buildWire(raw, provider({ authMode: "forward", agentMessageFormat: "user_message" }));

  expect(wire.input[0]).toEqual({
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: 'Agent message {"author":"/root/reader","recipient":"/root/checker"}' },
      { type: "input_text", text: content },
    ],
  });
  expect(raw).toEqual(original);
});

test("user_message leaves official OpenAI agent_message native", async () => {
  const raw = body("glm-5.3", structuredContent);
  const original = structuredClone(raw);
  const { wire } = await buildWire(raw, provider({
    baseUrl: "https://api.openai.com/v1",
    agentMessageFormat: "user_message",
  }));

  expect(wire.input).toEqual(original.input);
  expect(raw).toEqual(original);
});

test("user_message keeps ciphertext and unknown parts in the original item", async () => {
  for (const content of [
    [{ type: "encrypted_content", encrypted_content: "opaque" }],
    [{ type: "input_text", text: "known" }, { type: "future_type", text: "unknown" }],
  ]) {
    const raw = body("gpt-5.6", content);
    const original = structuredClone(raw);
    const { wire } = await buildWire(raw, provider({ agentMessageFormat: "user_message" }));
    expect(wire.input).toEqual(original.input);
    expect(raw).toEqual(original);
  }
});

test("undefined keeps the Go non-forward special case and resolved non-GPT behavior", async () => {
  const goRaw = body("gpt-5.6", structuredContent);
  const goWire = await buildWire(goRaw, provider({ baseUrl: "https://opencode.ai/zen/go/v1" }));
  expect(goWire.wire.input[0]).toMatchObject({ type: "message", role: "user" });

  const raw = body("friendly-gpt-alias", structuredContent);
  const original = structuredClone(raw);
  const resolved = await buildWire(raw, provider(), "glm-5.3");
  expect(resolved.wire.model).toBe("glm-5.3");
  expect(resolved.wire.input[0]).toMatchObject({ type: "message", role: "user" });
  expect(resolved.parsed.modelId).toBe("glm-5.3");
  expect(raw).toEqual(original);
});

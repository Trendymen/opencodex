/**
 * The Codex annotation instructions, whose examples teach the wrong directive shape.
 *
 * The desktop client injects a "# Response annotations:" block as a user message ahead of the
 * selections themselves. Its example shows the directive inside backticks and its text never says
 * the directive has to be bare, so models copy the backticked shape, and the client renders a
 * backticked directive as literal code instead of an annotation chip.
 *
 * OpenCodex rewrites that one block on the way through: the selections, the user request and the
 * client keep working unchanged, and the model is told what the chip builder actually needs.
 *
 * Only the exact original wording is replaced. A client that rewords the block is left byte
 * identical and reported, because guessing at a new template is how a proxy starts editing text it
 * does not understand; the response-side unwrap in src/responses/annotation-directive.ts fixes the
 * rendering without this rewrite either way.
 */

/**
 * Marks the injected block, and is what tells an unrecognized template from no template.
 */
const INSTRUCTIONS_HEADER = "# Response annotations:";

/** The block the client sends today, from its heading through its closing sentence. */
const CLIENT_INSTRUCTIONS = "# Response annotations:\n"
  + "Each item contains text selected from an earlier Codex response and may include a user comment. "
  + "Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as "
  + "context and address every comment. For every annotation you address, include its inline "
  + "directive `:codex-annotation{index=\"N\"}`, where N is its one-based array position "
  + "(for example, `:codex-annotation{index=\"1\"}`). Do not use unstructured annotation labels.";

/**
 * The same block with the requirement stated and the examples bare.
 *
 * Every sentence the client wrote is kept; the two examples lose their backticks, and one clause
 * says why, so a model that learned the backticked shape from an untouched instruction block
 * earlier in the conversation has a reason to drop it.
 */
const REWRITTEN_INSTRUCTIONS = "# Response annotations:\n"
  + "Each item contains text selected from an earlier Codex response and may include a user comment. "
  + "Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as "
  + "context and address every comment. For every annotation you address, include its inline "
  + "directive :codex-annotation{index=\"N\"}, where N is its one-based array position (for "
  + "example, :codex-annotation{index=\"1\"}). Write it as bare, unescaped text, not wrapped in "
  + "backticks: the client renders a chip only when the directive is not inside a code span, and a "
  + "backticked directive reaches the reader as literal code. Do not use unstructured annotation labels.";

export interface AnnotationInstructionRewrite {
  /** Messages whose instruction block was replaced. */
  rewritten: number;
  /** Messages carrying the heading in a wording this module does not know. */
  unrecognized: number;
}

/**
 * Replace the annotation instructions in place, in the raw body input array.
 *
 * Returns counts instead of throwing: a request that carries no annotation block is the common
 * case and has to pass through untouched.
 */
export function rewriteAnnotationInstructionsInPlace(input: unknown): AnnotationInstructionRewrite {
  const result: AnnotationInstructionRewrite = { rewritten: 0, unrecognized: 0 };
  if (!Array.isArray(input)) return result;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const message = item as { role?: unknown; content?: unknown };
    // The client injects the block as a user message. Assistant text and tool output can quote a
    // directive without being an instruction, and this module only edits instructions.
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      const textPart = part as { type?: unknown; text?: unknown };
      if (textPart.type !== "input_text" && textPart.type !== "text") continue;
      if (typeof textPart.text !== "string") continue;
      const at = textPart.text.indexOf(CLIENT_INSTRUCTIONS);
      if (at === -1) {
        // Our own wording is not an unrecognized template: a request can carry the block twice,
        // once from the client and once retold by a replayed turn that already went through here.
        if (!textPart.text.includes(REWRITTEN_INSTRUCTIONS)
          && textPart.text.includes(INSTRUCTIONS_HEADER)) result.unrecognized += 1;
        continue;
      }
      textPart.text = textPart.text.slice(0, at)
        + REWRITTEN_INSTRUCTIONS
        + textPart.text.slice(at + CLIENT_INSTRUCTIONS.length);
      result.rewritten += 1;
      break;
    }
  }
  return result;
}

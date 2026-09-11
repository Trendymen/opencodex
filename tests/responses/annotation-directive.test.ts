import { describe, expect, test } from "bun:test";
import {
  createAnnotationDirectiveCodeSpanFilter,
  stripAnnotationDirectiveCodeSpans,
} from "../../src/responses/annotation-directive";

/**
 * The Codex client renders `:codex-annotation{index="N"}` as an annotation chip, but only
 * outside `code` / `codespan` nodes, and its own instruction template shows the directive in
 * backticks. Models copy that shape, so the reader gets literal inline code instead of the chip.
 * OpenCodex is the last stop before that client, so it unwraps a code span whose entire content
 * is one such directive.
 *
 * The streaming half of the suite is not just about the same inputs in smaller pieces: the bridge
 * re-sends the accumulated text in `output_text.done` and `output_item.done`, so the deltas and
 * the closing text must agree for every chunking the upstream happens to produce (#3843).
 */

const TICK = "`";
const DIRECTIVE = ':codex-annotation{index="1"}';
const SPAN = TICK + DIRECTIVE + TICK;

const drain = (chunks: readonly string[]): string => {
  const filter = createAnnotationDirectiveCodeSpanFilter();
  let out = "";
  for (const chunk of chunks) out += filter.push(chunk);
  return out + filter.flush();
};

describe("annotation directive code spans", () => {
  test("a span holding exactly one directive is unwrapped", () => {
    expect(stripAnnotationDirectiveCodeSpans("先收下 " + SPAN + " 这条。"))
      .toBe("先收下 " + DIRECTIVE + " 这条。");
  });

  test("a double-backtick span holding exactly one directive is unwrapped too", () => {
    expect(stripAnnotationDirectiveCodeSpans(TICK + TICK + DIRECTIVE + TICK + TICK))
      .toBe(DIRECTIVE);
  });

  test("a message without a backtick is returned unchanged", () => {
    const plain = "ordinary answer text with no code spans";
    expect(stripAnnotationDirectiveCodeSpans(plain)).toBe(plain);
  });

  test("a span with anything besides the directive stays code", () => {
    for (const text of [
      TICK + DIRECTIVE + " and more" + TICK,
      TICK + "see " + DIRECTIVE + TICK,
      TICK + "const x = 1;" + TICK,
      // How a model exhibits the syntax: an inner span inside a longer run is content.
      TICK + TICK + "sample " + SPAN + " " + TICK + TICK,
    ]) {
      expect(stripAnnotationDirectiveCodeSpans(text)).toBe(text);
    }
  });

  test("an index the client would reject is not unwrapped", () => {
    for (const body of [
      ':codex-annotation{index="0"}',
      ':codex-annotation{index="01"}',
      ':codex-annotation{index="x"}',
      ':codex-annotation{index="' + "9".repeat(20) + '"}',
    ]) {
      const text = TICK + body + TICK;
      expect(stripAnnotationDirectiveCodeSpans(text)).toBe(text);
    }
  });

  test("other directives are out of scope", () => {
    const text = TICK + ':codex-followup[run the audit]{prompt="start"}' + TICK;
    expect(stripAnnotationDirectiveCodeSpans(text)).toBe(text);
  });

  test("an unterminated run stays literal and swallows nothing", () => {
    const text = "tail " + TICK + DIRECTIVE;
    expect(stripAnnotationDirectiveCodeSpans(text)).toBe(text);
  });

  test("an escaped backtick does not open a span", () => {
    const text = "\\" + SPAN + "\\" + TICK;
    expect(stripAnnotationDirectiveCodeSpans(text)).toBe(text);
  });

  test("a run pairs with the next run of its own length, not with a later one", () => {
    // The client reads the first two runs as a span holding "a", so the directive after them is
    // text and the trailing lone backtick dangles. Unwrapping here would invent a chip.
    const text = TICK + "a" + TICK + DIRECTIVE + TICK;
    expect(stripAnnotationDirectiveCodeSpans(text)).toBe(text);
  });

  test("a fenced block keeps its content verbatim", () => {
    for (const fence of ["\`\`\`", "~~~"]) {
      const text = fence + "\n" + SPAN + "\n" + fence + "\n" + SPAN + "\n";
      expect(stripAnnotationDirectiveCodeSpans(text))
        .toBe(fence + "\n" + SPAN + "\n" + fence + "\n" + DIRECTIVE + "\n");
    }
  });

  test("the containers a model writes around a fence keep their content verbatim", () => {
    // The client renders all four as code, so nothing inside them is a span to unwrap.
    for (const text of [
      "> ```\n> " + SPAN + "\n> ```\n",
      "- ```\n  " + SPAN + "\n  ```\n",
      "1. step\n\n    ```\n    " + SPAN + "\n    ```\n",
      "text\n\n    " + SPAN + "\n",
    ]) {
      expect(stripAnnotationDirectiveCodeSpans(text)).toBe(text);
    }
  });

  test("a carriage-return fence closes, so scanning resumes after it", () => {
    const text = "```\r\n" + SPAN + "\r\n```\r\n" + SPAN + "\n";
    expect(stripAnnotationDirectiveCodeSpans(text))
      .toBe("```\r\n" + SPAN + "\r\n```\r\n" + DIRECTIVE + "\n");
  });

  test("a span past the bound is text in both readings", () => {
    // A directive is far shorter than the bound, so a run whose closer sits that far away cannot
    // be one. The two readings have to agree, or the deltas would keep the backticks while the
    // closing text unwraps them.
    const ticks = TICK.repeat(4_069);
    const text = ticks + DIRECTIVE + ticks + "\n";
    expect(stripAnnotationDirectiveCodeSpans(text)).toBe(text);
    expect(drain([ticks + DIRECTIVE, ticks + "\n"])).toBe(text);
  });

  test("a longer fence closes a shorter one and scanning resumes after it", () => {
    // A shorter run inside the block does not close it: the closing fence has to be at least as
    // long as the opening one, so only the last line ends the block.
    const text = "````\n" + SPAN + "\n```\n" + SPAN + "\n````\n" + SPAN + "\n";
    expect(stripAnnotationDirectiveCodeSpans(text))
      .toBe("````\n" + SPAN + "\n```\n" + SPAN + "\n````\n" + DIRECTIVE + "\n");
  });

  test("a backtick fence with a backtick in its info string is not a fence", () => {
    // CommonMark forbids that info string, so the line is a paragraph and the next line still
    // gets scanned instead of disappearing into a fence that never closes.
    const text = "```js " + TICK + "x" + TICK + "\n" + SPAN + "\n";
    expect(stripAnnotationDirectiveCodeSpans(text))
      .toBe("```js " + TICK + "x" + TICK + "\n" + DIRECTIVE + "\n");
  });

  test("only the span is rewritten in a multi-line message", () => {
    const text = "first " + SPAN + "\nsecond " + SPAN + "\n";
    expect(stripAnnotationDirectiveCodeSpans(text))
      .toBe("first " + DIRECTIVE + "\nsecond " + DIRECTIVE + "\n");
  });
});

describe("streaming annotation directive filter", () => {
  test("a span split across deltas is unwrapped", () => {
    expect(drain(["先收下 `:codex-annotation{index=", '"1"}` 这条。']))
      .toBe("先收下 " + DIRECTIVE + " 这条。");
  });

  test("a span split one character at a time is still unwrapped", () => {
    expect(drain(Array.from("ok " + SPAN + " done"))).toBe("ok " + DIRECTIVE + " done");
  });

  test("text before a possible span is emitted immediately", () => {
    const filter = createAnnotationDirectiveCodeSpanFilter();
    expect(filter.push("先收下 `")).toBe("先收下 ");
    expect(filter.flush()).toBe("`");
  });

  test("an unclosed candidate is released at close, not dropped", () => {
    expect(drain(["held `:codex-annotation"])).toBe("held `:codex-annotation");
  });

  test("a fence opened across deltas still hides its body", () => {
    expect(drain(["``", "`\n" + SPAN + "\n", "```", "\n"]))
      .toBe("```\n" + SPAN + "\n```\n");
  });

  test("a line past the hold bound is read as a whole once it ends", () => {
    // A stray backtick opens a run long before the span appears, and its closer is further away
    // than the bound, so the rest of the line is text in both readings. Two chunks, so the second
    // one lands after the filter already stopped scanning and started holding.
    const filler = "x".repeat(5_000);
    const text = TICK + filler + TICK + " " + SPAN + "\n";
    expect(stripAnnotationDirectiveCodeSpans(text)).toBe(text);
    expect(drain([TICK + filler, TICK + " " + SPAN + "\n"])).toBe(text);
  });

  test("every chunking of a message produces the whole-message reading", () => {
    const inputs = [
      "先收下 " + SPAN + " 这条。",
      SPAN + SPAN + SPAN,
      "kept " + SPAN + " and `code` and " + SPAN,
      "```\n" + SPAN + "\n```\n" + SPAN + "\n",
      "a " + TICK + ':codex-annotation{index="2"}' + TICK + " b",
      "odd " + TICK + " and " + SPAN + " tail",
      TICK + TICK + SPAN + TICK + TICK,
      TICK + "a" + TICK + DIRECTIVE + TICK,
      "escaped \\" + TICK + " run " + SPAN,
      "line one " + SPAN + "\nline two " + SPAN,
      "> ```\n> " + SPAN + "\n> ```\n",
      "- ```\n  " + SPAN + "\n  ```\n",
      "text\n\n    " + SPAN + "\n",
      "```\r\n" + SPAN + "\r\n```\r\n" + SPAN + "\n",
      "- item\n\n  ```text\n  " + SPAN + "\n  ```\n",
      "```js " + TICK + "x" + TICK + "\n" + SPAN + "\n",
    ];
    for (const input of inputs) {
      const whole = stripAnnotationDirectiveCodeSpans(input);
      for (let at = 1; at < input.length; at += 1) {
        expect(drain([input.slice(0, at), input.slice(at)])).toBe(whole);
      }
      for (const size of [1, 2, 3, input.length]) {
        const chunks: string[] = [];
        for (let i = 0; i < input.length; i += size) chunks.push(input.slice(i, i + size));
        expect(drain(chunks)).toBe(whole);
      }
    }
  });
});

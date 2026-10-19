/**
 * Codex annotation directives that arrive wrapped in a code span.
 *
 * The desktop client renders `:codex-annotation{index="N"}` as an annotation chip, but its
 * Markdown pass only offers directives outside `code` / `codespan` nodes: one inside a code span
 * is skipped by the chip builder and stays literal inline code. The client injects its annotation
 * instructions as a user message that shows the directive in backticks, so models reproduce that
 * shape and the chip never renders.
 *
 * OpenCodex is the last stop before that client, and the shape worth correcting is narrow: one
 * code span, on one line, whose entire content is a single directive the client accepts.
 * Everything else passes through byte-identical — a span holding anything besides the directive
 * (including the double-backtick form a model uses to exhibit the syntax), a fenced block, an
 * indented code block, an index the client would reject, and text outside a code span.
 *
 * Boundaries worth naming: backticks are paired within a line, so a run on an earlier line that the
 * client would pair with one here is not seen; and fence detection covers the containers models
 * actually write (top level, block quotes, list items) rather than every CommonMark nesting.
 *
 * Scope: the routed adapter path, which builds Responses SSE in bridge.ts. The native passthrough
 * forwards upstream Responses verbatim and does not run through this filter.
 */

/** The one directive the client both injects in its instructions and renders as a chip. */
const DIRECTIVE_HEAD = ':codex-annotation{index="';

/** A complete directive body: the head, a canonical decimal index, and the closing brace. */
const COMPLETE_DIRECTIVE = /^:codex-annotation\{index="([1-9][0-9]*)"\}$/;

/** The character that opens and closes a code span. */
const BACKTICK = "`";

/**
 * An opening fence: three or more of one fence character, indented at most three spaces.
 *
 * A backtick fence's info string may not contain another backtick, which is what keeps a line
 * like ```js `x` from opening a block that would swallow every later line. The tail captured here
 * starts after the run, so the check in createLineProcessor reads the info string, not the fence.
 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\n]*)/;

/** An opening fence behind a list marker, which is how a fence inside a bullet or step opens. */
const FENCE_OPEN_AFTER_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+(`{3,}|~{3,})([^\n]*)/;

/** A line of fence characters only, which is how a fence of that character closes. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/;

/**
 * Longest span either reader will consider, and the longest tail the streaming filter keeps for a
 * backtick run it cannot resolve yet.
 *
 * A directive is under 40 characters, so a run whose closer sits further away than this cannot be
 * part of one; the rest of the line is text. Both readers apply that bound, which is what keeps a
 * stray backtick near the start of a very long line from being paired with a late closer in one
 * reading and not the other. For the streaming reader it is also the point where it stops keeping
 * and re-scanning the tail, so the work per delta stays bounded.
 */
const MAX_HELD_TAIL = 4_096;

type DirectiveMatch = "full" | "prefix" | "no";

interface LineScan {
  /** Text of this line that is final and can be emitted now. */
  text: string;
  /** Offset in the scanned text where the withheld tail starts, or -1 when nothing is held. */
  heldFrom: number;
  /** True when the tail passed the hold bound and the rest of the line must not be scanned. */
  sealed: boolean;
}

function isCanonicalIndex(digits: string): boolean {
  // The client converts the raw attribute and requires String(number) === raw, so a zero, a
  // leading zero, and a value past Number.MAX_SAFE_INTEGER all fail its chip builder. Those
  // bodies stay in their code span: unwrapping them would show a directive the client then
  // refuses to render.
  return /^[1-9][0-9]*$/.test(digits) && Number.isSafeInteger(Number(digits));
}

/**
 * Classify a code-span body.
 *
 * "full" is a directive the client renders. "prefix" could still become one, so the streaming
 * filter withholds it until the next delta decides. "no" can never become one, whatever follows.
 */
function classifyDirective(body: string): DirectiveMatch {
  const complete = COMPLETE_DIRECTIVE.exec(body);
  if (complete) return isCanonicalIndex(complete[1]) ? "full" : "no";
  if (DIRECTIVE_HEAD.startsWith(body)) return "prefix";
  if (!body.startsWith(DIRECTIVE_HEAD)) return "no";
  const rest = body.slice(DIRECTIVE_HEAD.length);
  const digits = rest.endsWith('"') ? rest.slice(0, -1) : rest;
  return isCanonicalIndex(digits) ? "prefix" : "no";
}

/**
 * Length of the backtick run starting at `at`, or 0 for anything else.
 *
 * A backslash before the run makes it literal text rather than a code-span delimiter. Inside a
 * code span CommonMark ignores backslash escapes, but this scanner never has to: a run it has
 * already entered is emitted or unwrapped as a whole, so the only escapes that matter are the
 * ones that decide whether a run opens a span at all.
 */
function backtickRunAt(line: string, at: number): number {
  if (line[at] !== BACKTICK || line[at - 1] === "\\") return 0;
  let end = at;
  while (line[end] === BACKTICK) end += 1;
  return end - at;
}

/** Start of the next run of exactly `length` backticks at or after `from`, or -1. */
function nextClosingRun(line: string, from: number, length: number): number {
  let i = from;
  while (i < line.length) {
    const run = backtickRunAt(line, i);
    if (run === 0) {
      i += 1;
      continue;
    }
    if (run === length) return i;
    i += run;
  }
  return -1;
}

/**
 * Drop backticks and backslashes that end the text.
 *
 * The next delta can extend a trailing run, and a run that grows is a different delimiter: two
 * adjacent spans read as a run of two as soon as they are joined. A trailing backslash matters for
 * the same reason, because it is what escapes the backtick that follows it. Nothing before either
 * one changes, so the streaming filter scans this text and keeps the tail for later.
 */
function dropTrailingContext(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === BACKTICK || text[end - 1] === "\\")) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

/**
 * Drop block-quote markers, so a fence inside a quote is still a fence.
 *
 * Each marker is up to three spaces of indent, a `>`, and one optional space. Anything else ends
 * the prefix. Only classification reads this: what gets emitted is always the original line.
 */
function stripQuotePrefix(line: string): string {
  let at = 0;
  while (at < line.length) {
    const start = at;
    let spaces = 0;
    while (spaces < 3 && line[at] === " ") {
      at += 1;
      spaces += 1;
    }
    if (line[at] !== ">") {
      at = start;
      break;
    }
    at += 1;
    if (line[at] === " ") at += 1;
  }
  return line.slice(at);
}

/**
 * True for a line the client renders as code without a fence: four spaces of indent, or a tab,
 * before any content.
 *
 * A list item's continuation paragraph indented this far is a paragraph in CommonMark and this
 * misreads it as code. That is the safe direction: leaving a directive wrapped keeps the words the
 * model wrote, while unwrapping one the client renders as code changes what that block says.
 */
function isIndentedCode(line: string): boolean {
  return /^(?: {4,}|\t)\S/.test(stripQuotePrefix(line));
}

/**
 * Unwrap annotation directives on one line.
 *
 * A backtick run opens a code span only when a run of the same length closes it, so a run of two
 * around a directive is a code span as well, and a shorter run inside it is content. Runs that
 * stay open hold the tail: the client pairs them with a later run, and that pairing decides how
 * every later run on the line is read, so nothing from an open run on is final yet.
 */
function scanLine(line: string, allowHold: boolean): LineScan {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const run = backtickRunAt(line, i);
    if (run === 0) {
      out += line[i];
      i += 1;
      continue;
    }
    const close = nextClosingRun(line, i + run, run);
    if (close === -1 || close - i > MAX_HELD_TAIL) {
      if (allowHold && close === -1 && line.length - i <= MAX_HELD_TAIL) {
        // Nothing closes the run yet and the tail is still short enough to hold for the rest of
        // the line. Past the bound the run cannot become a directive span either way.
        return { text: out, heldFrom: i, sealed: false };
      }
      out += line.slice(i);
      return { text: out, heldFrom: -1, sealed: allowHold };
    }
    const body = line.slice(i + run, close);
    out += classifyDirective(body) === "full" ? body : line.slice(i, close + run);
    i = close + run;
  }
  return { text: out, heldFrom: -1, sealed: false };
}

interface LineProcessor {
  /** Read one whole line, updating fence state, and return the line as it should be emitted. */
  process(line: string): string;
  /** True while a fenced block is open. Only a whole line can change this. */
  inFence(): boolean;
}

function createLineProcessor(): LineProcessor {
  let fenceChar = "";
  let fenceLength = 0;
  return {
    process(line: string): string {
      const content = stripQuotePrefix(line);
      if (fenceChar) {
        const close = FENCE_CLOSE.exec(content);
        if (close && close[1][0] === fenceChar && close[1].length >= fenceLength) {
          fenceChar = "";
          fenceLength = 0;
        }
        return line;
      }
      // A line the client indents into a code block is not scanned for spans at all.
      if (isIndentedCode(line)) return line;
      const open = FENCE_OPEN.exec(content) ?? FENCE_OPEN_AFTER_MARKER.exec(content);
      if (open && (open[1][0] !== BACKTICK || !open[2].includes(BACKTICK))) {
        fenceChar = open[1][0];
        fenceLength = open[1].length;
        return line;
      }
      return scanLine(line, false).text;
    },
    inFence(): boolean {
      return fenceChar !== "";
    },
  };
}

/**
 * Remove the code span around an annotation directive in a whole message.
 *
 * Lines are walked in order because a fenced block changes what the lines inside it mean.
 */
export function stripAnnotationDirectiveCodeSpans(text: string): string {
  if (!text.includes(BACKTICK)) return text;
  const lines = createLineProcessor();
  let out = "";
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    out += lines.process(text.slice(start, end));
    start = end;
  }
  return out;
}

export interface AnnotationDirectiveCodeSpanFilter {
  /** Feed one streaming delta; returns the portion safe to emit now. */
  push(delta: string): string;
  /** Release anything still held when the message closes. */
  flush(): string;
}

/**
 * Streaming filter.
 *
 * A code span can straddle a delta boundary, with the opening run in one chunk and the closer in
 * the next, so a stateless per-delta strip would emit a directive it never recognized. This emits
 * the part of an open line that no later delta can change and holds the rest. The contract is
 * that everything `push` returned plus `flush` equals what `stripAnnotationDirectiveCodeSpans`
 * returns for the same text: a line is read in full when its newline arrives, and the emitted
 * prefix of an open line is the part of that reading that is already settled, so the reader never
 * sees a rewrite the closing text does not carry.
 *
 * Two things keep the emitted prefix settled: the text stops before the first open run, and it
 * stops before a run that ends the text, because the next delta can lengthen that one into a
 * different delimiter and re-pair the runs before it.
 */
export function createAnnotationDirectiveCodeSpanFilter(): AnnotationDirectiveCodeSpanFilter {
  const lines = createLineProcessor();
  /** The current line, including the part already emitted. */
  let line = "";
  /** Input offset in `line` that is settled: everything before it was emitted. */
  let decided = 0;
  /** Output characters emitted for `line` so far, so the closing read can skip them. */
  let written = 0;
  /** The line passed the hold bound, so the rest of it is not scanned any more. */
  let sealed = false;

  /** Read the finished line once more and return only the part that is still unemitted. */
  const closeLine = (): string => {
    const tail = lines.process(line).slice(written);
    line = "";
    decided = 0;
    written = 0;
    sealed = false;
    return tail;
  };

  return {
    push(delta: string): string {
      let out = "";
      let rest = delta;
      while (rest.length > 0) {
        const newline = rest.indexOf("\n");
        if (newline === -1) {
          line += rest;
          if (sealed) break;
          if (lines.inFence() || isIndentedCode(line)) {
            // Fence content and indented code come out verbatim, so the rest needs no scan.
            const verbatim = line.slice(decided);
            out += verbatim;
            written += verbatim.length;
            decided = line.length;
            sealed = true;
            break;
          }
          const pending = dropTrailingContext(line.slice(decided));
          const scan = scanLine(pending, true);
          out += scan.text;
          written += scan.text.length;
          decided += scan.heldFrom === -1 ? pending.length : scan.heldFrom;
          sealed = scan.sealed;
          break;
        }
        line += rest.slice(0, newline + 1);
        rest = rest.slice(newline + 1);
        out += closeLine();
      }
      return out;
    },
    flush(): string {
      return line.length === 0 ? "" : closeLine();
    },
  };
}

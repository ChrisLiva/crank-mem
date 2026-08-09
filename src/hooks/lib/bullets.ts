// Markdown bullet grouping, shared by the journal (episodic entries) and the
// cerebrum excerpt (semantic memory). Both files are agent-written prose, where
// a single logical bullet routinely wraps across several physical lines and
// carries sub-bullets — so "one bullet = one line" loses most of the content.
//
// Grouping is deliberately dumb: no inline markdown is parsed, and lines are
// carried verbatim, so a block can be written back byte-identically.

export interface Block {
  kind: "bullet" | "other";
  /** Raw lines, verbatim and in order. */
  lines: string[];
}

/**
 * Group lines into bullet blocks and everything else.
 *
 * A bullet opens at a top-level `- ` line and absorbs every following line —
 * wrapped prose, sub-bullets, blank separators — until the next top-level
 * bullet or a heading. A `#`-prefixed line is a hard boundary: it closes the
 * open bullet and is never absorbed into one, which is what keeps a nested
 * `### Heading` inside a section from being swallowed by the bullet above it.
 *
 * Every input line lands in exactly one block, in order, so
 * `blocks.flatMap((b) => b.lines)` reproduces the input.
 */
export function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  for (const line of lines) {
    if (line.startsWith("#")) {
      open = null;
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "other") last.lines.push(line);
      else blocks.push({ kind: "other", lines: [line] });
    } else if (line.startsWith("- ")) {
      open = { kind: "bullet", lines: [line] };
      blocks.push(open);
    } else if (open) {
      open.lines.push(line);
    } else {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "other") last.lines.push(line);
      else blocks.push({ kind: "other", lines: [line] });
    }
  }
  return blocks;
}

/** Whole bullets, oldest first: block lines joined, trailing blanks dropped. */
export function parseBullets(lines: string[]): string[] {
  return parseBlocks(lines)
    .filter((b) => b.kind === "bullet")
    .map((b) => b.lines.join("\n").trimEnd());
}

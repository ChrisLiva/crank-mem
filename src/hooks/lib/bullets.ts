// Markdown bullet grouping that keeps wrapped lines and sub-bullets with their bullet, with lines carried verbatim.

/** A `YYYY-MM-DD` date. Global: use matchAll, match or replace, never test or exec. */
export const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

export interface Block {
  kind: "bullet" | "other";
  /** Raw lines, verbatim and in order. */
  lines: string[];
}

function appendOther(blocks: Block[], line: string): void {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "other") last.lines.push(line);
  else blocks.push({ kind: "other", lines: [line] });
}

/**
 * Group lines into bullet blocks and everything else.
 *
 * A bullet opens at a top-level `- ` line and absorbs every following line
 * until the next top-level bullet or a heading. A `#`-prefixed line is a hard
 * boundary, so a nested `### Heading` is never swallowed by the bullet above it.
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
      appendOther(blocks, line);
    } else if (line.startsWith("- ")) {
      open = { kind: "bullet", lines: [line] };
      blocks.push(open);
    } else if (open) {
      open.lines.push(line);
    } else {
      appendOther(blocks, line);
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

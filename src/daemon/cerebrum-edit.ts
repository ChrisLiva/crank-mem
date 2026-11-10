import { ISO_DATE, parseBlocks } from "../hooks/lib/bullets.ts";
import { PRUNE_LINE_LIMIT, PRUNE_TOKEN_LIMIT } from "../hooks/lib/cerebrum-files.ts";
import { estimateProseTokens } from "../hooks/lib/tokens.ts";
import { redact } from "./redact.ts";

// Pure cerebrum editing for the digest: number the bullets so the model can
// name them, then apply its edits. No I/O; the caller reads and writes files.

export type CerebrumEdit =
  | { op: "add"; heading: string; bullet: string; proposal: number | null }
  | { op: "replace"; bulletId: number; bullet: string; reason: string; proposal: number | null }
  | { op: "remove"; bulletId: number; reason: string };

export type NumberedCerebrum = {
  headings: string[];
  bullets: { id: number; heading: string; text: string }[];
};

type NumberedBlock = { lines: string[]; id: number | null; heading: string | null };

const SECTION = "## ";

/** Index just past a bullet block's last non-blank line: its changed lines end here. */
function changedEnd(lines: string[]): number {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return end;
}

const joinTrimmed = (lines: string[]): string =>
  lines
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join(" ");

/** Every block of `md`, with each bullet under a `## ` section numbered from 1. */
function walk(md: string): NumberedBlock[] {
  const out: NumberedBlock[] = [];
  let heading: string | null = null;
  let next = 1;
  for (const block of parseBlocks(md.split("\n"))) {
    if (block.kind === "other") {
      out.push({ lines: block.lines, id: null, heading });
      for (const line of block.lines)
        if (line.startsWith(SECTION)) heading = line.slice(SECTION.length).trim();
    } else {
      out.push({ lines: block.lines, id: heading === null ? null : next++, heading });
    }
  }
  return out;
}

export function numberBullets(md: string): NumberedCerebrum {
  const headings = md
    .split("\n")
    .filter((l) => l.startsWith(SECTION))
    .map((l) => l.slice(SECTION.length).trim());
  const bullets = walk(md).flatMap((b) => {
    if (b.id === null || b.heading === null) return [];
    const lines = b.lines.slice(0, changedEnd(b.lines));
    return [
      { id: b.id, heading: b.heading, text: joinTrimmed([lines[0]!.slice(2), ...lines.slice(1)]) },
    ];
  });
  return { headings, bullets };
}

/** The bullet line as written to cerebrum: redacted, one line, a leading `- `, and a date; "" when empty. */
function writeBullet(bullet: string, today: string): string {
  let line = joinTrimmed(redact(bullet).split("\n"));
  if (line === "") return "";
  if (!line.startsWith("- ")) line = `- ${line}`;
  return line.match(ISO_DATE) ? line : `${line} (${today})`;
}

/** Where an add under `heading` goes in `lines`, or -1 when no `## ` line matches. */
function insertionPoint(lines: string[], heading: string): number {
  const want = heading.trim().toLowerCase();
  const start = lines.findIndex(
    (l) => l.startsWith(SECTION) && l.slice(SECTION.length).trim().toLowerCase() === want,
  );
  if (start < 0) return -1;
  let end = lines.findIndex((l, i) => i > start && l.startsWith(SECTION));
  if (end < 0) end = lines.length;
  let at = start + 1;
  let offset = start + 1;
  for (const block of parseBlocks(lines.slice(start + 1, end))) {
    if (block.kind === "bullet") at = offset + changedEnd(block.lines);
    offset += block.lines.length;
  }
  return at;
}

/** Pass 1: apply the replace and remove edits to `blocks` in place, archiving each bullet they change. */
function changeBullets(
  blocks: NumberedBlock[],
  edits: CerebrumEdit[],
  today: string,
  skipped: Set<number>,
): string[] {
  const archived: string[] = [];
  const changed = new Set<number>();
  for (const [i, edit] of edits.entries()) {
    if (edit.op === "add") continue;
    const block = blocks.find((b) => b.id === edit.bulletId);
    const written = edit.op === "replace" ? writeBullet(edit.bullet, today) : null;
    if (!block || changed.has(edit.bulletId) || written === "") {
      skipped.add(i);
      continue;
    }
    changed.add(edit.bulletId);
    const end = changedEnd(block.lines);
    archived.push(
      `${block.lines.slice(0, end).join("\n")}\n  - archived ${today}: ${redact(edit.reason)}`,
    );
    block.lines = [...(written === null ? [] : [written]), ...block.lines.slice(end)];
  }
  return archived;
}

/** Pass 2: insert the add edits into `lines`, each measured against the limits after the adds before it. */
function addBullets(
  lines: string[],
  edits: CerebrumEdit[],
  today: string,
  skipped: Set<number>,
): string[] {
  for (const [i, edit] of edits.entries()) {
    if (edit.op !== "add") continue;
    const written = writeBullet(edit.bullet, today);
    const at = written === "" ? -1 : insertionPoint(lines, edit.heading);
    const next = at < 0 ? [] : [...lines.slice(0, at), written, ...lines.slice(at)];
    if (
      at < 0 ||
      next.length > PRUNE_LINE_LIMIT ||
      estimateProseTokens(next.join("\n")) > PRUNE_TOKEN_LIMIT
    ) {
      skipped.add(i);
      continue;
    }
    lines = next;
  }
  return lines;
}

export function applyEdits(
  md: string,
  edits: CerebrumEdit[],
  today: string,
): { md: string; archived: string[]; skipped: CerebrumEdit[] } {
  const blocks = walk(md);
  const skipped = new Set<number>();
  const archived = changeBullets(blocks, edits, today, skipped);
  const lines = addBullets(
    blocks.flatMap((b) => b.lines),
    edits,
    today,
    skipped,
  );
  return { md: lines.join("\n"), archived, skipped: edits.filter((_, i) => skipped.has(i)) };
}

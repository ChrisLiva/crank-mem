import * as fs from "node:fs";
import * as path from "node:path";
import { parseBlocks, parseBullets } from "./bullets.ts";

// Episodic memory: `.crank/journal.md`, one dated bullet per entry, newest
// last. Where cerebrum holds what's true about the project, the journal holds
// what happened in the last few sessions — "what was I doing, where did I leave
// off". Entries expire by recency, trimmed mechanically here, so the agent
// never has to curate the file. The trim bounds the entry count, not the byte
// size — an entry is kept verbatim, sub-bullets and all — and what reaches the
// model is bounded separately by JOURNAL_INJECT_MAX_BYTES.

/** Entries kept on disk. Older ones are dropped at the next session start. */
export const JOURNAL_KEEP = 20;
/** Entries injected at session start — enough to orient, small enough to be free. */
export const JOURNAL_INJECT_COUNT = 3;
/**
 * Per-entry cap on the injected headline, in bytes — the unit the injection
 * budget is spent in, so a CJK journal costs the same as an ASCII one. The
 * section is added ahead of the cerebrum excerpt, so without a cap three
 * sprawling entries (a pasted stack trace, a paragraph-long "next step") could
 * eat the budget and push User Preferences and the ADR list out entirely.
 */
export const JOURNAL_INJECT_MAX_BYTES = 240;

/**
 * The handoff marker. Matched literal-uppercase: the protocol asks for `NEXT:`
 * in exactly this form, and a case-insensitive match would fire on any prose
 * mentioning "next:".
 */
const NEXT_MARKER = "NEXT:";

export const JOURNAL_FILE = "journal.md";

function readJournal(crankDir: string): string | null {
  try {
    return fs.readFileSync(path.join(crankDir, JOURNAL_FILE), "utf-8");
  } catch {
    return null;
  }
}

const byteLength = (s: string): number => Buffer.byteLength(s, "utf-8");

/**
 * Longest prefix fitting maxBytes, plus a trailing `…` when anything was cut.
 * Walks code points, not UTF-16 units: slicing mid-surrogate would emit a lone
 * half. The ellipsis costs 3 bytes, so leave room for it.
 */
function capHead(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const room = maxBytes - 3;
  let kept = "";
  let used = 0;
  for (const ch of text) {
    const cost = byteLength(ch);
    if (used + cost > room) break;
    kept += ch;
    used += cost;
  }
  return kept.trimEnd() + "…";
}

/** Longest suffix fitting maxBytes, with a leading `…` when anything was cut. */
function capTail(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const room = maxBytes - 3;
  const chars = Array.from(text);
  let kept = "";
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cost = byteLength(chars[i]!);
    if (used + cost > room) break;
    kept = chars[i]! + kept;
    used += cost;
  }
  return "…" + kept.trimStart();
}

/** Entry lead-in: `- `, an optional ISO date, and whatever separates it from the body. */
const ENTRY_PREFIX = /^- (?:(\d{4}-\d{2}-\d{2})[\s:—–-]*)?/;

/**
 * The injected form of one entry: its date, then the part that carries the
 * handoff.
 *
 * An entry is squashed to a single line first — a bullet wraps across physical
 * lines, and `NEXT:` routinely straddles the wrap, so matching per-line finds
 * nothing and injecting per-line breaks the bullet.
 *
 * What survives is the `NEXT:` clause when there is one (it runs to the end of
 * the entry — the protocol puts the handoff last) and otherwise the entry's
 * tail, which is where an entry without the marker still says where it stopped.
 * `…` marks the side material was lost on: trailing for a capped clause,
 * leading for a tail. Nothing else in the injection cuts mid-stream, so the
 * ellipsis is unambiguous.
 */
function headline(entry: string): string {
  const flat = entry.replace(/\s+/g, " ").trim();
  const match = ENTRY_PREFIX.exec(flat);
  const date = match?.[1];
  const body = flat.slice(match?.[0].length ?? 0);
  const next = body.indexOf(NEXT_MARKER);
  const injected =
    next >= 0
      ? capHead(body.slice(next), JOURNAL_INJECT_MAX_BYTES)
      : capTail(body, JOURNAL_INJECT_MAX_BYTES);
  return `- ${date ? `${date} — ` : ""}${injected}`;
}

/**
 * The most recent JOURNAL_INJECT_COUNT entry headlines, oldest first.
 * Missing or unreadable journal → no bullets. Never throws.
 */
export function recentJournalBullets(crankDir: string): string[] {
  const text = readJournal(crankDir);
  if (text === null) return [];
  return parseBullets(text.split("\n")).slice(-JOURNAL_INJECT_COUNT).map(headline);
}

/**
 * Trim `journal.md` to its last JOURNAL_KEEP entries, in place.
 *
 * Writes only when the file is actually over the limit, via temp + rename (a
 * hook killed at the agent's timeout must not leave a truncated journal), and
 * restores the mtime it found: mtime is the journal nudge's staleness signal,
 * and a trim is housekeeping, not a new entry — bumping it would silence the
 * nudge without anything having been recorded. Seconds are passed as numbers
 * because `Date` drops the sub-millisecond part the nudge compares for equality.
 *
 * Advisory-only: a missing or unreadable journal is a no-op. Never throws.
 */
export function trimJournal(crankDir: string): void {
  const file = path.join(crankDir, JOURNAL_FILE);
  let stat: fs.Stats;
  let text: string;
  try {
    stat = fs.statSync(file);
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return;
  }

  const blocks = parseBlocks(text.split("\n"));
  let excess = blocks.filter((b) => b.kind === "bullet").length - JOURNAL_KEEP;
  if (excess <= 0) return;

  try {
    // Drop the oldest entries and keep everything else in place, so the header,
    // the format note, and any stray heading between entries survive verbatim.
    const kept = blocks.filter((b) => !(b.kind === "bullet" && excess-- > 0));
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, kept.flatMap((b) => b.lines).join("\n"));
    fs.renameSync(tmp, file);
    fs.utimesSync(file, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  } catch {
    // Trim failed: the file is merely longer than intended, which costs nothing
    // at read time — injection reads only the newest entries either way.
  }
}

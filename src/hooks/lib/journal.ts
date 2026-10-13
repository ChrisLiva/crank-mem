import * as fs from "node:fs";
import * as path from "node:path";
import { parseBlocks, parseBullets } from "./bullets.ts";

// Episodic memory: `.crank/journal.md`, one dated bullet per entry, newest
// last. Where cerebrum holds what's true about the project, the journal holds
// what happened in the last few sessions — "what was I doing, where did I leave
// off". Entries expire by recency, trimmed mechanically here, so the agent
// never has to curate the file. The trim bounds the entry count, not the byte
// size — an entry is kept verbatim, sub-bullets and all — and what reaches the
// model is bounded separately by the JOURNAL_*_MAX_BYTES caps below.

/** Entries kept on disk. Older ones are dropped at the next session start. */
export const JOURNAL_KEEP = 20;
/** Entries injected at session start — enough to orient, small enough to be free. */
export const JOURNAL_INJECT_COUNT = 3;
/**
 * Per-entry caps on the injected headline, in bytes — the unit the injection
 * budget is spent in, so a CJK journal costs the same as an ASCII one. The
 * section is added ahead of the cerebrum excerpt, so without a cap three
 * sprawling entries (a pasted stack trace, a paragraph-long "next step") could
 * eat the budget and push User Preferences and the ADR list out entirely.
 * The newest entry carries the handoff and gets the larger cap; the two before
 * it carry only what they did. Together: 360 + 2 × 160 = 680 bytes.
 */
export const JOURNAL_NEWEST_MAX_BYTES = 360;
export const JOURNAL_OLDER_MAX_BYTES = 160;
/** A cut moves back to a word boundary only when one lies this close. */
const SNAP_MAX_BYTES = 24;

/**
 * The handoff marker. Matched literal-uppercase: the protocol asks for `NEXT:`
 * in exactly this form, and a case-insensitive match would fire on any prose
 * mentioning "next:".
 */
export const NEXT_MARKER = "NEXT:";

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
 * half. The ellipsis costs 3 bytes, so leave room for it. The cut backs up to
 * the last space when one lies within SNAP_MAX_BYTES, so a word is not split;
 * text without a nearby space keeps the code-point cut.
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
  const space = kept.lastIndexOf(" ");
  if (space > 0 && byteLength(kept.slice(space)) <= SNAP_MAX_BYTES) kept = kept.slice(0, space);
  return kept.trimEnd() + "…";
}

/** Entry lead-in: `- `, an optional ISO date, and whatever separates it from the body. */
const ENTRY_PREFIX = /^- (?:(\d{4}-\d{2}-\d{2})[\s:—–-]*)?/;

/**
 * The injected form of one entry: its date, then what it did, and for the
 * newest entry its `NEXT:` handoff too.
 *
 * An entry is squashed to a single line first — a bullet wraps across physical
 * lines, and `NEXT:` routinely straddles the wrap, so matching per-line finds
 * nothing and injecting per-line breaks the bullet.
 *
 * The done-clause is everything before `NEXT:` (the protocol puts the handoff
 * last), or the whole body when the marker is absent. A handoff alone misled
 * an agent into saying work recorded in the same entry had never been done,
 * so the done-clause always rides along. Only the newest entry's `NEXT:` is
 * injected: an older entry's handoff is usually what a later entry already
 * did. Within the newest entry's cap, the handoff takes all but the
 * done-clause's share (its size, counted up to JOURNAL_OLDER_MAX_BYTES), and
 * the done-clause takes whatever the handoff leaves. A trailing `…` marks a
 * cut; nothing else in the injection cuts mid-stream, so the ellipsis is
 * unambiguous.
 */
function headline(entry: string, newest: boolean): string {
  const flat = entry.replace(/\s+/g, " ").trim();
  const match = ENTRY_PREFIX.exec(flat);
  const date = match?.[1];
  const body = flat.slice(match?.[0].length ?? 0);
  const next = body.indexOf(NEXT_MARKER);
  const done = (next >= 0 ? body.slice(0, next) : body).replace(/[\s;,]+$/, "");
  const handoff = newest && next >= 0 ? body.slice(next) : "";
  let injected: string;
  if (!handoff) {
    injected = capHead(done || body, newest ? JOURNAL_NEWEST_MAX_BYTES : JOURNAL_OLDER_MAX_BYTES);
  } else if (!done) {
    injected = capHead(handoff, JOURNAL_NEWEST_MAX_BYTES);
  } else {
    const room = JOURNAL_NEWEST_MAX_BYTES - byteLength("; ");
    const nextPart = capHead(handoff, room - Math.min(byteLength(done), JOURNAL_OLDER_MAX_BYTES));
    injected = `${capHead(done, room - byteLength(nextPart))}; ${nextPart}`;
  }
  return `- ${date ? `${date} — ` : ""}${injected}`;
}

/**
 * The most recent JOURNAL_INJECT_COUNT entry headlines, oldest first.
 * Missing or unreadable journal → no bullets. Never throws.
 */
export function recentJournalBullets(crankDir: string): string[] {
  const text = readJournal(crankDir);
  if (text === null) return [];
  const entries = parseBullets(text.split("\n")).slice(-JOURNAL_INJECT_COUNT);
  return entries.map((entry, i) => headline(entry, i === entries.length - 1));
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

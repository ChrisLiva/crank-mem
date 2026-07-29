import * as fs from "node:fs";
import * as path from "node:path";

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

export const JOURNAL_FILE = "journal.md";

/**
 * An entry is a top-level `- ` line plus everything up to the next one, so
 * sub-bullets, wrapped prose, and blank separators ride along with the entry
 * they belong to and survive a trim verbatim. Indented `- ` lines are
 * continuation, not new entries.
 */
const isEntryStart = (line: string): boolean => line.startsWith("- ");

interface ParsedJournal {
  /** Everything before the first entry — heading and format note. */
  preamble: string[];
  /** One string[] of raw lines per entry, oldest first. */
  entries: string[][];
}

function parseJournal(text: string): ParsedJournal {
  const preamble: string[] = [];
  const entries: string[][] = [];
  for (const line of text.split("\n")) {
    if (isEntryStart(line)) entries.push([line]);
    else if (entries.length) entries[entries.length - 1]!.push(line);
    else preamble.push(line);
  }
  return { preamble, entries };
}

function readJournal(crankDir: string): string | null {
  try {
    return fs.readFileSync(path.join(crankDir, JOURNAL_FILE), "utf-8");
  } catch {
    return null;
  }
}

/** Headline of an entry, capped for injection. */
function headline(entry: string[]): string {
  const line = entry[0]!.trimEnd();
  if (Buffer.byteLength(line, "utf-8") <= JOURNAL_INJECT_MAX_BYTES) return line;
  // Walk code points, not UTF-16 units: slicing mid-surrogate would emit a
  // lone half. The ellipsis costs 3 bytes, so leave room for it.
  const room = JOURNAL_INJECT_MAX_BYTES - 3;
  let kept = "";
  let used = 0;
  for (const ch of line) {
    const cost = Buffer.byteLength(ch, "utf-8");
    if (used + cost > room) break;
    kept += ch;
    used += cost;
  }
  return kept.trimEnd() + "…";
}

/**
 * The most recent JOURNAL_INJECT_COUNT entry headlines, oldest first.
 * Missing or unreadable journal → no bullets. Never throws.
 */
export function recentJournalBullets(crankDir: string): string[] {
  const text = readJournal(crankDir);
  if (text === null) return [];
  return parseJournal(text).entries.slice(-JOURNAL_INJECT_COUNT).map(headline);
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

  const { preamble, entries } = parseJournal(text);
  if (entries.length <= JOURNAL_KEEP) return;

  try {
    const kept = entries.slice(-JOURNAL_KEEP).flat();
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, [...preamble, ...kept].join("\n"));
    fs.renameSync(tmp, file);
    fs.utimesSync(file, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  } catch {
    // Trim failed: the file is merely longer than intended, which costs nothing
    // at read time — injection reads only the newest entries either way.
  }
}

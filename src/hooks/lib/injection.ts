import * as fs from "node:fs";
import * as path from "node:path";
import { estimateProseTokens } from "./tokens.ts";
import { parseBullets } from "./bullets.ts";
import { JOURNAL_FILE } from "./journal.ts";
import type { AnatomyIndex } from "./store.ts";

// Session-start injection: instructions (carrying a one-line pointer to the
// file map) → staleness/drift notes → recent journal bullets → cerebrum
// excerpt → ADR filenames.
//
// The map itself is deliberately NOT injected. Measured over 67 sessions in a
// real project, inlining it cost 74% of the injection — enough to trip Claude
// Code's silent stdout cliff (ADR 0005) in 9 of 23 sessions — and produced no
// observed use: zero reads, zero navigational citations. The predecessor tool
// shipped a one-line pointer instead, for ~40 bytes, and got more consultation
// than the inlined version did. So: point at anatomy.md, don't recite it.

/**
 * Ceiling on the whole excerpt. Whole bullets cost roughly double what the
 * first-physical-line-only excerpt did, and the real bound on the file is
 * PRUNE_LINE_LIMIT — a nudge agents comply with — so this cap exists to catch
 * a runaway file, not to bind in normal use.
 */
export const CEREBRUM_INJECT_TOKEN_CAP = 1500;
/** Sub-cap on User Preferences, so prefs can't crowd memory out of the excerpt. */
export const PREFS_TOKEN_CAP = 400;
export const ADR_RECENT_COUNT = 20;
export const MEMORY_RECENT_COUNT = 10;

/**
 * Cerebrum sections read as semantic memory, lowercased. `## Memory` is the
 * canonical heading; the other two are read for the installs that predate it,
 * which converge naturally as agents prune. No file is ever rewritten.
 */
const MEMORY_HEADINGS = new Set(["memory", "key learnings", "do-not-repeat"]);
const PREFS_HEADING = "user preferences";

const CEREBRUM_HEADER = "## Cerebrum (.crank/cerebrum.md — full file has more)";

const instructions = (fileCount: number): string => `## crank-mem (project memory)

This project keeps a token-annotated file index in \`.crank/anatomy.md\`, an
agent-maintained memory in \`.crank/cerebrum.md\`, and a session log in
\`.crank/${JOURNAL_FILE}\`.

- \`.crank/anatomy.md\` indexes ${fileCount} file(s) with descriptions, token sizes, and
  per-symbol line ranges — check it before reading any file. Symbol sub-bullets
  give line ranges, so slice-read just what you need (Read with offset/limit,
  or \`sed -n 'START,ENDp' file\`).
- Cerebrum protocol: keep \`.crank/cerebrum.md\` current as you work. The bar is
  low — a one-line bullet is enough, and a slightly redundant entry beats a
  lost one. Record it the moment you learn it, not at the end of the task, and
  append new bullets at the end of the section, newest last:
  - the user corrects you or states a preference → \`## User Preferences\`;
  - anything else worth keeping → \`## Memory\`: a non-obvious project
    convention, a framework/dependency quirk, surprising API behavior, or a
    gotcha that would trip up a fresh session.
  Do NOT record: anything CLAUDE.md, the README, or the code already states; a
  narration of what you just did (that is the journal); a one-time fix that is
  finished; a restatement of an existing bullet. Respect existing entries;
  consolidate or prune a section when it grows bloated or stale.
- Journal protocol: \`.crank/${JOURNAL_FILE}\` is the episodic counterpart — where you
  left off, not what is true. Append one dated bullet
  (\`- YYYY-MM-DD: what you did; where you left off; NEXT: next step\`) at the end
  of a chunk of work; newest last, oldest entries trimmed automatically. The
  \`NEXT:\` clause is what the next session is shown — put the handoff there, last.
- Write cerebrum entries and journal bullets telegram-style: drop articles and
  hedges; keep paths, identifiers, and error strings verbatim.
- ADR protocol: decisions that are hard to reverse, surprising, AND carry a
  real trade-off get an ADR (\`NNNN-slug.md\`, Pocock style) in the ADR
  directory. Existing ADRs are settled — don't relitigate them.`;

export interface InjectionSources {
  cerebrumMd: string | null;
  /** Most recent journal bullets, oldest first (see lib/journal.ts). */
  journalBullets?: string[];
  adrFilenames: string[];
  index: AnatomyIndex;
  /** Appended verbatim near the top when a refresh was skipped/partial. */
  stalenessNote?: string;
  /** Appended below the staleness note when the vendored hooks lag the clone. */
  driftNote?: string;
  adrPath: string;
}

const SEP = "\n\n";
const bytes = (s: string): number => Buffer.byteLength(s, "utf-8");

/**
 * The injected slice of cerebrum.md: User Preferences, then the most recent
 * memory bullets, whole.
 *
 * The file is walked once, top to bottom, and every bullet lands in one of two
 * buckets by the `## ` heading above it — so an unmigrated file's Key Learnings
 * and Do-Not-Repeat sections read as one merged memory section, in DOCUMENT
 * order. Document order matters: an agent that appends a fresh `## Memory` to
 * the bottom of an unmigrated file would, under a fixed section sequence, have
 * its newest bullets sorted to the front and trimmed away first.
 *
 * Bullets arrive whole — wrapped prose, sub-bullets and all (see lib/bullets.ts)
 * — because the first physical line of an agent-written bullet is usually a
 * fragment, and half a learning is worse than none. The file's own headings
 * never appear inside a bucket. Each bucket's label instead names the file's
 * literal heading, the last one of its kind, because agents anchor edits on
 * the label and a label naming a heading the file lacks made those edits miss.
 * Appending under that last heading keeps the newest bullet last, where the
 * recency slice below looks for it.
 *
 * Over either the token cap or `budgetBytes`, the OLDEST memory bullet goes
 * first, then the oldest preference: what an agent just recorded is what the
 * next session most needs, and the header already says the full file has more.
 * Nothing is ever cut mid-bullet.
 */
export function cerebrumExcerpt(md: string, budgetBytes: number): string {
  const prefsLines: string[] = [];
  const memoryLines: string[] = [];
  let prefsHeading = "## User Preferences";
  let memoryHeading = "## Memory";
  let bucket: string[] | null = null;
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim().toLowerCase();
      bucket =
        heading === PREFS_HEADING ? prefsLines : MEMORY_HEADINGS.has(heading) ? memoryLines : null;
      if (bucket === prefsLines) prefsHeading = line.trimEnd();
      if (bucket === memoryLines) memoryHeading = line.trimEnd();
    }
    bucket?.push(line);
  }

  const prefs = parseBullets(prefsLines);
  const memory = parseBullets(memoryLines).slice(-MEMORY_RECENT_COUNT);
  while (prefs.length && estimateProseTokens(prefs.join("\n")) > PREFS_TOKEN_CAP) prefs.shift();

  const render = (): string => {
    const parts: string[] = [];
    if (prefs.length) parts.push(`### User Preferences (in file: ${prefsHeading}, append at its end)`, ...prefs);
    if (memory.length) parts.push(`### Memory (in file: ${memoryHeading}, append at its end)`, ...memory);
    return parts.length ? [CEREBRUM_HEADER, ...parts].join("\n") : "";
  };

  let text = render();
  while (text && (estimateProseTokens(text) > CEREBRUM_INJECT_TOKEN_CAP || bytes(text) > budgetBytes)) {
    if (memory.length) memory.shift();
    else prefs.shift();
    text = render();
  }
  return text;
}

/**
 * Compose the injection under a hard byte cap.
 *
 * Sections are added in priority order and each must fit in what's left, so an
 * over-budget section is dropped rather than allowed to push the whole
 * injection past the cliff. The ADR list is rendered ahead of its turn and its
 * cost reserved, so the cerebrum excerpt — the only part that grows without a
 * natural bound — is trimmed to what remains instead of quietly evicting the
 * ADRs behind it.
 *
 * The instructions are exempt: they carry the cerebrum and ADR protocols, so a
 * budget too small to hold them is a misconfiguration, not a reason to inject a
 * headless fragment. Consequence: the result can exceed `budgetBytes`, but only
 * by the fixed size of the instructions.
 */
export function buildInjection(sources: InjectionSources, budgetBytes: number): string {
  const parts: string[] = [instructions(sources.index.meta.fileCount)];
  let used = bytes(parts[0]!);

  const fit = (section: string): boolean => {
    const cost = bytes(SEP + section);
    if (used + cost > budgetBytes) return false;
    parts.push(section);
    used += cost;
    return true;
  };

  if (sources.stalenessNote) fit(`_Note: ${sources.stalenessNote}_`);
  if (sources.driftNote) fit(`_Note: ${sources.driftNote}_`);

  // Where the last session left off, before the semantic memory: it orients,
  // and a fixed count of length-capped bullets (see journal.ts) keeps it from
  // crowding out the cerebrum excerpt behind it.
  if (sources.journalBullets?.length) {
    fit([`## Journal (recent — .crank/${JOURNAL_FILE})`, ...sources.journalBullets].join("\n"));
  }

  const adrSection = sources.adrFilenames.length
    ? [
        `## ADRs (${sources.adrPath}/ — settled decisions)`,
        ...[...sources.adrFilenames].sort().slice(-ADR_RECENT_COUNT).map((f) => `- ${f}`),
      ].join("\n")
    : null;
  // Reserve only what the ADR list can actually claim. A list too long to fit
  // at all is dropped either way, and holding its bytes back would starve the
  // cerebrum of budget that then goes unspent — losing both sections.
  const adrCost = adrSection ? bytes(SEP + adrSection) : 0;
  const adrReserve = used + adrCost <= budgetBytes ? adrCost : 0;

  if (sources.cerebrumMd) {
    const excerpt = cerebrumExcerpt(sources.cerebrumMd, budgetBytes - used - adrReserve - bytes(SEP));
    if (excerpt) fit(excerpt);
  }

  if (adrSection) fit(adrSection);

  return parts.join(SEP);
}

/** Load ADR filenames (NNNN-*.md) from the configured directory. */
export function listAdrFilenames(projectRoot: string, adrPath: string): string[] {
  try {
    return fs
      .readdirSync(path.join(projectRoot, adrPath))
      .filter((f) => /^\d{4}-.*\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

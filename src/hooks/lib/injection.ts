import * as fs from "node:fs";
import * as path from "node:path";
import { estimateProseTokens } from "./tokens.ts";
import { parseBullets } from "./bullets.ts";
import { JOURNAL_FILE } from "./journal.ts";
import { instructionFiles } from "./hook-io.ts";
import { SOURCE_EXTENSIONS } from "./scanner.ts";
import { symbolsSupported } from "./symbols.ts";
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
/** Recent memory bullets shown whole; 7 rather than 10 leaves room for the index. */
export const MEMORY_RECENT_COUNT = 7;
/** Width of one index entry: a bullet's opening words, enough to grep for. */
export const INDEX_ENTRY_CHARS = 48;
/** First line of every injection; `crank-mem stats` finds it in Codex rollouts. */
export const INJECTION_HEADING = "## crank-mem (project memory)";

/**
 * Cerebrum sections read as semantic memory, lowercased. `## Memory` is the
 * canonical heading; the other two are read for the installs that predate it,
 * which converge naturally as agents prune. No file is ever rewritten.
 */
const MEMORY_HEADINGS = new Set(["memory", "key learnings", "do-not-repeat"]);
const PREFS_HEADING = "user preferences";

const CEREBRUM_HEADER = "## Cerebrum (.crank/cerebrum.md)";

/** Unsupported source extensions named in the pointer, most indexed files first. */
const SYMBOL_GAPS_NAMED = 3;

/**
 * The anatomy.md pointer, stating what the index covers. A pointer that said
 * "check it before reading any file" over a capped index sent OrcaSlicer agents
 * to a map holding none of src/; the cap and the languages without symbols are
 * what an agent needs to know to fall back to search.
 */
function anatomyPointer(index: AnatomyIndex, codex: boolean): string {
  const { fileCount, truncated, candidateCount } = index.meta;
  const counted = truncated && candidateCount !== undefined ? `${fileCount} of ${candidateCount}` : `${fileCount}`;
  // A truncated walk keeps candidateCount only when it came from git's ranked
  // listing; the fallback directory walk stops uncounted, in path order.
  const coverage = !truncated
    ? "That is every indexable file in the project."
    : `It is capped at max_files, active files first, then ${
        candidateCount !== undefined ? "first-party source" : "by path"
      }:\n  a file missing from it may still exist.`;
  const gaps = new Map<string, number>();
  for (const rel of Object.keys(index.files)) {
    const ext = path.extname(rel).toLowerCase();
    if (SOURCE_EXTENSIONS.has(ext) && !symbolsSupported(ext)) gaps.set(ext, (gaps.get(ext) ?? 0) + 1);
  }
  const named = [...gaps]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, SYMBOL_GAPS_NAMED)
    .map(([ext]) => ext);
  const symbols = named.length ? ` (no symbol ranges for ${named.join(", ")} files)` : "";
  const slice = codex ? "`sed -n 'START,ENDp' file`" : "Read with offset/limit, or `sed -n 'START,ENDp' file`";
  return `- \`.crank/anatomy.md\` indexes ${counted} file(s) with descriptions, token sizes,
  and per-symbol line ranges${symbols}.
  ${coverage}
  Use it for token sizes and symbol line ranges before slice-reading a large
  file (${slice}).`;
}

const instructions = (index: AnatomyIndex, codex: boolean): string => `${INJECTION_HEADING}

This project keeps a token-annotated file index in \`.crank/anatomy.md\`, an
agent-maintained memory in \`.crank/cerebrum.md\`, and a session log in
\`.crank/${JOURNAL_FILE}\`.

${anatomyPointer(index, codex)}
- Cerebrum protocol: keep \`.crank/cerebrum.md\` current as you work. The bar is
  low — a one-line bullet is enough. Check for an existing bullet first and
  update it rather than add a near-copy; when replacing, write (supersedes
  YYYY-MM-DD: old claim). Record it the moment you learn it, not at the end of
  the task, and append new bullets at the end of the section, newest last:
  - the user corrects you or states a preference → \`## User Preferences\`;
  - anything else worth keeping → \`## Memory\`: a non-obvious project
    convention, a framework/dependency quirk, surprising API behavior, or a
    gotcha that would trip up a fresh session.
  Do NOT record: anything ${instructionFiles(codex)}, the README, or the code already states; a
  narration of what you just did (that is the journal); a one-time fix that is
  finished. Respect existing entries; consolidate or prune a section when it
  grows bloated or stale.
- Journal protocol: \`.crank/${JOURNAL_FILE}\` is the episodic counterpart — where you
  left off, not what is true. Append one dated bullet
  (\`- YYYY-MM-DD: what you did; where you left off; NEXT: next step\`) at the end
  of a chunk of work; newest last, oldest entries trimmed automatically. The
  next session is shown what the last three entries did, plus the newest one's
  \`NEXT:\` clause — put the handoff there, last.
- Write cerebrum entries and journal bullets telegram-style: drop articles and
  hedges; keep paths, identifiers, and error strings verbatim. Keep each
  cerebrum bullet to about 200 characters at most, and start it with a short
  **subject**: bullets the excerpt leaves out are listed by their first words.
  End each cerebrum bullet with its date, \`(YYYY-MM-DD)\`, and cite code by
  backticked repo path and symbol name, not by line number, which drifts.
- Memory is not proof of current behavior; verify a consequential claim
  against the cited file before relying on it.
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
  /** Codex session: name AGENTS.md alone and no Read tool (ADR 0003). */
  codex?: boolean;
  /** Project root; when set, the excerpt tags cited files that vanished or changed. */
  projectRoot?: string;
  /** Files changed since journal.md's mtime, stated under the journal bullets. */
  journalChanged?: number;
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
 * Every bullet left out, older memory or preferences over PREFS_TOKEN_CAP, is
 * listed after the excerpt by its first INDEX_ENTRY_CHARS characters, so an
 * agent can grep for it. Without the index, a warning that rotated out of the
 * recency slice was gone from every later session while still in the file.
 *
 * Over either the token cap or `budgetBytes`, the oldest memory index entry
 * goes first, then the oldest recent memory bullet, then the preference index
 * entries, then the oldest preference: what an agent just recorded is what the
 * next session most needs, and a user-stated preference outranks anything the
 * agent inferred. Nothing is ever cut mid-bullet.
 *
 * `balanced` drops both index lists first, then the oldest bullet of whichever
 * kind takes more bytes, so a small budget still carries memory: at 2,048 bytes
 * the default order left OrcaSlicer's and takeoff-poc's subagents preferences
 * and no gotcha (ADR 0007).
 */
export function cerebrumExcerpt(md: string, budgetBytes: number, cited?: CitedFiles, balanced = false): string {
  return excerptOf(md, budgetBytes, cited, balanced).text;
}

/** The excerpt and the counts `crank-mem stats` reports from it. */
export interface Excerpt {
  text: string;
  total: number;
  shown: number;
  prefsTotal: number;
  prefsShown: number;
  /** Bullets left out of the excerpt, as written in the file, oldest first. */
  hidden: string[];
}

/** cerebrumExcerpt, with what it kept and left out. */
export function excerptOf(md: string, budgetBytes: number, cited?: CitedFiles, balanced = false): Excerpt {
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

  const allPrefs = parseBullets(prefsLines);
  const allMemory = parseBullets(memoryLines);
  const prefs = [...allPrefs];
  const memory = [...allMemory];
  const total = prefs.length + memory.length;
  const prefsTotal = prefs.length;
  const prefsIndex: string[] = [];
  while (prefs.length && estimateProseTokens(prefs.join("\n")) > PREFS_TOKEN_CAP) {
    prefsIndex.push(indexEntry(prefs.shift()!));
  }
  const prefsOverCap = prefsIndex.length > 0;
  const memoryIndex = memory.splice(0, Math.max(0, memory.length - MEMORY_RECENT_COUNT)).map(indexEntry);
  if (cited) {
    const byName = new Map<string, string[]>();
    for (const rel of Object.keys(cited.index.files)) {
      const name = path.posix.basename(rel);
      byName.set(name, [...(byName.get(name) ?? []), rel]);
    }
    for (const list of [prefs, memory]) list.forEach((b, i) => (list[i] = b + citationTags(b, cited, byName)));
  }

  const render = (): string => {
    if (!prefs.length && !memory.length && !prefsIndex.length && !memoryIndex.length) return "";
    const parts: string[] = [CEREBRUM_HEADER];
    if (prefs.length) parts.push(`### User Preferences (in file: ${prefsHeading}, append at its end)`, ...prefs);
    if (memory.length) parts.push(`### Memory (in file: ${memoryHeading}, append at its end)`, ...memory);
    const hidden = total - prefs.length - memory.length;
    if (hidden) parts.push(`### Not shown (${hidden} of ${total}; grep .crank/cerebrum.md)`);
    if (prefsOverCap) parts.push(`prefs: ${prefs.length} of ${prefsTotal} shown, consolidate`);
    parts.push(...prefsIndex, ...memoryIndex);
    return parts.join("\n");
  };

  const size = (list: string[]): number => bytes(list.join("\n"));
  let text = render();
  while (text && (estimateProseTokens(text) > CEREBRUM_INJECT_TOKEN_CAP || bytes(text) > budgetBytes)) {
    if (memoryIndex.length) memoryIndex.shift();
    else if (balanced && prefsIndex.length) prefsIndex.shift();
    else if (memory.length && !(balanced && size(prefs) > size(memory))) memory.shift();
    else if (prefsIndex.length) prefsIndex.shift();
    else prefs.shift();
    text = render();
  }
  // Every cut above takes from the front, so the hidden bullets are the oldest.
  return {
    text,
    total,
    shown: prefs.length + memory.length,
    prefsTotal,
    prefsShown: prefs.length,
    hidden: [...allPrefs.slice(0, prefsTotal - prefs.length), ...allMemory.slice(0, allMemory.length - memory.length)],
  };
}

/** What the excerpt checks a bullet's citations against. */
export interface CitedFiles {
  index: AnatomyIndex;
  root: string;
}

/** A backticked file citation: a path or basename with an extension, then an optional `:line`. */
const FILE_CITATION = /^([^\s*=:]+\.[A-Za-z]\w*)(?::\d+(?:-\d+)?)?$/;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

/**
 * Tags for the files a bullet cites in backticks: ` [cited file missing: …]`
 * for a path that is neither indexed nor on disk, and ` [cited file modified
 * after this note; check: …]` for an indexed file whose mtime is past the end
 * of the bullet's latest date. Empty when nothing is flagged.
 *
 * A basename resolves by a unique suffix match against the index, because
 * agents cite `geometry.py` far more often than its full path. An unresolved
 * basename is never called missing: the index omits files past max_files and
 * unindexable ones, and a dotted symbol such as `fs.statSync` reads the same.
 * An undated bullet gets no modified tag; a checkout resets mtimes, hence "check".
 */
function citationTags(bullet: string, cited: CitedFiles, byName: Map<string, string[]>): string {
  let noteEndMs: number | null = null;
  for (const [, y, m, d] of bullet.matchAll(ISO_DATE)) {
    const end = new Date(Number(y), Number(m) - 1, Number(d) + 1).getTime();
    if (!Number.isNaN(end) && (noteEndMs === null || end > noteEndMs)) noteEndMs = end;
  }
  const missing = new Set<string>();
  const modified = new Set<string>();
  for (const rel of fileCitations(bullet)) {
    const hits = cited.index.files[rel]
      ? [rel]
      : (byName.get(path.posix.basename(rel)) ?? []).filter((c) => c.endsWith("/" + rel));
    if (hits.length === 1) {
      if (noteEndMs !== null && cited.index.files[hits[0]!]!.mtimeMs > noteEndMs) modified.add(rel);
    } else if (!hits.length && rel.includes("/") && !fs.existsSync(path.join(cited.root, rel))) {
      missing.add(rel);
    }
  }
  return (
    (missing.size ? ` [cited file missing: ${[...missing].join(", ")}]` : "") +
    (modified.size ? ` [cited file modified after this note; check: ${[...modified].join(", ")}]` : "")
  );
}

/**
 * The files a text cites in backticks, as written minus a leading `./` and a
 * `:line` suffix. Spans starting with `-`, `/` or `~` are flags, routes and
 * home paths, and `*` or `=` marks a glob or an assignment, so none of them count.
 */
export function fileCitations(text: string): string[] {
  const cited: string[] = [];
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
    const match = /^[-/~]/.test(span!) ? null : FILE_CITATION.exec(span!);
    if (match) cited.push(match[1]!.replace(/^\.\//, ""));
  }
  return cited;
}

/**
 * One index line for a bullet: its text on one line, cut at a word boundary
 * to INDEX_ENTRY_CHARS, with a code span the cut opened closed again.
 */
function indexEntry(bullet: string): string {
  const flat = bullet.replace(/^- /, "").replace(/\s+/g, " ").trim();
  if (flat.length <= INDEX_ENTRY_CHARS) return `- ${flat}`;
  const space = flat.lastIndexOf(" ", INDEX_ENTRY_CHARS);
  let cut = flat.slice(0, space > 0 ? space : INDEX_ENTRY_CHARS).trimEnd();
  if ((cut.match(/`/g) ?? []).length % 2) cut += "`";
  return `- ${cut}…`;
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
  return composeInjection(sources, budgetBytes).text;
}

/** buildInjection, with the cerebrum excerpt it carries (null without a cerebrum). */
export function composeInjection(
  sources: InjectionSources,
  budgetBytes: number,
): { text: string; excerpt: Excerpt | null } {
  const parts: string[] = [instructions(sources.index, sources.codex ?? false)];
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
    const changed =
      sources.journalChanged === undefined
        ? []
        : [`${sources.journalChanged} file(s) changed since the last journal entry.`];
    fit([`## Journal (recent — .crank/${JOURNAL_FILE})`, ...sources.journalBullets, ...changed].join("\n"));
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

  let excerpt: Excerpt | null = null;
  if (sources.cerebrumMd) {
    excerpt = excerptOf(
      sources.cerebrumMd,
      budgetBytes - used - adrReserve - bytes(SEP),
      sources.projectRoot ? { index: sources.index, root: sources.projectRoot } : undefined,
    );
    if (excerpt.text) fit(excerpt.text);
  }

  if (adrSection) fit(adrSection);

  return { text: parts.join(SEP), excerpt };
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

import * as fs from "node:fs";
import * as path from "node:path";
import { estimateProseTokens } from "./tokens.ts";
import { ISO_DATE, parseBullets } from "./bullets.ts";
import { SOURCE_EXTENSIONS } from "./scanner.ts";
import { symbolsSupported } from "./symbols.ts";
import { CEREBRUM_FILE } from "./cerebrum-files.ts";
import {
  MEMORY_NEWER_NOTE,
  MEMORY_OLDER_NOTE,
  formatLine,
  memoryPath,
  openMemory,
  type ObservationLine,
} from "./memory.ts";
import { digestGate, type DigestGate } from "./spool.ts";
import type { CrankConfig } from "./config.ts";
import type { AnatomyIndex } from "./store.ts";

// Session-start injection: instructions (carrying a one-line pointer to the
// file map, the code pointer, and the recall pointer when recallApplies) → staleness/drift/
// capture notes → the recall sections from memory.db (next steps, only while
// digests run, then recent memory) → cerebrum excerpt → ADR filenames. No
// digest state asks the agent to keep memory: the instructions carry no upkeep
// protocol and the excerpt labels its sections by name alone.
//
// The map is not injected, only a one-line pointer to it. Inlining the map
// cost 74% of the injection; ADR 0005 records the measurement.

/** Ceiling on the whole excerpt, set to catch a runaway file. */
export const CEREBRUM_INJECT_TOKEN_CAP = 1500;
/** Sub-cap on User Preferences, so prefs can't crowd memory out of the excerpt. */
export const PREFS_TOKEN_CAP = 400;
export const ADR_RECENT_COUNT = 20;
/** Recent memory bullets shown whole; older memory bullets go to the index. */
export const MEMORY_RECENT_COUNT = 7;
/** Width of one index entry: a bullet's opening words, enough to grep for. */
export const INDEX_ENTRY_CHARS = 48;
/**
 * Bytes of memory index, about 11 entries, kept ahead of the oldest recent
 * bullet under budget pressure, so a few long recent bullets cannot push every
 * hidden bullet's name out of the excerpt.
 */
export const MEMORY_INDEX_ALLOWANCE_BYTES = 600;
/** First line of every injection; `crank-mem stats` finds it in Codex rollouts. */
export const INJECTION_HEADING = "## crank-mem (project memory)";
/** Points at the memory store's read commands; see recallApplies for when it shows. */
export const RECALL_BULLET =
  "- Past work: `crank-mem search <query>` finds stored observations by meaning or keyword, `crank-mem timeline <id>` shows what surrounds one, and `crank-mem get <id...>` prints them in full.";
/** Points at the code commands; session start and SubagentStart show it ungated. */
export const CODE_BULLET =
  "- Code: `crank-mem outline <file>` lists a source file's symbols with line ranges, and `crank-mem unfold <file> <symbol|line>` prints one in full.";

/**
 * Cerebrum sections read as semantic memory, lowercased. `## Memory` is the
 * canonical heading; the other two are read for the installs that predate it.
 * Legacy headings are read as-is: consolidation edits bullets, never headings.
 */
const MEMORY_HEADINGS = new Set(["memory", "key learnings", "do-not-repeat"]);
const PREFS_HEADING = "user preferences";

const CEREBRUM_HEADER = "## Cerebrum (.crank/cerebrum.md)";

/** Unsupported source extensions named in the pointer, most indexed files first. */
const SYMBOL_GAPS_NAMED = 3;

/**
 * The anatomy.md pointer, stating what the index covers. A capped index can
 * omit whole directories, so the pointer names the cap and the languages
 * without symbol ranges, which tell an agent when to fall back to search.
 */
function anatomyPointer(index: AnatomyIndex, codex: boolean): string {
  const { fileCount, truncated, candidateCount } = index.meta;
  const counted =
    truncated && candidateCount !== undefined
      ? `${fileCount} of ${candidateCount}`
      : `${fileCount}`;
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
    if (SOURCE_EXTENSIONS.has(ext) && !symbolsSupported(ext))
      gaps.set(ext, (gaps.get(ext) ?? 0) + 1);
  }
  const named = [...gaps]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, SYMBOL_GAPS_NAMED)
    .map(([ext]) => ext);
  const symbols = named.length ? ` (no symbol ranges for ${named.join(", ")} files)` : "";
  const slice = codex
    ? "`sed -n 'START,ENDp' file`"
    : "Read with offset/limit, or `sed -n 'START,ENDp' file`";
  return `- \`.crank/anatomy.md\` indexes ${counted} file(s) with descriptions, token sizes,
  and per-symbol line ranges${symbols}.
  ${coverage}
  Use it for token sizes and symbol line ranges before slice-reading a large
  file (${slice}).`;
}

/** Bytes of the newest digest's next steps worth a section; longer ones are left to `crank-mem get`. */
const NEXT_STEPS_MAX_BYTES = 512;
/** Byte cap on the recent memory section, heading included. */
const RECENT_MEMORY_MAX_BYTES = 1536;
/** Observations read for the recent memory section, before the byte cap. */
const RECENT_MEMORY_ROWS = 50;

function instructions(index: AnatomyIndex, codex: boolean, recall: boolean): string {
  const lead =
    "This project keeps a token-annotated file index in `.crank/anatomy.md` and\nproject memory in `.crank/cerebrum.md`.";
  const bullets = [
    anatomyPointer(index, codex),
    CODE_BULLET,
    ...(recall ? [RECALL_BULLET] : []),
    PROOF_AND_ADR_BULLETS,
  ];
  return `${INJECTION_HEADING}\n\n${lead}\n\n${bullets.join("\n")}`;
}

const PROOF_AND_ADR_BULLETS = `- Memory is not proof of current behavior; verify a consequential claim
  against the cited file before relying on it.
- ADR protocol: decisions that are hard to reverse, surprising, AND carry a
  real trade-off get an ADR (\`NNNN-slug.md\`, Pocock style) in the ADR
  directory. Existing ADRs are settled — don't relitigate them.`;

export interface InjectionSources {
  cerebrumMd: string | null;
  adrFilenames: string[];
  index: AnatomyIndex;
  /** Shown as an italic note near the top when a refresh was skipped or partial. */
  stalenessNote?: string;
  /** Appended below the staleness note when the vendored hooks lag the clone. */
  driftNote?: string;
  adrPath: string;
  /** Codex session: name AGENTS.md alone and no Read tool (ADR 0003). */
  codex?: boolean;
  /** Project root; when set, the excerpt tags cited files that vanished or changed. */
  projectRoot?: string;
  /** The session's digest gate: `gate.running` means digests run for this session, so recall applies with no store yet. Absent: digests off. */
  gate?: DigestGate;
  /** What the memory store offers this session. Absent: no recall section or pointer. */
  recall?: Recall;
  /** Capture-health notes, shown italic after the drift note. */
  captureNotes?: string[];
}

type Recall =
  | { status: "open"; nextSteps: string | null; recent: ObservationLine[] }
  | { status: "missing" | "older" | "newer" | "unreadable" };

/** The recall bullet shows with a readable store, and while digests run with none yet, since they will fill it. */
export function recallApplies(running: boolean, status: Recall["status"]): boolean {
  return status === "open" || (running && status === "missing");
}

/** Notes on the health of memory capture for this project, most urgent first. Never throws. */
export function captureNotes(gate: DigestGate, status: Recall["status"]): string[] {
  const notes: string[] = [];
  if (gate.stop)
    notes.push(
      `crank-mem digests stopped (${gate.stop.reason}): run \`crank-mem digest resume\` once that is fixed.`,
    );
  if (status === "newer") notes.push(MEMORY_NEWER_NOTE);
  if (status === "older") notes.push(MEMORY_OLDER_NOTE);
  if (gate.stalled) {
    notes.push(
      "crank-mem: a session here has waited over 2 hours for its digest; see `crank-mem stats`.",
    );
  }
  return notes;
}

const SEP = "\n\n";
const bytes = (s: string): number => Buffer.byteLength(s, "utf-8");

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
 * never appear inside a bucket; each bucket is labelled by its name alone.
 *
 * Every bullet left out, older memory or preferences over PREFS_TOKEN_CAP, is
 * listed after the excerpt by its first INDEX_ENTRY_CHARS characters, so an
 * agent can grep for it. Without the index, a warning that rotated out of the
 * recency slice was gone from every later session while still in the file.
 *
 * Over either the token cap or `budgetBytes`, the oldest memory index entry
 * goes first while the memory index is over MEMORY_INDEX_ALLOWANCE_BYTES, then
 * the oldest recent memory bullet, which joins the index, then the rest of the
 * memory index, then the preference index entries, then the oldest preference:
 * what an agent just recorded is what the next session most needs, and a
 * user-stated preference outranks anything the agent inferred. Nothing is ever
 * cut mid-bullet.
 *
 * `balanced` drops both index lists first, then the oldest bullet of whichever
 * kind takes more bytes, so a 2,048-byte budget still carries a memory bullet
 * when preferences alone would fill it. ADR 0007 records the measurements.
 */
export function excerptOf(
  md: string,
  budgetBytes: number,
  cited?: CitedFiles,
  balanced = false,
): Excerpt {
  const prefsLines: string[] = [];
  const memoryLines: string[] = [];
  let bucket: string[] | null = null;
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim().toLowerCase();
      bucket =
        heading === PREFS_HEADING ? prefsLines : MEMORY_HEADINGS.has(heading) ? memoryLines : null;
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
  const memoryIndex = memory
    .splice(0, Math.max(0, memory.length - MEMORY_RECENT_COUNT))
    .map(indexEntry);
  if (cited) {
    const byName = basenameIndex(cited.index);
    for (const list of [prefs, memory])
      list.forEach((b, i) => (list[i] = b + citationTags(b, cited, byName)));
  }

  const render = (): string => {
    if (!prefs.length && !memory.length && !prefsIndex.length && !memoryIndex.length) return "";
    const parts: string[] = [CEREBRUM_HEADER];
    if (prefs.length) parts.push("### User Preferences", ...prefs);
    if (memory.length) parts.push("### Memory", ...memory);
    const hidden = total - prefs.length - memory.length;
    if (hidden) parts.push(`### Not shown (${hidden} of ${total}; grep .crank/cerebrum.md)`);
    parts.push(...prefsIndex, ...memoryIndex);
    return parts.join("\n");
  };

  const size = (list: string[]): number => bytes(list.join("\n"));
  let text = render();
  while (
    text &&
    (estimateProseTokens(text) > CEREBRUM_INJECT_TOKEN_CAP || bytes(text) > budgetBytes)
  ) {
    const indexOver =
      balanced || !memory.length || size(memoryIndex) > MEMORY_INDEX_ALLOWANCE_BYTES;
    if (memoryIndex.length && indexOver) memoryIndex.shift();
    else if (balanced && prefsIndex.length) prefsIndex.shift();
    else if (memory.length && !(balanced && size(prefs) > size(memory))) {
      const dropped = memory.shift()!;
      if (!balanced) memoryIndex.push(indexEntry(dropped));
    } else if (prefsIndex.length) prefsIndex.shift();
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
    hidden: [
      ...allPrefs.slice(0, prefsTotal - prefs.length),
      ...allMemory.slice(0, allMemory.length - memory.length),
    ],
  };
}

/** What the excerpt checks a bullet's citations against. */
export interface CitedFiles {
  index: AnatomyIndex;
  root: string;
}

/** A backticked file citation: a path or basename with an extension, then an optional `:line`. */
const FILE_CITATION = /^([^\s*=:]+\.[A-Za-z]\w*)(?::\d+(?:-\d+)?)?$/;

/** The index's files grouped by basename, for resolving a cited basename. */
export function basenameIndex(index: AnatomyIndex): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const rel of Object.keys(index.files)) {
    const name = path.posix.basename(rel);
    byName.set(name, [...(byName.get(name) ?? []), rel]);
  }
  return byName;
}

/**
 * The files a bullet cites in backticks that are missing or modified, each
 * listed once. Missing: a path that is neither indexed nor on disk. Modified:
 * an indexed file whose mtime is past `sinceMs`, or, with `sinceMs` null, past
 * the end of the bullet's latest date; an undated bullet then has none.
 *
 * A basename resolves by a unique suffix match against the index, because
 * agents cite `geometry.py` far more often than its full path. An unresolved
 * basename is never called missing: the index omits files past max_files and
 * unindexable ones, and a dotted symbol such as `fs.statSync` reads the same.
 */
export function citationStatus(
  bullet: string,
  cited: CitedFiles,
  byName: Map<string, string[]>,
  sinceMs: number | null,
): { missing: string[]; modified: string[] } {
  let cutoffMs = sinceMs;
  if (cutoffMs === null) {
    for (const [, y, m, d] of bullet.matchAll(ISO_DATE)) {
      const end = new Date(Number(y), Number(m) - 1, Number(d) + 1).getTime();
      if (cutoffMs === null || end > cutoffMs) cutoffMs = end;
    }
  }
  const missing = new Set<string>();
  const modified = new Set<string>();
  for (const rel of fileCitations(bullet)) {
    const hits = cited.index.files[rel]
      ? [rel]
      : (byName.get(path.posix.basename(rel)) ?? []).filter((c) => c.endsWith("/" + rel));
    if (hits.length === 1) {
      if (cutoffMs !== null && cited.index.files[hits[0]!]!.mtimeMs > cutoffMs) modified.add(rel);
    } else if (!hits.length && rel.includes("/") && !fs.existsSync(path.join(cited.root, rel))) {
      missing.add(rel);
    }
  }
  return { missing: [...missing], modified: [...modified] };
}

/**
 * Tags for a bullet's flagged citations: ` [cited file missing: …]` and
 * ` [cited file modified after this note; check: …]`, empty when nothing is
 * flagged. A checkout resets mtimes, hence "check".
 */
function citationTags(bullet: string, cited: CitedFiles, byName: Map<string, string[]>): string {
  const { missing, modified } = citationStatus(bullet, cited, byName, null);
  return (
    (missing.length ? ` [cited file missing: ${missing.join(", ")}]` : "") +
    (modified.length ? ` [cited file modified after this note; check: ${modified.join(", ")}]` : "")
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

/** What an injection showed, section by section, for its usage line. */
export interface Shown {
  /** Ids of the recent memory lines, newest first; empty when that section did not fit. */
  recentIds: number[];
  nextSteps: boolean;
  cerebrum: boolean;
  adrs: boolean;
  /** Staleness, drift and capture notes that fit. */
  notes: number;
  recallPointer: boolean;
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
 * The instructions are exempt: they carry the file-map pointer and the ADR protocol, so a
 * budget too small to hold them is a misconfiguration, not a reason to inject a
 * headless fragment. Consequence: the result can exceed `budgetBytes`, but only
 * by the fixed size of the instructions.
 *
 * Returns the text, the excerpt counts that crank-mem stats reports (a null
 * excerpt without a cerebrum), and what each section showed.
 */
export function composeInjection(
  sources: InjectionSources,
  budgetBytes: number,
): { text: string; excerpt: Excerpt | null; shown: Shown } {
  const running = sources.gate?.running ?? false;
  const recall = sources.recall;
  const recallPointer = recall ? recallApplies(running, recall.status) : false;
  const parts: string[] = [instructions(sources.index, sources.codex ?? false, recallPointer)];
  const shown: Shown = {
    recentIds: [],
    nextSteps: false,
    cerebrum: false,
    adrs: false,
    notes: 0,
    recallPointer,
  };
  let used = bytes(parts[0]!);

  const fit = (section: string): boolean => {
    const cost = bytes(SEP + section);
    if (used + cost > budgetBytes) return false;
    parts.push(section);
    used += cost;
    return true;
  };

  const notes = [sources.stalenessNote, sources.driftNote, ...(sources.captureNotes ?? [])];
  for (const note of notes) if (note && fit(`_Note: ${note}_`)) shown.notes++;

  if (recall?.status === "open") {
    const { nextSteps, recent } = recall;
    if (nextSteps !== null && bytes(nextSteps) <= NEXT_STEPS_MAX_BYTES) {
      shown.nextSteps = fit(`## Next steps (last digested session)\n${nextSteps}`);
    }
    // Newest first, so the cap drops the oldest whole lines.
    const lines = recent.map((line) => ({ id: line.id, text: formatLine(line) }));
    const section = () => ["## Recent memory", ...lines.map((l) => l.text)].join("\n");
    while (lines.length && bytes(section()) > RECENT_MEMORY_MAX_BYTES) lines.pop();
    if (lines.length && fit(section())) shown.recentIds = lines.map((l) => l.id);
  }

  const adrSection = sources.adrFilenames.length
    ? [
        `## ADRs (${sources.adrPath}/ — settled decisions)`,
        ...[...sources.adrFilenames]
          .sort()
          .slice(-ADR_RECENT_COUNT)
          .map((f) => `- ${f}`),
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
    if (excerpt.text) shown.cerebrum = fit(excerpt.text);
  }

  if (adrSection) shown.adrs = fit(adrSection);

  return { text: parts.join(SEP), excerpt, shown };
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

/**
 * The on-disk sources of a session-start injection, shared by the hook and
 * `crank-mem stats`, for a Codex session when `codex` is set. The caller adds
 * the staleness, drift and capture notes. Never throws.
 */
export function injectionSources(
  root: string,
  crankDir: string,
  config: CrankConfig,
  index: AnatomyIndex,
  codex: boolean,
): InjectionSources & { codex: boolean; recall: Recall; gate: DigestGate } {
  let cerebrumMd: string | null = null;
  try {
    cerebrumMd = fs.readFileSync(path.join(crankDir, CEREBRUM_FILE), "utf-8");
  } catch {}

  const gate = digestGate(config, codex, root);
  const recall = readRecall(root, gate);

  return {
    cerebrumMd,
    adrFilenames: listAdrFilenames(root, config.adr_path),
    index,
    adrPath: config.adr_path,
    projectRoot: root,
    codex,
    recall,
    gate,
  };
}

function readRecall(root: string, gate: DigestGate): Recall {
  const opened = openMemory(memoryPath(root), "read");
  if (opened.status !== "open") return { status: opened.status };
  const { memory } = opened;
  try {
    return {
      status: "open",
      nextSteps: gate.running && gate.drained ? memory.latestNextSteps() : null,
      recent: memory.recent(RECENT_MEMORY_ROWS),
    };
  } catch {
    return { status: "unreadable" };
  } finally {
    memory.close();
  }
}

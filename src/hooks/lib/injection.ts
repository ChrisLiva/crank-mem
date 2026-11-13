import * as fs from "node:fs";
import * as path from "node:path";
import { estimateProseTokens } from "./tokens.ts";
import { parseBullets } from "./bullets.ts";
import { citationCheck, type CitationCheck } from "./citations.ts";
import { SOURCE_EXTENSIONS } from "./scanner.ts";
import { symbolsSupported } from "./symbols.ts";
import { CEREBRUM_FILE } from "./cerebrum-files.ts";
import { debugEvent } from "./debug.ts";
import { driftNote } from "./drift.ts";
import {
  MEMORY_NEWER_NOTE,
  MEMORY_OLDER_NOTE,
  formatLine,
  memoryPath,
  memoryStatus,
  openMemory,
} from "./memory.ts";
import { linkedProjects } from "./registry.ts";
import { digestGate, type DigestGate } from "./spool.ts";
import type { CrankConfig } from "./config.ts";
import { loadIndex, type AnatomyIndex } from "./store.ts";
import type { UsageEvent } from "./usage.ts";
import type { ObservationLine } from "./wire.ts";

// Session-start injection: instructions (carrying a one-line pointer to the
// file map, the code pointer, and the recall pointer when recallApplies) → staleness/drift/
// capture notes → the recall sections from memory.db (next steps, only while
// digests run, then recent memory) → cerebrum excerpt → ADR filenames. No
// digest state asks the agent to keep memory: the excerpt labels its sections
// by name alone.
//
// The map is not injected, only a one-line pointer to it. Inlining the map
// cost 74% of the injection; ADR 0005 records the measurement.

/** Ceiling on the whole excerpt, set to catch a runaway file. */
const CEREBRUM_INJECT_TOKEN_CAP = 1500;
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
const MEMORY_INDEX_ALLOWANCE_BYTES = 600;
/** First line of every injection; `crank-mem stats` finds it in Codex rollouts. */
export const INJECTION_HEADING = "## crank-mem (project memory)";
/** Points at the memory store's read commands; see recallApplies for when it shows. */
export const RECALL_BULLET =
  "- Past work: before you change how an area behaves, debug a failure again, or act on earlier work the user mentions, run `crank-mem search <query>`; open any `#id` shown here or in file history with `crank-mem get <id...>`, and `crank-mem timeline <id>` shows what surrounds one.";
/** Points at the code commands; session start and SubagentStart show it ungated. */
export const CODE_BULLET =
  "- Code: `crank-mem outline <file>` lists a source file's symbols with line ranges, and `crank-mem unfold <file> <symbol|line>` prints one in full.";

/**
 * Cerebrum sections read as memory bullets, lowercased. `## Memory` is the
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

function recallBullets(linked: string[]): string[] {
  return linked.length
    ? [RECALL_BULLET, `- Search also covers linked projects: ${linked.join(", ")}.`]
    : [RECALL_BULLET];
}

function instructions(
  index: AnatomyIndex,
  codex: boolean,
  recall: boolean,
  linked: string[],
): string {
  const lead =
    "This project keeps a token-annotated file index in `.crank/anatomy.md` and\nproject memory in `.crank/cerebrum.md`.";
  const bullets = [
    anatomyPointer(index, codex),
    CODE_BULLET,
    ...(recall ? recallBullets(linked) : []),
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
  /** Italic notes near the top, in display order. Absent: none. */
  notes?: string[];
  adrPath: string;
  /** Codex session: name AGENTS.md alone and no Read tool (ADR 0003). */
  codex?: boolean;
  /** Project root; when set, the excerpt tags cited files that vanished or changed. */
  projectRoot?: string;
  /** Digests run for this session, so recall applies with no store yet. Absent: false. */
  running?: boolean;
  /** What the memory store offers this session. Absent: no recall section or pointer. */
  recall?: Recall;
}

type Recall =
  | {
      status: "open";
      nextSteps: string | null;
      recent: ObservationLine[];
      linked: { name: string; root: string }[];
    }
  | { status: "missing" | "older" | "newer" | "unreadable" };

/** The recall bullet shows with a readable store, and while digests run with none yet, since they will fill it. */
function recallApplies(running: boolean, status: Recall["status"]): boolean {
  return status === "open" || (running && status === "missing");
}

/** Notes on the health of memory capture for this project, most urgent first. Never throws. */
function captureNotes(gate: DigestGate, status: Recall["status"]): string[] {
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
 * Every bullet lands in one of two buckets by the `## ` heading above it, in
 * document order, so an unmigrated file's Key Learnings and Do-Not-Repeat
 * sections read as one merged memory section.
 *
 * Bullets arrive whole, wrapped prose and sub-bullets included (see
 * lib/bullets.ts): half a learning is worse than none. The file's own headings
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
 * the newest bullets consolidation added are what the next session most needs,
 * and a user-stated preference outranks anything the agent inferred.
 *
 * `balanced` drops both index lists first, then the oldest bullet of whichever
 * kind takes more bytes, so a 2,048-byte budget still carries a memory bullet
 * when preferences alone would fill it. ADR 0007 records the measurements.
 */
export function excerptOf(
  md: string,
  budgetBytes: number,
  cited?: CitationCheck,
  balanced = false,
): Excerpt {
  const sections = cerebrumSections(md);
  const allPrefs = parseBullets(sections.prefs);
  const allMemory = parseBullets(sections.memory);
  const prefs = [...allPrefs];
  const memory = [...allMemory];
  const total = prefs.length + memory.length;
  const prefsTotal = prefs.length;
  const prefsIndex = capPrefs(prefs);
  const memoryIndex = memory
    .splice(0, Math.max(0, memory.length - MEMORY_RECENT_COUNT))
    .map(indexEntry);
  if (cited) {
    for (const list of [prefs, memory])
      list.forEach((b, i) => (list[i] = b + citationTags(b, cited)));
  }

  const state: ExcerptState = { prefs, memory, prefsIndex, memoryIndex, total };
  let text = renderExcerpt(state);
  while (
    text &&
    (estimateProseTokens(text) > CEREBRUM_INJECT_TOKEN_CAP || bytes(text) > budgetBytes)
  ) {
    shedOne(state, balanced);
    text = renderExcerpt(state);
  }
  // Every cut takes from the front, so the hidden bullets are the oldest.
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

/** The excerpt's bullet and index lists; `shedOne` cuts each from the front in place. */
interface ExcerptState {
  prefs: string[];
  memory: string[];
  prefsIndex: string[];
  memoryIndex: string[];
  total: number;
}

/** The lines under the preferences heading and under every memory heading, headings included. */
function cerebrumSections(md: string): { prefs: string[]; memory: string[] } {
  const prefs: string[] = [];
  const memory: string[] = [];
  let bucket: string[] | null = null;
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim().toLowerCase();
      bucket = heading === PREFS_HEADING ? prefs : MEMORY_HEADINGS.has(heading) ? memory : null;
    }
    bucket?.push(line);
  }
  return { prefs, memory };
}

/** Moves the oldest preferences into index entries until the rest fit PREFS_TOKEN_CAP. */
function capPrefs(prefs: string[]): string[] {
  const prefsIndex: string[] = [];
  while (prefs.length && estimateProseTokens(prefs.join("\n")) > PREFS_TOKEN_CAP) {
    prefsIndex.push(indexEntry(prefs.shift()!));
  }
  return prefsIndex;
}

function renderExcerpt(state: ExcerptState): string {
  const { prefs, memory, prefsIndex, memoryIndex, total } = state;
  if (!prefs.length && !memory.length && !prefsIndex.length && !memoryIndex.length) return "";
  const parts: string[] = [CEREBRUM_HEADER];
  if (prefs.length) parts.push("### User Preferences", ...prefs);
  if (memory.length) parts.push("### Memory", ...memory);
  const hidden = total - prefs.length - memory.length;
  if (hidden) parts.push(`### Not shown (${hidden} of ${total}; grep .crank/cerebrum.md)`);
  parts.push(...prefsIndex, ...memoryIndex);
  return parts.join("\n");
}

function listBytes(list: string[]): number {
  return bytes(list.join("\n"));
}

/** One cut by the drop rule `excerptOf` documents. */
function shedOne(state: ExcerptState, balanced: boolean): void {
  const { prefs, memory, prefsIndex, memoryIndex } = state;
  const indexOver =
    balanced || !memory.length || listBytes(memoryIndex) > MEMORY_INDEX_ALLOWANCE_BYTES;
  if (memoryIndex.length && indexOver) memoryIndex.shift();
  else if (balanced && prefsIndex.length) prefsIndex.shift();
  else if (memory.length && !(balanced && listBytes(prefs) > listBytes(memory))) {
    const dropped = memory.shift()!;
    if (!balanced) memoryIndex.push(indexEntry(dropped));
  } else if (prefsIndex.length) prefsIndex.shift();
  else prefs.shift();
}

/**
 * Tags for a bullet's flagged citations: ` [cited file missing: …]` and
 * ` [cited file modified after this note; check: …]`, empty when nothing is
 * flagged. A checkout resets mtimes, hence "check".
 */
function citationTags(bullet: string, check: CitationCheck): string {
  const { missing, modified } = check.status(bullet, null);
  return (
    (missing.length ? ` [cited file missing: ${missing.join(", ")}]` : "") +
    (modified.length ? ` [cited file modified after this note; check: ${modified.join(", ")}]` : "")
  );
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
  const running = sources.running ?? false;
  const recall = sources.recall;
  const recallPointer = recall ? recallApplies(running, recall.status) : false;
  const links = recall?.status === "open" ? recall.linked : [];
  const parts: string[] = [
    instructions(
      sources.index,
      sources.codex ?? false,
      recallPointer,
      links.map((p) => p.name),
    ),
  ];
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

  shown.notes = noteSections(sources.notes ?? [], fit);

  if (recall?.status === "open") Object.assign(shown, recallSections(recall, fit));

  const adrSection = adrSectionOf(sources);
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
      sources.projectRoot
        ? citationCheck(
            { root: sources.projectRoot, index: sources.index },
            { resolve: () => links },
          )
        : undefined,
    );
    if (excerpt.text) shown.cerebrum = fit(excerpt.text);
  }

  if (adrSection) shown.adrs = fit(adrSection);

  return { text: parts.join(SEP), excerpt, shown };
}

function noteSections(notes: string[], fit: (section: string) => boolean): number {
  let count = 0;
  for (const note of notes) if (note && fit(`_Note: ${note}_`)) count++;
  return count;
}

/** Add the next steps and recent memory sections through `fit`; returns what they showed. */
function recallSections(
  recall: Extract<Recall, { status: "open" }>,
  fit: (section: string) => boolean,
): Pick<Shown, "nextSteps" | "recentIds"> {
  const { nextSteps, recent } = recall;
  const shown: Pick<Shown, "nextSteps" | "recentIds"> = { nextSteps: false, recentIds: [] };
  if (nextSteps !== null && bytes(nextSteps) <= NEXT_STEPS_MAX_BYTES) {
    shown.nextSteps = fit(`## Next steps (last digested session)\n${nextSteps}`);
  }
  // Newest first, so the cap drops the oldest whole lines.
  const lines = recent.map((line) => ({ id: line.id, text: formatLine(line) }));
  const section = () =>
    ["## Recent memory (open one: `crank-mem get <id>`)", ...lines.map((l) => l.text)].join("\n");
  while (lines.length && bytes(section()) > RECENT_MEMORY_MAX_BYTES) lines.pop();
  if (lines.length && fit(section())) shown.recentIds = lines.map((l) => l.id);
  return shown;
}

/** The ADR section: the newest ADR_RECENT_COUNT filenames, or null without ADRs. */
function adrSectionOf(sources: InjectionSources): string | null {
  if (!sources.adrFilenames.length) return null;
  return [
    `## ADRs (${sources.adrPath}/ — settled decisions)`,
    ...[...sources.adrFilenames]
      .sort()
      .slice(-ADR_RECENT_COUNT)
      .map((f) => `- ${f}`),
  ].join("\n");
}

/** Load ADR filenames (NNNN-*.md) from the configured directory. */
function listAdrFilenames(projectRoot: string, adrPath: string): string[] {
  try {
    return fs
      .readdirSync(path.join(projectRoot, adrPath))
      .filter((f) => /^\d{4}-.*\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

/** Excerpt budget per spawn: a quarter of the session injection, paid per subagent. */
const SUBAGENT_EXCERPT_BYTES = 2048;
const SUBAGENT_EXCERPT_LABEL =
  "- Excerpt of `.crank/cerebrum.md`, this project's memory; grep it for more. Memory is not proof: verify a claim against the cited file before relying on it.";

type SubagentStartUsage = Extract<UsageEvent, { channel: "subagent-start" }>;

/**
 * The SubagentStart injection. Read-only, with no index refresh: a compact
 * cerebrum excerpt labelled by section name, balanced at SUBAGENT_EXCERPT_BYTES,
 * CODE_BULLET (the outline/unfold pointer) with no gate, so a project root
 * always yields an injection, plus the recall pointer where recallApplies.
 * Returns the text and the usage event; the caller records the event.
 */
export function subagentInjection(
  root: string,
  crankDir: string,
  config: CrankConfig,
  opts: { agentType: string | null },
): { text: string; usage: SubagentStartUsage } {
  const running = digestGate(config, false, root).running;
  const recall = recallApplies(running, memoryStatus(memoryPath(root)));

  const md = readCerebrum(crankDir);
  // Balanced: at this budget the session-start order leaves no room for memory.
  const excerpt = md
    ? excerptOf(
        md,
        SUBAGENT_EXCERPT_BYTES,
        citationCheck({ root, index: loadIndex(crankDir) }),
        true,
      ).text
    : "";

  const lines = [INJECTION_HEADING];
  if (excerpt) lines.push(SUBAGENT_EXCERPT_LABEL);
  lines.push(CODE_BULLET);
  if (recall) lines.push(RECALL_BULLET);
  if (excerpt) lines.push("", excerpt);
  return {
    text: lines.join("\n"),
    usage: {
      channel: "subagent-start",
      agentType: opts.agentType,
      excerptBytes: bytes(excerpt),
      recallPointer: recall,
    },
  };
}

/** The one read of cerebrum.md; any read error reads as absent. */
export function readCerebrum(crankDir: string): string | null {
  try {
    return fs.readFileSync(path.join(crankDir, CEREBRUM_FILE), "utf-8");
  } catch {
    return null;
  }
}

type SessionStartUsage = Extract<UsageEvent, { channel: "session-start" }>;

/**
 * The SessionStart injection, for a Codex session when `opts.codex` is set.
 * Gathers every source and adds the drift and capture notes; the caller
 * passes the staleness note. Returns the text, the excerpt `crank-mem stats`
 * reports and the usage event; the caller records the event.
 */
export function sessionStartInjection(
  root: string,
  crankDir: string,
  config: CrankConfig,
  index: AnatomyIndex,
  opts: { codex: boolean; source: string | null; stalenessNote: string | null },
): { text: string; excerpt: Excerpt | null; usage: SessionStartUsage } {
  const gate = digestGate(config, opts.codex, root);
  const recall = readRecall(root, gate);
  const drift = driftNote(config);
  const notes = [opts.stalenessNote, drift, ...captureNotes(gate, recall.status)].filter(
    (note) => note !== null,
  );
  const sources = {
    cerebrumMd: readCerebrum(crankDir),
    adrFilenames: listAdrFilenames(root, config.adr_path),
    index,
    adrPath: config.adr_path,
    projectRoot: root,
    codex: opts.codex,
    recall,
    running: gate.running,
    notes,
  } satisfies InjectionSources;
  const { text, excerpt, shown } = composeInjection(sources, config.injection_budget_bytes);
  debugEvent("injected", {
    source: opts.source,
    fileCount: index.meta.fileCount,
    injectionTokens: estimateProseTokens(text),
    // Bytes bind, not tokens: see injection_budget_bytes in config.ts.
    injectionBytes: bytes(text),
    budgetBytes: config.injection_budget_bytes,
    hasCerebrum: sources.cerebrumMd !== null,
    drift: drift !== null,
    adrCount: sources.adrFilenames.length,
    stale: opts.stalenessNote !== null,
  });
  return {
    text,
    excerpt,
    usage: {
      channel: "session-start",
      source: opts.source,
      ids: shown.recentIds,
      nextSteps: shown.nextSteps,
      cerebrum: shown.cerebrum,
      adrs: shown.adrs,
      cerebrumBullets: excerpt ? { shown: excerpt.shown, total: excerpt.total } : null,
      bytes: bytes(text),
      budget: config.injection_budget_bytes,
      notes: shown.notes,
      recallPointer: shown.recallPointer,
    },
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
      linked: linkedProjects(memory),
    };
  } catch {
    return { status: "unreadable" };
  } finally {
    memory.close();
  }
}

import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import {
  readStdin,
  parsePayload,
  projectContext,
  emitAdditionalContext,
  runAdvisoryHook,
  ownedPath,
  isProjectFile,
  type HookPayload,
} from "./lib/hook-io.ts";
import { CEREBRUM_FILE } from "./lib/cerebrum-files.ts";
import { CRANK_DIR } from "./lib/config.ts";
import { debugEvent, safePath } from "./lib/debug.ts";
import { citationCheck } from "./lib/citations.ts";
import { readCodeDb } from "./lib/code-db.ts";
import { callerFiles, callersOf, findSymbols, parsedAt, symbolSets } from "./lib/code-graph.ts";
import { excerptOf, readCerebrum } from "./lib/injection.ts";
import { formatLine, memoryPath, readStore, type MemoryReader } from "./lib/memory.ts";
import { ownerOf, projectName } from "./lib/owner.ts";
import { rootOfName } from "./lib/registry.ts";
import { recordUntouched } from "./lib/untouched.ts";
import { shellGrepNames, shellHistoryPaths, shellReadPaths } from "./lib/shell-reads.ts";
import { transcriptStem } from "./lib/spool.ts";
import { MAIN_AGENT, seenFile } from "./lib/user-state.ts";
import { hookActor, recordUsage } from "./lib/usage.ts";
import type { ObservationLine } from "./lib/wire.ts";

// PostToolUse hook for Claude's Read and Bash, Claude Code only (ADR 0009).
// When the agent reads a file memory has observations on, it adds that file's
// newest lines from the store of the project that owns it, plus the sections
// each helper below documents. Each section shows once per agent per session,
// except paired files, which are never marked seen. Every path exits 0.

const HISTORY_LINES = 5;
const PAIRED_FILES = 3;
const MAX_BYTES = 1536;
const SEP = "\n\n";
const EXCERPT_BYTES = 2048;
const MAX_CALL_BYTES = 4096;
const USED_BY_FILES = 5;
const USED_BY_BYTES = 512;
/** Marker line prefix for a project whose excerpt was shown; never a path, which is absolute. */
const CEREBRUM_MARK = "cerebrum:";
/** Marker line prefix for a file whose "Used by" section was shown. */
const GRAPH_MARK = "graph:";
const CALLERS_BYTES = 512;
/** Marker line prefix for a symbol whose callers line was shown. */
const SYMBOL_MARK = "symbol:";
/** The symbol kinds whose call sites `crank-mem callers` lists. */
const CALLABLE_KINDS = new Set(["fn", "method", "class"]);

/** The files a call reads or, with a git history command, asks about. */
function readPaths(payload: HookPayload): string[] {
  const { file_path, command } = payload.tool_input ?? {};
  if (payload.tool_name === "Read") return typeof file_path === "string" ? [file_path] : [];
  if (payload.tool_name === "Bash" && typeof command === "string")
    return [...shellReadPaths(command), ...shellHistoryPaths(command)];
  return [];
}

/** The names each grep of a Bash call searches for; none for any other tool. */
function grepNames(payload: HookPayload): string[][] {
  const command = payload.tool_name === "Bash" ? payload.tool_input?.command : undefined;
  return typeof command === "string" ? shellGrepNames(command) : [];
}

/** The paths a marker holds, one per line; a missing marker holds none. */
function readSeen(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function changedSince(file: string, ms: number): boolean {
  try {
    return fs.statSync(file).mtimeMs > ms;
  } catch {
    return false;
  }
}

function agentOf(payload: HookPayload): string {
  return typeof payload.agent_id === "string" && /^[\w-]+$/.test(payload.agent_id)
    ? payload.agent_id
    : MAIN_AGENT;
}

/** A read path its owner holds: the owner-relative path, the tree it sits in, and the store it reads. */
type Read = { abs: string; rel: string; tree: string; owner: string; store: string };

/** The read `p` names, or null when no installed project owns it or it is not a file now. */
function resolveRead(cwd: string, p: string, unowned: Set<string>): Read | null {
  const owner = ownerOf(path.resolve(cwd, p));
  if (owner.kind === "unowned") {
    if (owner.repo !== null) unowned.add(owner.repo);
    return null;
  }
  const rel = ownedPath(owner)?.rel;
  const tree = owner.kind === "worktree" ? owner.top : owner.root;
  if (rel === undefined || !isProjectFile(tree, rel)) return null;
  return { abs: path.join(tree, rel), rel, tree, owner: owner.root, store: memoryPath(owner.root) };
}

/** Each read once, in order; the unowned repos among them are recorded once. */
function resolveReads(cwd: string, paths: string[], session: string | null): Read[] {
  const reads = new Map<string, Read>();
  const unowned = new Set<string>();
  for (const p of paths) {
    const r = resolveRead(cwd, p, unowned);
    if (r && !reads.has(r.abs)) reads.set(r.abs, r);
  }
  recordUntouched(unowned, session);
  return [...reads.values()];
}

type Pair = { project: string; path: string };
/** A stored line with its dedupe key. */
type PairLine = { line: ObservationLine; hash: string | undefined };
/** A file's lines and the other projects' files they cite. */
type History = { lines: PairLine[]; pairs: Pair[] };
type Histories = Map<string, Map<string, History>>;

function linesOf(m: MemoryReader, rel: string): PairLine[] {
  const lines = m.fileHistory(rel, HISTORY_LINES);
  const hashes = m.contentHashes(lines.map((l) => l.id));
  return lines.map((line) => ({ line, hash: hashes.get(line.id) }));
}

function historyOf(m: MemoryReader, rel: string): History {
  const lines = linesOf(m, rel);
  return { lines, pairs: lines.length === 0 ? [] : m.pairedPaths(rel, PAIRED_FILES) };
}

/** Each owner's history for its unseen reads; an owner whose store does not open is absent. */
async function fetchHistories(reads: Read[], isSeen: (r: Read) => boolean): Promise<Histories> {
  const out: Histories = new Map();
  for (const owner of new Set(reads.map((r) => r.owner))) {
    const rels = reads.filter((r) => r.owner === owner && !isSeen(r)).map((r) => r.rel);
    const got = await readStore(owner, (m) => new Map(rels.map((rel) => [rel, historyOf(m, rel)])));
    if (got.status === "open") out.set(owner, got.value);
  }
  return out;
}

/** A paired project's store: its root and its paired files' lines. */
type PairStore = { root: string; store: string; files: Map<string, PairLine[]> };

/** Each paired project's store that resolves and opens as "open", keyed by project name. */
async function fetchPairs(found: Histories): Promise<Map<string, PairStore>> {
  const wanted = new Map<string, Set<string>>();
  for (const history of found.values())
    for (const h of history.values())
      for (const p of h.pairs)
        wanted.set(p.project, (wanted.get(p.project) ?? new Set()).add(p.path));
  const out = new Map<string, PairStore>();
  for (const [project, paths] of wanted) {
    const root = rootOfName(project);
    if (root === null) continue;
    const store = memoryPath(root);
    const files = await readStore(root, (m) => new Map([...paths].map((p) => [p, linesOf(m, p)])));
    if (files.status === "open") out.set(project, { root, store, files: files.value });
  }
  return out;
}

type Tally = {
  owner: string;
  sections: string[];
  shown: { path: string; ids: number[] }[];
  empty: string[];
  seen: string[];
  cut: string[];
};

const tallyOf = (owner: string): Tally => ({
  owner,
  sections: [],
  shown: [],
  empty: [],
  seen: [],
  cut: [],
});

/** `handle` is "" for the start project's store, else the owner's name, so ids print as `<name>#<id>`. */
function section(read: Read, lines: ObservationLine[], handle: string): string {
  const tag = changedSince(path.join(read.tree, read.rel), lines[0]!.createdAtMs)
    ? " [file changed since]"
    : "";
  const body = lines.map((l) => handle + formatLine(l));
  return `History of ${read.rel} (open one: \`crank-mem get <id>\`):${tag}\n${body.join("\n")}`;
}

type Assembled = {
  sections: string[];
  tallies: Map<string, Tally>;
  marked: Read[];
  full: boolean;
  /** How many of `sections` each read (by `abs`) and the reads before it account for. */
  ends: Map<string, number>;
};

function tallyFor(out: Assembled, store: string, owner: string): Tally {
  const tally = out.tallies.get(store) ?? tallyOf(owner);
  out.tallies.set(store, tally);
  return tally;
}

/** Adds `text` unless it would pass MAX_BYTES, which cuts it and every section after; true when added. */
function place(out: Assembled, tally: Tally, rel: string, text: string, ids: number[]): boolean {
  if (out.full || Buffer.byteLength([...out.sections, text].join(SEP)) > MAX_BYTES) {
    out.full = true;
    tally.cut.push(rel);
    return false;
  }
  out.sections.push(text);
  tally.sections.push(text);
  tally.shown.push({ path: rel, ids });
  return true;
}

function show(out: Assembled, tally: Tally, read: Read, lines: ObservationLine[], handle: string) {
  const ids = lines.map((l) => l.id);
  if (place(out, tally, read.rel, section(read, lines, handle), ids)) out.marked.push(read);
}

/** `read`'s paired files' sections, leaving out lines that repeat one of `read`'s; never marked seen. */
function showPairs(
  out: Assembled,
  startStore: string,
  read: Read,
  own: History,
  pairStores: Map<string, PairStore>,
) {
  const ownHashes = new Set(own.lines.map((l) => l.hash));
  for (const pair of own.pairs) {
    const ps = pairStores.get(pair.project);
    const lines = (ps?.files.get(pair.path) ?? [])
      .filter((l) => l.hash === undefined || !ownHashes.has(l.hash))
      .map((l) => l.line);
    if (!ps || lines.length === 0) continue;
    const handle = ps.store === startStore ? "" : pair.project;
    const body = lines.map((l) => handle + formatLine(l)).join("\n");
    const text = `History of ${pair.project}/${pair.path}, paired with ${read.rel}:\n${body}`;
    place(
      out,
      tallyFor(out, ps.store, ps.root),
      pair.path,
      text,
      lines.map((l) => l.id),
    );
  }
}

/** `read`'s history section, when it has lines and the call has room, then its paired files' sections. */
function assembleRead(
  out: Assembled,
  startStore: string,
  read: Read,
  found: Histories,
  pairStores: Map<string, PairStore>,
  isSeen: (r: Read) => boolean,
): void {
  const history = found.get(read.owner);
  if (!history) return;
  const tally = tallyFor(out, read.store, read.owner);
  const own = history.get(read.rel);
  if (isSeen(read) || !own) {
    tally.seen.push(read.rel);
    return;
  }
  if (out.full) tally.cut.push(read.rel);
  else if (own.lines.length === 0) tally.empty.push(read.rel);
  else
    show(
      out,
      tally,
      read,
      own.lines.map((l) => l.line),
      read.store === startStore ? "" : projectName(read.owner),
    );
  showPairs(out, startStore, read, own, pairStores);
}

/** Sections in read order until the next would pass MAX_BYTES; every read of an open store lands in its tally. */
function assemble(
  startStore: string,
  reads: Read[],
  found: Histories,
  pairStores: Map<string, PairStore>,
  isSeen: (r: Read) => boolean,
): Assembled {
  const out: Assembled = {
    sections: [],
    tallies: new Map(),
    marked: [],
    full: false,
    ends: new Map(),
  };
  for (const read of reads) {
    assembleRead(out, startStore, read, found, pairStores, isSeen);
    out.ends.set(read.abs, out.sections.length);
  }
  return out;
}

/**
 * `read`'s "Used by" section: the files calling into it, from its owner's code.db, up to
 * USED_BY_FILES of them in USED_BY_BYTES. Null when the store does not open, the file's size or
 * mtime differs from its parse stamp, or no other file calls it. The command it prints names the
 * file by its owner-relative path in the start project and by its absolute path in another, so the
 * pasted command finds that file from the start project's cwd.
 */
function usedBySection(read: Read, startRoot: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(read.abs);
  } catch {
    return null;
  }
  const callers = readCodeDb(read.owner, (db) =>
    db && parsedAt(db, read.rel, stat) ? callerFiles(db, read.rel, USED_BY_FILES) : [],
  );
  const named = read.owner === startRoot ? read.rel : read.abs;
  const head = `Used by (crank-mem impact ${named}):`;
  let text = head;
  for (const c of callers) {
    const next = `${text}\n- ${c.path} (${c.calls} ${c.calls === 1 ? "call" : "calls"})`;
    if (Buffer.byteLength(next) > USED_BY_BYTES) break;
    text = next;
  }
  return text === head ? null : text;
}

/**
 * The call's sections: each read's history and pair sections, then its "Used by" when that is
 * unseen and the whole call, the history still to come included, stays under MAX_CALL_BYTES.
 * `marks` holds the `graph:` line of each one shown.
 */
function withUsedBy(
  startRoot: string,
  reads: Read[],
  assembled: Assembled,
  seen: string[],
): { sections: string[]; marks: string[] } {
  const sections: string[] = [];
  const marks: string[] = [];
  let at = 0;
  for (const read of reads) {
    const end = assembled.ends.get(read.abs)!;
    sections.push(...assembled.sections.slice(at, end));
    at = end;
    const mark = GRAPH_MARK + read.abs;
    if (seen.includes(mark)) continue;
    const text = usedBySection(read, startRoot);
    const call = text === null ? [] : [...sections, text, ...assembled.sections.slice(at)];
    if (text !== null && Buffer.byteLength(call.join(SEP)) < MAX_CALL_BYTES) {
      sections.push(text);
      marks.push(mark);
    }
  }
  return { sections, marks };
}

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * `name`'s callers line, with the counts `crank-mem callers <name>` prints. Null when the name has
 * several definitions (which that command refuses), no resolved call site, or a defining file
 * whose size or mtime differs from its parse stamp.
 */
function callersLine(db: sqlite.DatabaseSync, root: string, name: string): string | null {
  const sets = symbolSets(findSymbols(db, name));
  if (sets.length !== 1) return null;
  const set = sets[0]!;
  const { path: file, start, end } = set[0]!;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path.join(root, file));
  } catch {
    return null;
  }
  if (!parsedAt(db, file, stat)) return null;
  const sites = callersOf(db, set).resolved;
  if (sites.length === 0) return null;
  const files = new Set(sites.map((site) => site.path)).size;
  return (
    `Callers of ${name} (crank-mem callers ${name}): ${counted(sites.length, "call site")} in ` +
    `${counted(files, "file")}; defined at ${file}:${start}-${end}.`
  );
}

/** A call's symbol lookup: every name asked about, the names whose line is shown, and the section. */
type Lookup = { symbols: string[]; shown: string[]; text: string | null };

/**
 * The symbol lookup `greps` make in `root`'s code.db: a grep counts when every name it searches for
 * is a function, method or class there. The section holds the unseen names' callers lines, in
 * order, until the next would pass CALLERS_BYTES. Null when no grep counts or the store does not open.
 */
function symbolLookup(root: string, greps: string[][], seen: string[]): Lookup | null {
  if (greps.length === 0) return null;
  return readCodeDb(root, (db) => {
    if (!db) return null;
    const callable = (name: string) =>
      findSymbols(db, name).some((row) => CALLABLE_KINDS.has(row.kind));
    const symbols = [...new Set(greps.filter((names) => names.every(callable)).flat())];
    if (symbols.length === 0) return null;
    const lines: string[] = [];
    const shown: string[] = [];
    for (const name of symbols) {
      const line = seen.includes(SYMBOL_MARK + name) ? null : callersLine(db, root, name);
      if (line === null) continue;
      if (Buffer.byteLength([...lines, line].join("\n")) > CALLERS_BYTES) break;
      lines.push(line);
      shown.push(name);
    }
    return { symbols, shown, text: lines.length > 0 ? lines.join("\n") : null };
  });
}

/** The lookup as the call shows it: nothing shown when its section would take the call to MAX_CALL_BYTES. */
function placeLookup(lookup: Lookup | null, sections: string[]): Lookup | null {
  if (!lookup || lookup.text === null) return lookup;
  const fits = Buffer.byteLength([...sections, lookup.text].join(SEP)) < MAX_CALL_BYTES;
  return fits ? lookup : { ...lookup, shown: [], text: null };
}

function recordLookup(payload: HookPayload, root: string, lookup: Lookup): void {
  recordUsage(root, hookActor(payload), {
    channel: "symbol-lookup",
    tool: payload.tool_name!,
    symbols: lookup.symbols,
    shown: lookup.shown,
    bytes: lookup.text === null ? 0 : Buffer.byteLength(lookup.text, "utf-8"),
  });
}

/** One usage line per store, each with its own paths, bare ids and bytes; the start project always gets one. */
function recordTallies(
  payload: HookPayload,
  start: { root: string; store: string },
  tallies: Map<string, Tally>,
): void {
  if (!tallies.has(start.store)) tallies.set(start.store, tallyOf(start.root));
  for (const t of tallies.values()) {
    recordUsage(t.owner, hookActor(payload), {
      channel: "file-history",
      tool: payload.tool_name!,
      shown: t.shown,
      empty: t.empty,
      seen: t.seen,
      cut: t.cut,
      bytes: Buffer.byteLength(t.sections.join(SEP), "utf-8"),
    });
  }
}

/** An excerpt block for one project's cerebrum, and the marker line that records it shown. */
type Block = { text: string; mark: string };

/**
 * The excerpt of the first read's owner that is not the start project and not yet shown,
 * sized so the call's whole context stays under MAX_CALL_BYTES; null when there is none
 * or its cerebrum does not read.
 */
function excerptBlock(
  startRoot: string,
  reads: Read[],
  seen: string[],
  sections: string[],
): Block | null {
  const root = reads
    .map((r) => r.owner)
    .find((o) => o !== startRoot && !seen.includes(CEREBRUM_MARK + o));
  if (root === undefined) return null;
  const crankDir = path.join(root, CRANK_DIR);
  const md = readCerebrum(crankDir);
  if (!md) return null;
  const name = projectName(root);
  const head =
    `Excerpt of \`${path.join(crankDir, CEREBRUM_FILE)}\`, project ${name}'s memory; grep it for more.\n` +
    `Recall there: \`crank-mem search --project ${name} <query>\`; its ids show as \`${name}#<id>\`.`;
  const used = Buffer.byteLength([...sections, head].join(SEP)) + SEP.length;
  const budget = Math.min(EXCERPT_BYTES, MAX_CALL_BYTES - 1 - used);
  const check = citationCheck({ root });
  const text = excerptOf(md, budget, check, true).text;
  return text ? { text: head + SEP + text, mark: CEREBRUM_MARK + root } : null;
}

/** Appends, so parallel hooks on one transcript each keep their marks. */
function markSeen(file: string, marked: string[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, marked.map((p) => p + "\n").join(""));
  } catch {
    // A lost marker costs only a repeat of this history.
  }
}

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const paths = readPaths(payload);
  const greps = grepNames(payload);
  if (paths.length === 0 && greps.length === 0) return;

  const ctx = projectContext(payload);
  if (!ctx) return;

  const stem = transcriptStem(payload.transcript_path);
  if (!stem) return;

  const reads = resolveReads(ctx.cwd, paths, hookActor(payload).session);
  const marks = seenFile(stem, agentOf(payload));
  const seen = readSeen(marks);
  const lookup = symbolLookup(ctx.root, greps, seen);
  if (reads.length === 0 && lookup === null) return;

  const isSeen = (r: Read) => seen.includes(r.abs);
  const found = await fetchHistories(reads, isSeen);

  const startStore = memoryPath(ctx.root);
  const pairStores = await fetchPairs(found);
  const assembled = assemble(startStore, reads, found, pairStores, isSeen);
  const { tallies, marked } = assembled;
  const used = withUsedBy(ctx.root, reads, assembled, seen);
  const callers = placeLookup(lookup, used.sections);
  const sections = callers?.text ? [...used.sections, callers.text] : used.sections;
  const block = excerptBlock(ctx.root, reads, seen, sections);
  const shown = block ? [...sections, block.text] : sections;
  if (shown.length > 0) {
    markSeen(marks, [
      ...marked.map((r) => r.abs),
      ...used.marks,
      ...(callers?.shown ?? []).map((name) => SYMBOL_MARK + name),
      ...(block ? [block.mark] : []),
    ]);
    emitAdditionalContext("PostToolUse", shown.join(SEP));
    debugEvent("file-history", { paths: marked.map((r) => safePath(r.rel)) });
  }
  if (found.size > 0) recordTallies(payload, { root: ctx.root, store: startStore }, tallies);
  if (callers) recordLookup(payload, ctx.root, callers);
}

await runAdvisoryHook("post-read", main);

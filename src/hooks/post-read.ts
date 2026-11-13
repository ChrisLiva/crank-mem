import * as fs from "node:fs";
import * as path from "node:path";
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
import { citationSources, excerptOf, readCerebrum } from "./lib/injection.ts";
import { formatLine, memoryPath, withReader, type MemoryReader } from "./lib/memory.ts";
import { ownerOf, projectName } from "./lib/owner.ts";
import { rootOfName } from "./lib/registry.ts";
import { recordUntouched } from "./lib/untouched.ts";
import { shellReadPaths } from "./lib/shell-reads.ts";
import { transcriptStem } from "./lib/spool.ts";
import { SEEN_DIR, crankHome } from "./lib/user-state.ts";
import { hookActor, recordUsage } from "./lib/usage.ts";
import type { ObservationLine } from "./lib/wire.ts";

// PostToolUse hook for Claude's Read and Bash, Claude Code only (ADR 0009).
// When the agent reads a file memory has observations on, it adds that file's
// newest lines from the store of the project that owns it, once per file per
// agent per session. After a file's own section come up to 3 sections for the
// other projects' files its observations cite, read from those projects' stores
// and never marked seen. Last, once per project per agent per session, comes
// the cerebrum excerpt of the first read's owner other than the start project.
// Every path exits 0.

const HISTORY_LINES = 5;
const PAIRED_FILES = 3;
const MAX_BYTES = 1536;
const SEP = "\n\n";
const EXCERPT_BYTES = 2048;
const MAX_CALL_BYTES = 4096;
/** Marker line prefix for a project whose excerpt was shown; never a path, which is absolute. */
const CEREBRUM_MARK = "cerebrum:";

function readPaths(payload: HookPayload): string[] {
  const input = payload.tool_input ?? {};
  if (payload.tool_name === "Read")
    return typeof input.file_path === "string" ? [input.file_path] : [];
  if (payload.tool_name === "Bash")
    return typeof input.command === "string" ? shellReadPaths(input.command) : [];
  return [];
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
    : "main";
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

/** Each store's history for its unseen reads; a store that does not open as "open" is absent. */
async function fetchHistories(reads: Read[], isSeen: (r: Read) => boolean): Promise<Histories> {
  const out: Histories = new Map();
  for (const store of new Set(reads.map((r) => r.store))) {
    const rels = reads.filter((r) => r.store === store && !isSeen(r)).map((r) => r.rel);
    const got = await withReader(
      store,
      (m) => new Map(rels.map((rel) => [rel, historyOf(m, rel)])),
    );
    if (got instanceof Map) out.set(store, got);
  }
  return out;
}

/** A paired project's store: its root and its paired files' lines; absent when its name or store does not resolve. */
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
    const files = await withReader(
      store,
      (m) => new Map([...paths].map((p) => [p, linesOf(m, p)])),
    );
    if (files instanceof Map) out.set(project, { root, store, files });
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

type Assembled = { sections: string[]; tallies: Map<string, Tally>; marked: Read[]; full: boolean };

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

/** Sections in read order until the next would pass MAX_BYTES; every read of an open store lands in its tally. */
function assemble(
  startStore: string,
  reads: Read[],
  found: Histories,
  pairStores: Map<string, PairStore>,
  isSeen: (r: Read) => boolean,
): Assembled {
  const out: Assembled = { sections: [], tallies: new Map(), marked: [], full: false };
  for (const read of reads) {
    const history = found.get(read.store);
    if (!history) continue;
    const tally = tallyFor(out, read.store, read.owner);
    const own = history.get(read.rel);
    if (isSeen(read) || !own) {
      tally.seen.push(read.rel);
      continue;
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
  return out;
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
  const text = excerptOf(md, budget, citationSources(crankDir, root), true).text;
  return text ? { text: head + SEP + text, mark: CEREBRUM_MARK + root } : null;
}

/** Appends, so parallel hooks on one transcript each keep their marks. */
function markSeen(seenFile: string, marked: string[]): void {
  try {
    fs.mkdirSync(path.dirname(seenFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(seenFile, marked.map((p) => p + "\n").join(""));
  } catch {
    // A lost marker costs only a repeat of this history.
  }
}

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const paths = readPaths(payload);
  if (paths.length === 0) return;

  const ctx = projectContext(payload);
  if (!ctx) return;

  const stem = transcriptStem(payload.transcript_path);
  if (!stem) return;

  const reads = resolveReads(ctx.cwd, paths, hookActor(payload).session);
  if (reads.length === 0) return;

  const seenFile = path.join(crankHome(), SEEN_DIR, `${stem}-${agentOf(payload)}.seen`);
  const seen = readSeen(seenFile);
  const isSeen = (r: Read) => seen.includes(r.abs);
  const found = await fetchHistories(reads, isSeen);

  const startStore = memoryPath(ctx.root);
  const pairStores = await fetchPairs(found);
  const { sections, tallies, marked } = assemble(startStore, reads, found, pairStores, isSeen);
  const block = excerptBlock(ctx.root, reads, seen, sections);
  const shown = block ? [...sections, block.text] : sections;
  if (shown.length > 0) {
    markSeen(seenFile, [...marked.map((r) => r.abs), ...(block ? [block.mark] : [])]);
    emitAdditionalContext("PostToolUse", shown.join(SEP));
    debugEvent("file-history", { paths: marked.map((r) => safePath(r.rel)) });
  }
  if (found.size > 0) recordTallies(payload, { root: ctx.root, store: startStore }, tallies);
}

await runAdvisoryHook("post-read", main);

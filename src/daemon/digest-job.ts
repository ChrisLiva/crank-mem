import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, positive } from "../cli/args.ts";
import { COMMANDS } from "../cli/commands.ts";
import { CEREBRUM_FILE, splitPreamble } from "../hooks/lib/cerebrum-files.ts";
import { CRANK_DIR, errorMessage, loadConfig } from "../hooks/lib/config.ts";
import { memoryPaths } from "../hooks/lib/hook-io.ts";
import {
  memoryPath,
  openMemory,
  withReader,
  type DigestInput,
  type Memory,
  type MemoryReader,
  type SessionKey,
} from "../hooks/lib/memory.ts";
import { deleteEntry, readSpool, settleEntry, type SpoolEntry } from "../hooks/lib/spool.ts";
import { readStopState } from "../hooks/lib/user-state.ts";
import type { Observation } from "../hooks/lib/wire.ts";
import { ownerOf, projectName } from "../hooks/lib/owner.ts";
import { digestRequest, type Digest, type DigestContext, type Shown } from "./digest-prompt.ts";
import { route, type EntryShare, type Share } from "./digest-route.ts";
import { EMBED_MODEL, embed } from "./embedder.ts";
import { CONSOLIDATE_EVERY_MS, consolidate } from "./consolidate.ts";
import { askClaude, RUN_TIMEOUT_MS } from "./gateway.ts";
import { redact } from "./redact.ts";
import { distill } from "./transcript.ts";

// `crank-mem job <stem>`: digest one spool entry's new transcript records into
// its project's store. Exit 0 settles the entry for this sweep; exit 1 asks
// for a retry after the daemon's backoff, and a rejection short of the limit
// takes that path too.

export const MAX_DELTA_CHARS = 400_000;
export const MIN_DELTA_CHARS = 2_000;

/** A file this small can hold a short session; a larger one with no conversation record is not a transcript. */
const PARK_SIZE = 4096;

/** Rows embedded per digest; rows past it wait for the next digest in the repo. */
const EMBED_BATCH = 200;

/** Earlier rows shown per touched file, and in all, under [EXISTING OBSERVATIONS]. */
const HISTORY_PER_FILE = 5;
const HISTORY_TOTAL = 30;

/** Rejections before an entry parks: a session the model will not digest must not cost a run every hour. */
const REJECTION_LIMIT = 3;

export async function run(args: string[]): Promise<number> {
  const stem = args[0];
  const item = readSpool().find((i) => i.stem === stem);
  if (!stem || !item) return 0;
  if (readStopState() !== null) return 0;
  const entry = item.entry;
  if (!fs.existsSync(entry.transcriptPath)) {
    deleteEntry(stem);
    return 0;
  }
  const { flags } = parseArgs(args.slice(1), COMMANDS.job.value);
  const timeoutMs = positive(flags["run-timeout-ms"], RUN_TIMEOUT_MS);
  const everyMs = positive(flags["consolidate-every-ms"], CONSOLIDATE_EVERY_MS);

  const opened = openMemory(memoryPath(entry.projectRoot), "write");
  if (opened.status !== "open") return 1;
  const memory = opened.memory;
  try {
    return await digest(memory, stem, entry, { timeoutMs, everyMs });
  } finally {
    memory.close();
  }
}

async function digest(
  memory: Memory,
  stem: string,
  entry: SpoolEntry,
  opts: { timeoutMs: number; everyMs: number },
): Promise<number> {
  const { timeoutMs } = opts;
  const pos = memory.position(stem);
  const d = distill(entry.transcriptPath, pos, MAX_DELTA_CHARS);
  if (pos === null && fs.statSync(entry.transcriptPath).size > PARK_SIZE && d.records === 0) {
    settleEntry(stem, entry.updatedAt, "park");
    return 0;
  }
  if (d.text.length < MIN_DELTA_CHARS || d.next === null) {
    settleEntry(stem, entry.updatedAt, "delete");
    return 0;
  }
  const { context, shown } = await digestContext(memory, entry, d.paths);
  const r = await askClaude(digestRequest(d.text, memory.latestSummary(stem), context), {
    timeoutMs,
  });
  if (r.kind === "retry") return 1;
  if (r.kind === "stopped") return 0;
  const session: SessionKey = { id: stem, agent: "claude", transcriptPath: entry.transcriptPath };
  if (r.kind === "rejected") return rejected(memory, session, entry);
  const routed = route(stored(r.output), entry, shown, ownerOf);
  const base = { session, next: d.next, model: r.model };
  const written = writeShares(routed.others, { ...base, origin: projectName(entry.projectRoot) });
  try {
    if (appendEntry(memory, routed.entry, { ...base, expected: pos, costUsd: r.costUsd })) {
      if (!d.truncated) settleEntry(stem, entry.updatedAt, "delete");
      written.push({ root: entry.projectRoot, memory });
    }
    for (const store of written) await upkeep(store.root, store.memory, opts);
  } finally {
    for (const store of written) if (store.memory !== memory) store.memory.close();
  }
  return 0;
}

/** Record a rejection: exit 1 asks for a retry, and the entry parks at the limit. */
function rejected(memory: Memory, session: SessionKey, entry: SpoolEntry): number {
  if (memory.recordRejection(session) < REJECTION_LIMIT) return 1;
  settleEntry(session.id, entry.updatedAt, "park");
  return 0;
}

/** The entry's share as the session's digest row; true when it was appended. */
function appendEntry(
  memory: Memory,
  share: EntryShare,
  base: Pick<DigestInput, "session" | "expected" | "next" | "model" | "costUsd">,
): boolean {
  const { summary, observations, proposals, stale, links } = share;
  return (
    memory.appendDigest({
      ...base,
      summary,
      observations,
      proposals,
      stale,
      origin: null,
      links,
    }) === "appended"
  );
}

/** One written store's embedding, daily pass and consolidation, each failure quiet. */
async function upkeep(
  root: string,
  memory: Memory,
  opts: { timeoutMs: number; everyMs: number },
): Promise<void> {
  await embedPending(memory);
  maintainQuietly(memory);
  await consolidateQuietly(root, memory, opts);
}

/** The store's daily pass; a failure prints one line and never changes the exit code. */
function maintainQuietly(memory: Memory): void {
  try {
    memory.maintain();
  } catch (err) {
    console.error(`crank-mem: maintenance skipped (${errorMessage(err)})`);
  }
}

/** Consolidation after a digest; a failure prints one line and never changes the exit code. */
async function consolidateQuietly(
  root: string,
  memory: Memory,
  opts: { timeoutMs: number; everyMs: number },
): Promise<void> {
  try {
    await consolidate(root, memory, opts);
  } catch (err) {
    console.error(`crank-mem: consolidation skipped (${errorMessage(err)})`);
  }
}

/** Cerebrum's body, or null when the file is missing or has no `## ` heading. */
function readCerebrum(root: string): string | null {
  try {
    return (
      splitPreamble(
        fs.readFileSync(path.join(root, CRANK_DIR, CEREBRUM_FILE), "utf8"),
      ).body?.trimEnd() ?? null
    );
  } catch {
    return null; // no cerebrum: the digest runs on the transcript and history alone
  }
}

/** The installed projects other than the session's that own a kept path of the delta, by name. */
function otherProjects(entry: SpoolEntry, paths: string[]): { name: string; root: string }[] {
  const roots = new Set<string>();
  for (const p of paths) {
    const owner = ownerOf(path.resolve(entry.cwd, p));
    if (owner.kind !== "unowned" && owner.root !== entry.projectRoot) roots.add(owner.root);
  }
  return [...roots]
    .filter((root) => memoryPaths(root, entry.cwd, paths).length > 0)
    .map((root) => ({ name: projectName(root), root }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Cerebrum's body, the touched projects (session's first, the rest by name; null when no other project is touched),
 * and the newest non-stale rows about the delta's files from each project's store in that order: HISTORY_PER_FILE
 * per file in first-touched order, each row once, HISTORY_TOTAL across all stores. `shown` holds one entry per
 * listed project ("" for the session's), or only "" without [PROJECTS].
 */
async function digestContext(
  memory: Memory,
  entry: SpoolEntry,
  paths: string[],
): Promise<{ context: DigestContext; shown: Map<string, Shown> }> {
  const cerebrum = readCerebrum(entry.projectRoot);
  const others = otherProjects(entry, paths);
  const projects =
    others.length === 0
      ? null
      : [
          { name: projectName(entry.projectRoot), root: entry.projectRoot, session: true },
          ...others.map((o) => ({ ...o, session: false })),
        ];
  const existing: DigestContext["existing"] = [];
  const shown = new Map<string, Shown>();
  const show = (key: string, root: string, rows: HistoryRow[]) => {
    shown.set(key, { root, ids: rows.map((o) => o.id) });
    for (const { id, type, title, narrative } of rows)
      existing.push({ handle: `${key}#${id}`, type, title, narrative });
  };
  const files = (root: string) => memoryPaths(root, entry.cwd, paths);
  show("", entry.projectRoot, storeHistory(memory, files(entry.projectRoot), HISTORY_TOTAL));
  for (const { name, root } of others) {
    const left = HISTORY_TOTAL - existing.length;
    const rows = await withReader(memoryPath(root), (reader) =>
      storeHistory(reader, files(root), left),
    );
    show(name, root, Array.isArray(rows) ? rows : []);
  }
  return { context: { cerebrum, projects, existing }, shown };
}

type HistoryRow = Pick<Observation, "id" | "type" | "title" | "narrative">;

/** One store's newest non-stale rows about `files`: HISTORY_PER_FILE per file in order, each row once, `limit` in all. */
function storeHistory(reader: MemoryReader, files: string[], limit: number): HistoryRow[] {
  const ids = new Set<number>();
  for (const file of files) {
    for (const line of reader.fileHistory(file, HISTORY_PER_FILE)) {
      if (ids.size >= limit) break;
      ids.add(line.id);
    }
    if (ids.size >= limit) break;
  }
  return reader.get([...ids]);
}

/** Store vectors for rows that lack one; a failure leaves them for the next digest and never changes the exit code. */
async function embedPending(memory: Memory): Promise<void> {
  try {
    const rows = memory.unembedded(EMBED_MODEL, EMBED_BATCH);
    if (rows.length === 0) return;
    const vectors = await embed(
      rows.map((r) => r.text),
      { remote: false },
    );
    memory.putVectors(
      EMBED_MODEL,
      rows.map((r, i) => ({ id: r.id, vector: vectors[i]! })),
    );
  } catch (err) {
    console.error(`crank-mem: embedding skipped (${errorMessage(err)})`);
  }
}

/** The share fields every share of one session carries; each store adds its own position. */
type ShareBase = Pick<DigestInput, "session" | "next" | "model" | "origin">;

const EMPTY_SUMMARY: DigestInput["summary"] = {
  request: "",
  investigated: "",
  learned: "",
  completed: "",
  next_steps: "",
};

/**
 * Write each other project's share to its store, in order. A project with digests off, or a store that reads as
 * newer, gets none silently; a store that will not open or write gets none with one stderr line. The stores written
 * stay open, in that order, for the caller to close.
 */
function writeShares(shares: Share[], base: ShareBase): { root: string; memory: Memory }[] {
  const written: { root: string; memory: Memory }[] = [];
  for (const share of shares) {
    if (!loadConfig(path.join(share.root, CRANK_DIR)).digest) continue;
    const memory = openAndWrite(share, base);
    if (memory) written.push({ root: share.root, memory });
  }
  return written;
}

/** The store holding `share`, left open, or null when nothing was written and the store is closed. */
function openAndWrite(share: Share, base: ShareBase): Memory | null {
  let memory: Memory | undefined;
  let kept = false;
  try {
    const opened = openMemory(memoryPath(share.root), "write");
    if (opened.status === "newer") return null;
    if (opened.status !== "open") {
      shareSkipped(share.root, opened.status);
      return null;
    }
    memory = opened.memory;
    kept = writeShare(memory, share, base);
    return kept ? memory : null;
  } catch (err) {
    shareSkipped(share.root, errorCode(err));
    return null;
  } finally {
    if (!kept) memory?.close();
  }
}

/** A thrown error's `code`, such as ERR_SQLITE_ERROR or EACCES, or its message when it has none. */
function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? errorMessage(err);
}

/** The one stderr line for a share that was not written. */
function shareSkipped(root: string, reason: string): void {
  console.error(`crank-mem: share for ${projectName(root)} skipped (${reason}).`);
}

/** One share as a digest row at cost 0 with an empty summary; false when the store already holds `next`. */
function writeShare(memory: Memory, share: Share, base: ShareBase): boolean {
  const expected = memory.position(base.session.id);
  if (expected?.uuid === base.next.uuid && expected.timestamp === base.next.timestamp) return false;
  return (
    memory.appendDigest({
      ...base,
      expected,
      costUsd: 0,
      summary: EMPTY_SUMMARY,
      observations: share.observations,
      proposals: share.proposals,
      stale: share.stale,
      links: [],
    }) === "appended"
  );
}

/** The model's output with every string redacted and only the proposals with a non-blank bullet. */
function stored(output: Digest): Digest {
  const s = output.summary;
  return {
    summary: {
      request: redact(s.request),
      investigated: redact(s.investigated),
      learned: redact(s.learned),
      completed: redact(s.completed),
      next_steps: redact(s.next_steps),
    },
    observations: output.observations.map((o) => ({
      type: o.type,
      title: redact(o.title),
      narrative: redact(o.narrative),
      facts: o.facts.map(redact),
      files_read: o.files_read.map(redact),
      files_modified: o.files_modified.map(redact),
    })),
    proposals: output.proposals
      .map((p) => ({ kind: p.kind, bullet: redact(p.bullet).trim(), project: p.project }))
      .filter((p) => p.bullet !== ""),
    stale: output.stale.map((f) => ({ id: f.id, reason: redact(f.reason) })),
  };
}

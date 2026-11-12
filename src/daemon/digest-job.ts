import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, positive } from "../cli/args.ts";
import { COMMANDS } from "../cli/commands.ts";
import { CEREBRUM_FILE, splitPreamble } from "../hooks/lib/cerebrum-files.ts";
import { CRANK_DIR, errorMessage } from "../hooks/lib/config.ts";
import { memoryPaths } from "../hooks/lib/hook-io.ts";
import { memoryPath, openMemory, type Memory, type SessionKey } from "../hooks/lib/memory.ts";
import { deleteEntry, readSpool, settleEntry, type SpoolEntry } from "../hooks/lib/spool.ts";
import { readStopState } from "../hooks/lib/user-state.ts";
import { digestRequest, type Digest, type DigestContext } from "./digest-prompt.ts";
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
  const context = digestContext(memory, entry, d.paths);
  const r = await askClaude(digestRequest(d.text, memory.latestSummary(stem), context), {
    timeoutMs,
  });
  if (r.kind === "retry") return 1;
  if (r.kind === "stopped") return 0;
  const session: SessionKey = { id: stem, agent: "claude", transcriptPath: entry.transcriptPath };
  if (r.kind === "rejected") {
    if (memory.recordRejection(session) >= REJECTION_LIMIT) {
      settleEntry(stem, entry.updatedAt, "park");
      return 0;
    }
    return 1;
  }
  const outcome = memory.appendDigest({
    session,
    expected: pos,
    next: d.next,
    model: r.model,
    costUsd: r.costUsd,
    ...stored(
      r.output,
      entry.projectRoot,
      entry.cwd,
      context.existing.map((o) => o.id),
    ),
  });
  if (outcome === "appended") {
    if (!d.truncated) settleEntry(stem, entry.updatedAt, "delete");
    await embedPending(memory);
    maintainQuietly(memory);
    await consolidateQuietly(entry.projectRoot, memory, opts);
  }
  return 0;
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

/**
 * Cerebrum's body (null when the file is missing or has no `## ` heading), and the newest non-stale rows
 * about the delta's files: HISTORY_PER_FILE per file in first-touched order, each row once, HISTORY_TOTAL in all.
 */
function digestContext(memory: Memory, entry: SpoolEntry, paths: string[]): DigestContext {
  let cerebrum: string | null = null;
  try {
    cerebrum =
      splitPreamble(
        fs.readFileSync(path.join(entry.projectRoot, CRANK_DIR, CEREBRUM_FILE), "utf8"),
      ).body?.trimEnd() ?? null;
  } catch {
    // no cerebrum: the digest runs on the transcript and history alone
  }
  const ids = new Set<number>();
  for (const file of memoryPaths(entry.projectRoot, entry.cwd, paths)) {
    for (const line of memory.fileHistory(file, HISTORY_PER_FILE)) {
      if (ids.size === HISTORY_TOTAL) break;
      ids.add(line.id);
    }
    if (ids.size === HISTORY_TOTAL) break;
  }
  const existing = memory
    .get([...ids])
    .map(({ id, type, title, narrative }) => ({ id, type, title, narrative }));
  return { cerebrum, existing };
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

/**
 * The model's output as the store takes it: every string redacted, paths repo-relative and deduped.
 * Relative paths resolve against the session's cwd. A stale flag stands only for a row the input showed,
 * and a proposal only with a non-blank bullet.
 */
function stored(output: Digest, root: string, cwd: string, shownIds: number[]) {
  const s = output.summary;
  const files = (paths: string[]) => memoryPaths(root, cwd, paths.map(redact));
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
      filesRead: files(o.files_read),
      filesModified: files(o.files_modified),
    })),
    proposals: output.proposals
      .map((p) => ({ kind: p.kind, bullet: redact(p.bullet).trim() }))
      .filter((p) => p.bullet !== ""),
    stale: output.stale
      .filter((f) => shownIds.includes(f.id))
      .map((f) => ({ id: f.id, reason: redact(f.reason) })),
  };
}

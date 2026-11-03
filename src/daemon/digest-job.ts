import * as fs from "node:fs";
import { parseArgs, positive } from "../cli/args.ts";
import { memoryPaths } from "../hooks/lib/hook-io.ts";
import { memoryPath, openMemory, type Memory, type SessionKey } from "../hooks/lib/memory.ts";
import { deleteEntry, readSpool, settleEntry, type SpoolEntry } from "../hooks/lib/spool.ts";
import { readStopState, writeStopState } from "../hooks/lib/user-state.ts";
import { digestRequest, type Digest } from "./digest-prompt.ts";
import { EMBED_MODEL, embed } from "./embedder.ts";
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
  const { flags } = parseArgs(args.slice(1), ["run-timeout-ms"]);
  const timeoutMs = positive(flags["run-timeout-ms"], RUN_TIMEOUT_MS);

  const opened = openMemory(memoryPath(entry.projectRoot), "write");
  if (opened.status !== "open") return 1;
  const memory = opened.memory;
  try {
    return await digest(memory, stem, entry, timeoutMs);
  } finally {
    memory.close();
  }
}

async function digest(memory: Memory, stem: string, entry: SpoolEntry, timeoutMs: number): Promise<number> {
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
  const r = await askClaude(digestRequest(d.text, memory.latestSummary(stem)), { timeoutMs });
  if (r.kind === "retry") return 1;
  if (r.kind === "stopped") {
    writeStopState({ reason: r.reason, atMs: Date.now(), detail: r.detail });
    return 0;
  }
  const session: SessionKey = { id: stem, agent: "claude", transcriptPath: entry.transcriptPath };
  if (r.kind === "rejected") {
    if (memory.recordRejection(session) >= REJECTION_LIMIT) {
      settleEntry(stem, entry.updatedAt, "park");
      return 0;
    }
    return 1;
  }
  const outcome = memory.appendDigest({
    session, expected: pos, next: d.next, model: r.model, costUsd: r.costUsd, ...stored(r.output, entry.projectRoot, entry.cwd),
  });
  if (outcome === "appended") {
    if (!d.truncated) settleEntry(stem, entry.updatedAt, "delete");
    await embedPending(memory);
  }
  return 0;
}

/** Store vectors for rows that lack one; a failure leaves them for the next digest and never changes the exit code. */
async function embedPending(memory: Memory): Promise<void> {
  try {
    const rows = memory.unembedded(EMBED_MODEL, EMBED_BATCH);
    if (rows.length === 0) return;
    const vectors = await embed(rows.map((r) => r.text), { remote: false });
    memory.putVectors(EMBED_MODEL, rows.map((r, i) => ({ id: r.id, vector: vectors[i]! })));
  } catch (err) {
    console.error(`crank-mem: embedding skipped (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * The model's output as the store takes it: every string redacted, paths repo-relative and deduped.
 * Relative paths resolve against the session's cwd.
 */
function stored(output: Digest, root: string, cwd: string) {
  const s = output.summary;
  const files = (paths: string[]) => memoryPaths(root, cwd, paths.map(redact));
  return {
    summary: {
      request: redact(s.request), investigated: redact(s.investigated), learned: redact(s.learned),
      completed: redact(s.completed), next_steps: redact(s.next_steps),
    },
    observations: output.observations.map((o) => ({
      type: o.type, title: redact(o.title), narrative: redact(o.narrative), facts: o.facts.map(redact),
      filesRead: files(o.files_read), filesModified: files(o.files_modified),
    })),
  };
}

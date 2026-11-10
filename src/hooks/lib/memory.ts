import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { CRANK_DIR, errorMessage } from "./config.ts";
import { runGit } from "./activity.ts";
import * as queries from "./memory-read.ts";
import { migrate, SCHEMA_VERSION, userVersion } from "./memory-schema.ts";
import * as searching from "./memory-search.ts";
import * as writes from "./memory-write.ts";
import { saveCurrentStore, snapshotBeforeMigration } from "./store-upkeep.ts";
import type {
  ConsolidationOutcome,
  ConsolidationRow,
  Observation,
  ObservationLine,
  ObservationType,
  ProposalKind,
  ProposalRow,
  ProposalState,
  StaleRow,
} from "./wire.ts";

// The memory store: <project>/.crank/memory.db, one SQLite file per project
// holding digests and their observations. node:sqlite loads through
// process.getBuiltinModule on each open, so a runtime without it degrades to
// "unreadable" instead of failing at import time.

export const MEMORY_FILE = "memory.db";
export const MEMORY_OLDER_NOTE =
  "crank-mem: memory.db predates this version; run `crank-mem upgrade`.";
export const MEMORY_NEWER_NOTE =
  "crank-mem: memory.db is newer than this version; run `crank-mem upgrade`.";
export const MEMORY_UNREADABLE_NOTE = "crank-mem: .crank/memory.db is not a readable database.";
export const NO_MEMORY_NOTE = "crank-mem: no memory exists yet.";
export type MemoryReader = Omit<
  Memory,
  "appendDigest" | "recordRejection" | "putVectors" | "recordConsolidation" | "maintain"
>;
export type MemoryRead =
  | { status: "open"; memory: MemoryReader }
  | { status: "missing" | "older" | "newer" | "unreadable" };
/** migratedFrom: the version the open migrated from (0 for a fresh store), null when it applied no step. */
export type MemoryWrite =
  | { status: "open"; memory: Memory; migratedFrom: number | null }
  | { status: "newer" | "unreadable" }
  | { status: "unmigrated"; detail: string };
export type StoreMigration =
  | { status: "absent" | "current" | "newer" }
  | { status: "migrated"; from: number; to: number }
  | { status: "failed"; detail: string };

export type Position = { uuid: string; timestamp: string };
export type SessionKey = { id: string; agent: "claude"; transcriptPath: string };
export type DigestSummary = {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
};
export type NewObservation = {
  type: ObservationType;
  title: string;
  narrative: string;
  facts: string[];
  filesRead: string[];
  filesModified: string[];
};
export type DigestInput = {
  session: SessionKey;
  expected: Position | null;
  next: Position;
  model: string;
  costUsd: number;
  summary: DigestSummary;
  observations: NewObservation[];
  proposals: { kind: ProposalKind; bullet: string }[];
  stale: { id: number; reason: string }[];
};
type SearchHit = ObservationLine;
export type SearchQuery = {
  text: string;
  vector: { model: string; values: Float32Array } | null;
  limit: number;
  type: ObservationType | null;
  sinceMs: number | null;
  file: string | null;
  stale: boolean;
};
type MemoryStats = {
  observations: number;
  unembedded: number;
  lastDigestMs: number | null;
  costUsdSince: number;
  pendingProposals: number;
  staleRows: number;
  lastConsolidation: { startedMs: number; outcome: ConsolidationOutcome } | null;
};
export type PendingWork = {
  proposals: { id: number; kind: ProposalKind; bullet: string }[];
  stale: { id: number; title: string; narrative: string; reason: string }[];
  lastStartMs: number | null;
  lastOkStartMs: number | null;
};
type RunBase = { startedMs: number; model: string | null; costUsd: number };
type ConsolidationRecord =
  | (RunBase & {
      outcome: "ok";
      sent: number[];
      decided: { id: number; state: "accepted" | "rejected"; reason: string }[];
      verdicts: { id: number; verdict: "confirmed" | "cleared" }[];
    })
  | (RunBase & { outcome: "rejected" | "retry" | "stopped"; sent: number[] })
  | (RunBase & { outcome: "conflict" });

export interface Memory {
  position(sessionId: string): Position | null;
  latestSummary(sessionId: string): DigestSummary | null;
  appendDigest(input: DigestInput): "appended" | "stale";
  recordRejection(session: SessionKey): number;
  unembedded(model: string, limit: number): { id: number; text: string }[];
  putVectors(model: string, rows: { id: number; vector: Float32Array }[]): void;
  hasVectors(model: string): boolean;
  search(query: SearchQuery): SearchHit[];
  /** Lines newest first by `(created_at, id)`, strictly older than `before` when it is set. */
  list(
    q: Pick<SearchQuery, "limit" | "type" | "file" | "stale"> & {
      before: { createdAtMs: number; id: number } | null;
    },
  ): ObservationLine[];
  timeline(id: number, depth: number): ObservationLine[] | null;
  get(ids: number[]): Observation[];
  recent(limit: number): ObservationLine[];
  latestNextSteps(): string | null;
  fileHistory(relPath: string, limit: number): ObservationLine[];
  stats(model: string, sinceMs: number): MemoryStats;
  /** Pending proposals and unreviewed stale rows, oldest first; `limit` caps each list. */
  pending(limit: number): PendingWork;
  /** Proposals newest first by id, in `state` when it is set, with ids below `beforeId` when it is set. */
  proposalRows(q: {
    state: ProposalState | null;
    beforeId: number | null;
    limit: number;
  }): ProposalRow[];
  /** Observations flagged stale, newest flag first by `(stale_at, id)`, strictly older than `before` when it is set. */
  staleRows(q: { before: { staleAtMs: number; id: number } | null; limit: number }): StaleRow[];
  /** Consolidation runs newest first by id, with ids below `beforeId` when it is set. */
  consolidationRows(q: { beforeId: number | null; limit: number }): ConsolidationRow[];
  recordConsolidation(run: ConsolidationRecord): void;
  /**
   * The daily pass (store-upkeep's `dailyUpkeep`) at `nowMs`, default `Date.now()`. Null when not due;
   * throws, before any delete, when the snapshot fails.
   */
  maintain(nowMs?: number): { snapshot: string; deleted: number } | null;
  close(): void;
}

/**
 * The store for the project at `root`. A linked worktree (`.git` is a file)
 * shares its main checkout's store when that checkout is initialized.
 */
export function memoryPath(root: string): string {
  const own = path.join(root, CRANK_DIR, MEMORY_FILE);
  try {
    if (!fs.statSync(path.join(root, ".git")).isFile()) return own;
  } catch {
    return own;
  }
  const r = runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 500);
  if ("error" in r) return own;
  const main = path.dirname(r.stdout.trim());
  return fs.existsSync(path.join(main, CRANK_DIR, "config.json"))
    ? path.join(main, CRANK_DIR, MEMORY_FILE)
    : own;
}

export function openMemory(file: string, mode: "read"): MemoryRead;
export function openMemory(file: string, mode: "write"): MemoryWrite;
export function openMemory(file: string, mode: "read" | "write"): MemoryRead | MemoryWrite {
  const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite | undefined;
  if (!mod) return { status: "unreadable" };
  const read = mode === "read";
  // node:sqlite creates a missing file on open, so a reader checks first.
  if (read && !fs.existsSync(file)) return { status: "missing" };
  let db: sqlite.DatabaseSync | undefined;
  try {
    if (!read) fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new mod.DatabaseSync(file, { timeout: read ? 200 : 10000 });
    if (read) db.exec("PRAGMA query_only=ON");
    const v = userVersion(db);
    if (v > SCHEMA_VERSION) {
      db.close();
      return { status: "newer" };
    }
    return read ? readerAt(db, file, v) : writerAt(db, file, v);
  } catch {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
    return { status: "unreadable" };
  }
}

/** The reader over `db` at user_version `v`, at most SCHEMA_VERSION; an older store closes `db`. */
function readerAt(db: sqlite.DatabaseSync, file: string, v: number): MemoryRead {
  if (v < SCHEMA_VERSION) {
    db.close();
    return { status: v === 0 ? "missing" : "older" };
  }
  return { status: "open", memory: createMemory(db, file) };
}

/** The writer over `db` at user_version `v`, at most SCHEMA_VERSION, migrated first when older. */
function writerAt(db: sqlite.DatabaseSync, file: string, v: number): MemoryWrite {
  if (v === SCHEMA_VERSION)
    return { status: "open", memory: createMemory(db, file), migratedFrom: null };
  if (v === 0) {
    db.exec("PRAGMA journal_mode=WAL");
  } else {
    // VACUUM INTO cannot run inside migrate's transaction, so the snapshot comes first.
    try {
      snapshotBeforeMigration(db, file, v);
    } catch (err) {
      db.close();
      return { status: "unmigrated", detail: errorMessage(err) };
    }
  }
  const from = migrate(db);
  if (from === "newer") {
    db.close();
    return { status: "newer" };
  }
  return { status: "open", memory: createMemory(db, file), migratedFrom: from };
}

const READ_NOTES: Record<Exclude<MemoryRead["status"], "open">, string> = {
  missing: NO_MEMORY_NOTE,
  older: MEMORY_OLDER_NOTE,
  newer: MEMORY_NEWER_NOTE,
  unreadable: MEMORY_UNREADABLE_NOTE,
};

/** `fn`'s answer over the store, opened read-only and closed after; a store that does not open answers its note. */
export async function withReader<T>(
  file: string,
  fn: (memory: MemoryReader) => T | Promise<T>,
): Promise<T | { note: string }> {
  const opened = openMemory(file, "read");
  if (opened.status !== "open") return { note: READ_NOTES[opened.status] };
  try {
    return await fn(opened.memory);
  } finally {
    opened.memory.close();
  }
}

/** Brings an existing store to the current schema (snapshotting a version-n store first); never creates a store. */
export function migrateStore(storeFile: string): StoreMigration {
  if (!fs.existsSync(storeFile)) return { status: "absent" };
  const opened = openMemory(storeFile, "write");
  switch (opened.status) {
    case "open": {
      opened.memory.close();
      const from = opened.migratedFrom;
      return from === null
        ? { status: "current" }
        : { status: "migrated", from, to: SCHEMA_VERSION };
    }
    case "newer":
      return { status: "newer" };
    case "unmigrated":
      return { status: "failed", detail: opened.detail };
    case "unreadable":
      return { status: "failed", detail: "unreadable" };
  }
}

export function memoryStatus(file: string): MemoryRead["status"] {
  const result = openMemory(file, "read");
  if (result.status === "open") result.memory.close();
  return result.status;
}

/** A restore retries a locked store every RESTORE_RETRY_MS for RESTORE_WAIT_MS. */
const RESTORE_WAIT_MS = 10_000;
const RESTORE_RETRY_MS = 100;

/** Why a snapshot cannot be restored, or null when it passes the integrity check at a version this code reads or migrates. */
function snapshotProblem(src: sqlite.DatabaseSync): string | null {
  try {
    const check = String(Object.values(src.prepare("PRAGMA integrity_check").get() ?? {})[0]);
    if (check !== "ok") return `integrity_check: ${check}`;
    const v = userVersion(src);
    return v < 1 || v > SCHEMA_VERSION ? `user_version ${v} is not 1 to ${SCHEMA_VERSION}` : null;
  } catch (err) {
    return errorMessage(err);
  }
}

/**
 * Copies `snapshotFile` over `storeFile`, first saving the current store as a daily snapshot.
 * savedAs: where the previous store went, null when there was none.
 */
export async function restoreMemory(
  storeFile: string,
  snapshotFile: string,
): Promise<
  { status: "restored"; savedAs: string | null } | { status: "invalid" | "busy"; detail: string }
> {
  const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite | undefined;
  if (!mod) throw new Error("node:sqlite is unavailable");
  let src: sqlite.DatabaseSync;
  try {
    src = new mod.DatabaseSync(snapshotFile, { readOnly: true });
  } catch (err) {
    return { status: "invalid", detail: errorMessage(err) };
  }
  try {
    const problem = snapshotProblem(src);
    if (problem !== null) return { status: "invalid", detail: problem };
    const savedAs = saveCurrentStore(mod, storeFile);
    const firstMs = Date.now();
    for (;;) {
      try {
        await mod.backup(src, storeFile);
        break;
      } catch {
        if (Date.now() - firstMs >= RESTORE_WAIT_MS)
          return { status: "busy", detail: "memory.db stayed locked for 10 s" };
        await new Promise((resolve) => setTimeout(resolve, RESTORE_RETRY_MS));
      }
    }
    const db = new mod.DatabaseSync(storeFile);
    try {
      db.exec("PRAGMA journal_mode=WAL");
    } finally {
      db.close();
    }
    return { status: "restored", savedAs };
  } finally {
    src.close();
  }
}

/** The one renderer of `#<id> <YYYY-MM-DD> <type> [stale] <title>`, dated in local time; `[stale]` only on a flagged row. */
export function formatLine(line: ObservationLine): string {
  return `#${line.id} ${localDate(line.createdAtMs)} ${line.type} ${line.stale ? "[stale] " : ""}${line.title}`;
}

/** `YYYY-MM-DD` of an epoch time in the local zone. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function createMemory(db: sqlite.DatabaseSync, file: string): Memory {
  return {
    position: (sessionId) => queries.position(db, sessionId),
    latestSummary: (sessionId) => queries.latestSummary(db, sessionId),
    appendDigest: (input) => writes.appendDigest(db, input),
    recordRejection: (session) => writes.recordRejection(db, session),
    unembedded: (model, limit) => queries.unembedded(db, model, limit),
    putVectors: (model, rows) => writes.putVectors(db, model, rows),
    hasVectors: (model) => queries.hasVectors(db, model),
    search: (query) => searching.search(db, query),
    list: (q) => queries.list(db, q),
    timeline: (id, depth) => queries.timeline(db, id, depth),
    get: (ids) => queries.get(db, ids),
    recent: (limit) => queries.recent(db, limit),
    latestNextSteps: () => queries.latestNextSteps(db),
    fileHistory: (relPath, limit) => queries.fileHistory(db, relPath, limit),
    stats: (model, sinceMs) => queries.stats(db, model, sinceMs),
    pending: (limit) => queries.pending(db, limit),
    proposalRows: (q) => queries.proposalRows(db, q),
    staleRows: (q) => queries.staleRows(db, q),
    consolidationRows: (q) => queries.consolidationRows(db, q),
    recordConsolidation: (run) => writes.recordConsolidation(db, run),
    maintain: (nowMs) => writes.maintain(db, file, nowMs),
    close: () => db.close(),
  };
}

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { ISO_DATE } from "./bullets.ts";
import { CRANK_DIR, errorMessage } from "./config.ts";
import { runGit } from "./scanner.ts";
import { dailyUpkeep, saveCurrentStore, snapshotBeforeMigration } from "./store-upkeep.ts";

// The memory store: <project>/.crank/memory.db, one SQLite file per project
// holding digests and their observations. node:sqlite loads through
// process.getBuiltinModule on each open, so a runtime without it degrades to
// "unreadable" instead of failing at import time.

const SCHEMA_VERSION = 2;
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

/** SCHEMA_V1's observations.type CHECK repeats this list as a literal; schema v1 freezes it. */
export const OBSERVATION_TYPES = [
  "bugfix",
  "feature",
  "refactor",
  "change",
  "discovery",
  "decision",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];
export const isObservationType = (value: string): value is ObservationType =>
  OBSERVATION_TYPES.some((t) => t === value);
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
export type ProposalKind = "preference" | "memory";
export const PROPOSAL_STATES = ["pending", "accepted", "rejected", "expired"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];
export const isProposalState = (value: string): value is ProposalState =>
  PROPOSAL_STATES.some((s) => s === value);
export type ProposalRow = {
  id: number;
  kind: ProposalKind;
  bullet: string;
  state: ProposalState;
  reason: string | null;
  createdAtMs: number;
  decidedAtMs: number | null;
};
export type StaleRow = {
  id: number;
  title: string;
  staleAtMs: number;
  reason: string;
  reviewed: boolean;
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
export type ObservationLine = {
  id: number;
  createdAtMs: number;
  type: ObservationType;
  title: string;
  stale: boolean;
};
export type Observation = ObservationLine & {
  sessionId: string;
  narrative: string;
  facts: string[];
  filesRead: string[];
  filesModified: string[];
  staleFlag: { atMs: number; reason: string } | null;
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
export type ConsolidationOutcome = "ok" | "conflict" | "rejected" | "retry" | "stopped";
export type ConsolidationRow = {
  id: number;
  startedAtMs: number;
  finishedAtMs: number;
  outcome: ConsolidationOutcome;
  model: string | null;
  costUsd: number;
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
/** A proposal still pending after this many counted runs expires. */
const MAX_ATTEMPTS = 3;

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

const SCHEMA_V1 = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, transcript_path TEXT NOT NULL,
  position_uuid TEXT, position_ts TEXT, rejections INTEGER NOT NULL DEFAULT 0);
CREATE TABLE digests (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at INTEGER NOT NULL, model TEXT NOT NULL, cost_usd REAL NOT NULL,
  request TEXT NOT NULL, investigated TEXT NOT NULL, learned TEXT NOT NULL,
  completed TEXT NOT NULL, next_steps TEXT NOT NULL);
CREATE TABLE observations (
  id INTEGER PRIMARY KEY, digest_id INTEGER NOT NULL REFERENCES digests(id),
  type TEXT NOT NULL CHECK (type IN ('bugfix','feature','refactor','change','discovery','decision')),
  title TEXT NOT NULL, narrative TEXT NOT NULL, facts TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE observation_files (
  path TEXT NOT NULL, observation_id INTEGER NOT NULL REFERENCES observations(id),
  kind TEXT NOT NULL CHECK (kind IN ('read','modified')),
  PRIMARY KEY (path, observation_id, kind)) WITHOUT ROWID;
CREATE TABLE observation_vectors (
  observation_id INTEGER PRIMARY KEY REFERENCES observations(id),
  model TEXT NOT NULL, vector BLOB NOT NULL);
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title, narrative, facts, content='observations', content_rowid='id',
  tokenize='porter unicode61');
CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, narrative, facts) VALUES (new.id, new.title, new.narrative, new.facts);
END;
CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts)
    VALUES ('delete', old.id, old.title, old.narrative, old.facts);
END;
`;

const SCHEMA_V2 = `
ALTER TABLE observations ADD COLUMN stale_at INTEGER;
ALTER TABLE observations ADD COLUMN stale_reason TEXT CHECK ((stale_at IS NULL) = (stale_reason IS NULL));
ALTER TABLE observations ADD COLUMN stale_reviewed INTEGER NOT NULL DEFAULT 0;
CREATE INDEX observations_stale_at ON observations(stale_at) WHERE stale_at IS NOT NULL;
CREATE TABLE proposals (
  id INTEGER PRIMARY KEY, digest_id INTEGER NOT NULL REFERENCES digests(id),
  kind TEXT NOT NULL CHECK (kind IN ('preference','memory')),
  bullet TEXT NOT NULL, bullet_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','rejected','expired')),
  attempts INTEGER NOT NULL DEFAULT 0, reason TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE TABLE consolidations (
  id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','conflict','rejected','retry','stopped')),
  model TEXT, cost_usd REAL NOT NULL DEFAULT 0);
`;

/** STEPS[v] migrates a store at user_version v to v + 1. */
const STEPS: readonly string[] = [SCHEMA_V1, SCHEMA_V2];

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
    if (read) {
      if (v < SCHEMA_VERSION) {
        db.close();
        return { status: v === 0 ? "missing" : "older" };
      }
      return { status: "open", memory: createMemory(db, file) };
    }
    let migratedFrom: number | null = null;
    if (v < SCHEMA_VERSION) {
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
      migratedFrom = from;
    }
    return { status: "open", memory: createMemory(db, file), migratedFrom };
  } catch {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
    return { status: "unreadable" };
  }
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

function userVersion(db: sqlite.DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
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

/**
 * Applies the forward steps under a write lock. Returns the version it found when it
 * applied a step, null when another process had already migrated the store, and
 * "newer" when another process moved it past this version.
 */
function migrate(db: sqlite.DatabaseSync): number | null | "newer" {
  return transaction(db, () => {
    const v = userVersion(db);
    if (v >= SCHEMA_VERSION) return v > SCHEMA_VERSION ? "newer" : null;
    for (let step = v; step < SCHEMA_VERSION; step++) db.exec(STEPS[step]!);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return v;
  });
}

function transaction<T>(db: sqlite.DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no open transaction */
    }
    throw err;
  }
}

type Row = Record<string, unknown>;

const LINE_COLUMNS = "o.id, o.created_at, o.type, o.title, o.stale_at";
const NEWEST_FIRST = "ORDER BY o.created_at DESC, o.id DESC";
const UNEMBEDDED =
  "NOT EXISTS (SELECT 1 FROM observation_vectors v WHERE v.observation_id = o.id AND v.model = ?)";

function toLine(row: Row): ObservationLine {
  return {
    id: Number(row.id),
    createdAtMs: Number(row.created_at),
    type: row.type as ObservationType,
    title: String(row.title),
    stale: row.stale_at !== null,
  };
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

// Search fuses a keyword list and a vector list by reciprocal rank (k = RRF_K),
// each list cut at LIST_DEPTH rows; equal scores go to the newest row.
const RRF_K = 60;
const LIST_DEPTH = 50;

/** The terms (on observations `o`) and their bind values that `search` and `list` narrow by. */
function lineFilters(q: Pick<SearchQuery, "type" | "sinceMs" | "file" | "stale">): {
  filters: string[];
  params: sqlite.SQLInputValue[];
} {
  const filters: string[] = q.stale ? [] : ["o.stale_at IS NULL"];
  const params: sqlite.SQLInputValue[] = [];
  if (q.type !== null) {
    filters.push("o.type = ?");
    params.push(q.type);
  }
  if (q.sinceMs !== null) {
    filters.push("o.created_at >= ?");
    params.push(q.sinceMs);
  }
  if (q.file !== null) {
    filters.push("o.id IN (SELECT observation_id FROM observation_files WHERE path = ?)");
    params.push(q.file);
  }
  return { filters, params };
}

function newestFirst(a: ObservationLine, b: ObservationLine): number {
  return b.createdAtMs - a.createdAtMs || b.id - a.id;
}

/** Quotes every whitespace-separated term so raw input never parses as FTS5 syntax; "" when there are none. */
function ftsQuery(text: string, joiner: " " | " OR "): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(joiner);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i]! * b[i]!;
  return Number.isNaN(sum) ? -Infinity : sum;
}

/** sha256 hex of the text, lowercased, with whitespace runs collapsed and trimmed. */
function normalizedHash(text: string): string {
  return crypto
    .createHash("sha256")
    .update(text.toLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex");
}

/** An observation's dedupe key: its normalized title and narrative. */
function contentHash(title: string, narrative: string): string {
  return normalizedHash(title + "\n" + narrative);
}

/** A proposal's dedupe key: its normalized bullet without dates or the `()` they leave empty. */
function bulletHash(bullet: string): string {
  return normalizedHash(bullet.replace(ISO_DATE, "").replace(/\(\s*\)/g, ""));
}

function samePosition(a: Position | null, b: Position | null): boolean {
  return a === null || b === null ? a === b : a.uuid === b.uuid && a.timestamp === b.timestamp;
}

function createMemory(db: sqlite.DatabaseSync, file: string): Memory {
  const one = (sql: string, ...params: sqlite.SQLInputValue[]) =>
    db.prepare(sql).get(...params) as Row | undefined;
  const all = (sql: string, ...params: sqlite.SQLInputValue[]) =>
    db.prepare(sql).all(...params) as Row[];

  function list(q: Parameters<Memory["list"]>[0]): ObservationLine[] {
    const { filters, params } = lineFilters({ ...q, sinceMs: null });
    if (q.before !== null) {
      filters.push("(o.created_at, o.id) < (?, ?)");
      params.push(q.before.createdAtMs, q.before.id);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    return all(
      `SELECT ${LINE_COLUMNS} FROM observations o ${where} ${NEWEST_FIRST} LIMIT ?`,
      ...params,
      q.limit,
    ).map(toLine);
  }

  function position(sessionId: string): Position | null {
    const row = one("SELECT position_uuid, position_ts FROM sessions WHERE id = ?", sessionId);
    if (!row || row.position_uuid === null || row.position_ts === null) return null;
    return { uuid: String(row.position_uuid), timestamp: String(row.position_ts) };
  }

  function hasVectors(model: string): boolean {
    return one("SELECT 1 FROM observation_vectors WHERE model = ? LIMIT 1", model) !== undefined;
  }

  return {
    position,

    latestSummary(sessionId) {
      const row = one(
        `SELECT request, investigated, learned, completed, next_steps FROM digests
         WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        sessionId,
      );
      if (!row) return null;
      return {
        request: String(row.request),
        investigated: String(row.investigated),
        learned: String(row.learned),
        completed: String(row.completed),
        next_steps: String(row.next_steps),
      };
    },

    appendDigest(input) {
      const { session, next, summary } = input;
      const stale = Symbol();
      const result = transaction(db, () => {
        if (!samePosition(position(session.id), input.expected)) return stale;
        db.prepare(
          `INSERT INTO sessions (id, agent, transcript_path, position_uuid, position_ts, rejections)
           VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, transcript_path = excluded.transcript_path,
             position_uuid = excluded.position_uuid, position_ts = excluded.position_ts, rejections = 0`,
        ).run(session.id, session.agent, session.transcriptPath, next.uuid, next.timestamp);
        const now = Date.now();
        const digestId = db
          .prepare(
            `INSERT INTO digests (session_id, created_at, model, cost_usd, request, investigated, learned, completed, next_steps)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            session.id,
            now,
            input.model,
            input.costUsd,
            summary.request,
            summary.investigated,
            summary.learned,
            summary.completed,
            summary.next_steps,
          ).lastInsertRowid;
        // ON CONFLICT names the unique column so a CHECK violation still throws; OR IGNORE would swallow it.
        const insertObservation = db.prepare(
          `INSERT INTO observations (digest_id, type, title, narrative, facts, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING`,
        );
        const insertFile = db.prepare(
          "INSERT OR IGNORE INTO observation_files (path, observation_id, kind) VALUES (?, ?, ?)",
        );
        for (const o of input.observations) {
          const inserted = insertObservation.run(
            digestId,
            o.type,
            o.title,
            o.narrative,
            JSON.stringify(o.facts),
            contentHash(o.title, o.narrative),
            now,
          );
          if (inserted.changes === 0) continue;
          for (const file of o.filesRead) insertFile.run(file, inserted.lastInsertRowid, "read");
          for (const file of o.filesModified)
            insertFile.run(file, inserted.lastInsertRowid, "modified");
        }
        const insertProposal = db.prepare(
          `INSERT INTO proposals (digest_id, kind, bullet, bullet_hash, created_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(bullet_hash) DO NOTHING`,
        );
        for (const p of input.proposals)
          insertProposal.run(digestId, p.kind, p.bullet, bulletHash(p.bullet), now);
        // A row keeps its first flag.
        const flag = db.prepare(
          "UPDATE observations SET stale_at = ?, stale_reason = ?, stale_reviewed = 0 WHERE id = ? AND stale_at IS NULL",
        );
        for (const f of input.stale) flag.run(now, f.reason, f.id);
        return "appended" as const;
      });
      return result === stale ? "stale" : result;
    },

    recordRejection(session) {
      const row = one(
        `INSERT INTO sessions (id, agent, transcript_path, rejections) VALUES (?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET rejections = rejections + 1 RETURNING rejections`,
        session.id,
        session.agent,
        session.transcriptPath,
      );
      return Number(row!.rejections);
    },

    unembedded(model, limit) {
      return all(
        `SELECT o.id, o.title, o.narrative FROM observations o WHERE ${UNEMBEDDED}
         ORDER BY o.created_at, o.id LIMIT ?`,
        model,
        limit,
      ).map((row) => ({
        id: Number(row.id),
        text: `${String(row.title)}\n${String(row.narrative)}`,
      }));
    },

    putVectors(model, rows) {
      transaction(db, () => {
        const put = db.prepare(
          "INSERT OR REPLACE INTO observation_vectors (observation_id, model, vector) VALUES (?, ?, ?)",
        );
        for (const { id, vector } of rows) {
          put.run(id, model, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
        }
      });
    },

    hasVectors,

    search(query) {
      const { filters, params } = lineFilters(query);
      const where = filters.map((f) => ` AND ${f}`).join("");
      const keyword = (joiner: " " | " OR "): ObservationLine[] => {
        const match = ftsQuery(query.text, joiner);
        if (!match) return [];
        return all(
          `SELECT ${LINE_COLUMNS} FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid
           WHERE observations_fts MATCH ?${where}
           ORDER BY bm25(observations_fts), o.created_at DESC, o.id DESC LIMIT ?`,
          match,
          ...params,
          LIST_DEPTH,
        ).map(toLine);
      };
      const vector = query.vector;
      if (!vector || !hasVectors(vector.model)) {
        const and = keyword(" ");
        return (and.length > 0 ? and : keyword(" OR ")).slice(0, query.limit);
      }
      const byVector = all(
        `SELECT ${LINE_COLUMNS}, v.vector FROM observation_vectors v JOIN observations o ON o.id = v.observation_id
         WHERE v.model = ?${where}`,
        vector.model,
        ...params,
      )
        .map((row) => {
          const bytes = row.vector as Uint8Array;
          const stored = new Float32Array(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          );
          return { line: toLine(row), score: dot(stored, vector.values) };
        })
        .sort((x, y) => y.score - x.score || newestFirst(x.line, y.line))
        .slice(0, LIST_DEPTH)
        .map((s) => s.line);
      const fused = new Map<number, { line: ObservationLine; score: number }>();
      for (const list of [keyword(" "), byVector]) {
        list.forEach((line, i) => {
          const entry = fused.get(line.id) ?? { line, score: 0 };
          entry.score += 1 / (RRF_K + i + 1);
          fused.set(line.id, entry);
        });
      }
      return [...fused.values()]
        .sort((x, y) => y.score - x.score || newestFirst(x.line, y.line))
        .slice(0, query.limit)
        .map((entry) => entry.line);
    },

    list,

    timeline(id, depth) {
      const anchor = one(`SELECT ${LINE_COLUMNS} FROM observations o WHERE o.id = ?`, id);
      if (!anchor) return null;
      const at = Number(anchor.created_at);
      const before = all(
        `SELECT ${LINE_COLUMNS} FROM observations o WHERE (o.created_at, o.id) < (?, ?) ${NEWEST_FIRST} LIMIT ?`,
        at,
        id,
        depth,
      ).reverse();
      const after = all(
        `SELECT ${LINE_COLUMNS} FROM observations o WHERE (o.created_at, o.id) > (?, ?)
         ORDER BY o.created_at, o.id LIMIT ?`,
        at,
        id,
        depth,
      );
      return [...before, anchor, ...after].map(toLine);
    },

    get(ids) {
      const found: Observation[] = [];
      for (const id of ids) {
        const row = one(
          `SELECT ${LINE_COLUMNS}, o.stale_reason, o.narrative, o.facts, d.session_id FROM observations o
           JOIN digests d ON d.id = o.digest_id WHERE o.id = ?`,
          id,
        );
        if (!row) continue;
        const files = all(
          "SELECT path, kind FROM observation_files WHERE observation_id = ? ORDER BY path",
          id,
        );
        found.push({
          ...toLine(row),
          sessionId: String(row.session_id),
          narrative: String(row.narrative),
          facts: JSON.parse(String(row.facts)) as string[],
          filesRead: files.filter((f) => f.kind === "read").map((f) => String(f.path)),
          filesModified: files.filter((f) => f.kind === "modified").map((f) => String(f.path)),
          staleFlag:
            row.stale_at === null
              ? null
              : { atMs: Number(row.stale_at), reason: String(row.stale_reason) },
        });
      }
      return found;
    },

    recent(limit) {
      return list({ limit, type: null, file: null, stale: false, before: null });
    },

    latestNextSteps() {
      const row = one("SELECT next_steps FROM digests ORDER BY created_at DESC, id DESC LIMIT 1");
      if (!row) return null;
      const text = String(row.next_steps).trim();
      return text.toLowerCase().replace(/\.$/, "") === "none" ? null : text;
    },

    fileHistory(relPath, limit) {
      return list({ limit, type: null, file: relPath, stale: false, before: null });
    },

    stats(model, sinceMs) {
      const counts = one(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE ${UNEMBEDDED}) AS pending FROM observations o`,
        model,
      )!;
      const digests = one(
        "SELECT MAX(created_at) AS last, COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= ?), 0) AS cost FROM digests",
        sinceMs,
      )!;
      const runCost = one(
        "SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM consolidations WHERE started_at >= ?",
        sinceMs,
      )!;
      const last = one(
        "SELECT started_at, outcome FROM consolidations ORDER BY started_at DESC, id DESC LIMIT 1",
      );
      const flags = one(
        `SELECT (SELECT COUNT(*) FROM proposals WHERE state = 'pending') AS proposals,
                (SELECT COUNT(*) FROM observations WHERE stale_at IS NOT NULL) AS stale`,
      )!;
      return {
        observations: Number(counts.total),
        unembedded: Number(counts.pending),
        lastDigestMs: digests.last === null ? null : Number(digests.last),
        costUsdSince: Number(digests.cost) + Number(runCost.cost),
        pendingProposals: Number(flags.proposals),
        staleRows: Number(flags.stale),
        lastConsolidation: last
          ? { startedMs: Number(last.started_at), outcome: last.outcome as ConsolidationOutcome }
          : null,
      };
    },

    pending(limit) {
      const proposals = all(
        "SELECT id, kind, bullet FROM proposals WHERE state = 'pending' ORDER BY created_at, id LIMIT ?",
        limit,
      ).map((row) => ({
        id: Number(row.id),
        kind: row.kind as ProposalKind,
        bullet: String(row.bullet),
      }));
      const stale = all(
        `SELECT id, title, narrative, stale_reason FROM observations
         WHERE stale_at IS NOT NULL AND stale_reviewed = 0 ORDER BY stale_at, id LIMIT ?`,
        limit,
      ).map((row) => ({
        id: Number(row.id),
        title: String(row.title),
        narrative: String(row.narrative),
        reason: String(row.stale_reason),
      }));
      const runs = one(
        `SELECT MAX(started_at) AS last, MAX(started_at) FILTER (WHERE outcome = 'ok') AS lastOk FROM consolidations`,
      )!;
      const ms = (v: unknown) => (v === null ? null : Number(v));
      return { proposals, stale, lastStartMs: ms(runs.last), lastOkStartMs: ms(runs.lastOk) };
    },

    proposalRows(q) {
      const filters: string[] = [];
      const params: (string | number)[] = [];
      if (q.state !== null) {
        filters.push("state = ?");
        params.push(q.state);
      }
      if (q.beforeId !== null) {
        filters.push("id < ?");
        params.push(q.beforeId);
      }
      const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
      return all(
        `SELECT id, kind, bullet, state, reason, created_at, decided_at FROM proposals ${where}
         ORDER BY id DESC LIMIT ?`,
        ...params,
        q.limit,
      ).map((row) => ({
        id: Number(row.id),
        kind: row.kind as ProposalKind,
        bullet: String(row.bullet),
        state: row.state as ProposalState,
        reason: row.reason === null ? null : String(row.reason),
        createdAtMs: Number(row.created_at),
        decidedAtMs: row.decided_at === null ? null : Number(row.decided_at),
      }));
    },

    staleRows(q) {
      const before = q.before === null ? "" : "AND (stale_at, id) < (?, ?)";
      const params = q.before === null ? [] : [q.before.staleAtMs, q.before.id];
      return all(
        `SELECT id, title, stale_at, stale_reason, stale_reviewed FROM observations
         WHERE stale_at IS NOT NULL ${before} ORDER BY stale_at DESC, id DESC LIMIT ?`,
        ...params,
        q.limit,
      ).map((row) => ({
        id: Number(row.id),
        title: String(row.title),
        staleAtMs: Number(row.stale_at),
        reason: String(row.stale_reason),
        reviewed: Number(row.stale_reviewed) === 1,
      }));
    },

    consolidationRows(q) {
      const before = q.beforeId === null ? "" : "WHERE id < ?";
      const params = q.beforeId === null ? [] : [q.beforeId];
      return all(
        `SELECT id, started_at, finished_at, outcome, model, cost_usd FROM consolidations
         ${before} ORDER BY id DESC LIMIT ?`,
        ...params,
        q.limit,
      ).map((row) => ({
        id: Number(row.id),
        startedAtMs: Number(row.started_at),
        finishedAtMs: Number(row.finished_at),
        outcome: row.outcome as ConsolidationOutcome,
        model: row.model === null ? null : String(row.model),
        costUsd: Number(row.cost_usd),
      }));
    },

    recordConsolidation(run) {
      transaction(db, () => {
        const now = Date.now();
        db.prepare(
          "INSERT INTO consolidations (started_at, finished_at, outcome, model, cost_usd) VALUES (?, ?, ?, ?, ?)",
        ).run(run.startedMs, now, run.outcome, run.model, run.costUsd);
        if (run.outcome === "conflict") return;
        const attempt = db.prepare(
          "UPDATE proposals SET attempts = attempts + 1 WHERE id = ? AND state = 'pending'",
        );
        for (const id of run.sent) attempt.run(id);
        if (run.outcome === "ok") {
          const decide = db.prepare(
            "UPDATE proposals SET state = ?, reason = ?, decided_at = ? WHERE id = ? AND state = 'pending'",
          );
          for (const d of run.decided) decide.run(d.state, d.reason, now, d.id);
          const confirm = db.prepare(
            "UPDATE observations SET stale_reviewed = 1 WHERE id = ? AND stale_at IS NOT NULL",
          );
          const clear = db.prepare(
            "UPDATE observations SET stale_at = NULL, stale_reason = NULL, stale_reviewed = 0 WHERE id = ?",
          );
          for (const v of run.verdicts) (v.verdict === "confirmed" ? confirm : clear).run(v.id);
        }
        const expire = db.prepare(
          "UPDATE proposals SET state = 'expired', decided_at = ? WHERE id = ? AND state = 'pending' AND attempts >= ?",
        );
        for (const id of run.sent) expire.run(now, id, MAX_ATTEMPTS);
      });
    },

    maintain(nowMs = Date.now()) {
      return dailyUpkeep(db, file, nowMs, (cutoff) =>
        transaction(db, () => {
          const expired = "SELECT id FROM observations WHERE stale_at IS NOT NULL AND stale_at < ?";
          db.prepare(`DELETE FROM observation_files WHERE observation_id IN (${expired})`).run(
            cutoff,
          );
          db.prepare(`DELETE FROM observation_vectors WHERE observation_id IN (${expired})`).run(
            cutoff,
          );
          return Number(
            db
              .prepare("DELETE FROM observations WHERE stale_at IS NOT NULL AND stale_at < ?")
              .run(cutoff).changes,
          );
        }),
      );
    },

    close: () => db.close(),
  };
}

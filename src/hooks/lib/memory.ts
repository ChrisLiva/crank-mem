import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";

// The memory store: <project>/.crank/memory.db, one SQLite file per project
// holding digests and their observations. node:sqlite loads through
// process.getBuiltinModule on each open, so a runtime without it degrades to
// "unreadable" instead of failing at import time.

export const SCHEMA_VERSION = 1;
export const MEMORY_FILE = "memory.db";
export const MEMORY_NEWER_NOTE = "crank-mem: memory.db is newer than this version; run `crank-mem upgrade`.";
export const MEMORY_UNREADABLE_NOTE = "crank-mem: .crank/memory.db is not a readable database.";
export type MemoryReader = Omit<Memory, "appendDigest" | "recordRejection" | "putVectors">;
export type MemoryRead =
  | { status: "open"; memory: MemoryReader }
  | { status: "missing" | "newer" | "unreadable" };
export type MemoryWrite =
  | { status: "open"; memory: Memory }
  | { status: "newer" | "unreadable" };

export type ObservationType = "bugfix" | "feature" | "refactor" | "change" | "discovery" | "decision";
export type Position = { uuid: string; timestamp: string };
export type SessionKey = { id: string; agent: "claude"; transcriptPath: string };
export type DigestSummary = { request: string; investigated: string; learned: string; completed: string; next_steps: string };
export type NewObservation = {
  type: ObservationType; title: string; narrative: string; facts: string[];
  filesRead: string[]; filesModified: string[];
};
export type DigestInput = {
  session: SessionKey; expected: Position | null; next: Position;
  model: string; costUsd: number; summary: DigestSummary; observations: NewObservation[];
};
export type ObservationLine = { id: number; createdAtMs: number; type: ObservationType; title: string };
export type Observation = ObservationLine & {
  sessionId: string; narrative: string; facts: string[]; filesRead: string[]; filesModified: string[];
};
export type SearchHit = ObservationLine;
export type SearchQuery = {
  text: string; vector: { model: string; values: Float32Array } | null; limit: number;
  type: ObservationType | null; sinceMs: number | null; file: string | null;
};
export type MemoryStats = { observations: number; unembedded: number; lastDigestMs: number | null; costUsdSince: number };

export interface Memory {
  position(sessionId: string): Position | null;
  latestSummary(sessionId: string): DigestSummary | null;
  appendDigest(input: DigestInput): "appended" | "stale";
  recordRejection(session: SessionKey): number;
  unembedded(model: string, limit: number): { id: number; text: string }[];
  putVectors(model: string, rows: { id: number; vector: Float32Array }[]): void;
  search(query: SearchQuery): SearchHit[];
  timeline(id: number, depth: number): ObservationLine[] | null;
  get(ids: number[]): Observation[];
  recent(limit: number): ObservationLine[];
  latestNextSteps(): string | null;
  fileHistory(relPath: string, limit: number): ObservationLine[];
  stats(model: string, sinceMs: number): MemoryStats;
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

/** STEPS[v] migrates a store at user_version v to v + 1. */
const STEPS: readonly string[] = [SCHEMA_V1];

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
    if (v < SCHEMA_VERSION) {
      if (read) {
        db.close();
        return { status: "missing" };
      }
      if (v === 0) db.exec("PRAGMA journal_mode=WAL");
      if (!migrate(db)) {
        db.close();
        return { status: "newer" };
      }
    }
    return { status: "open", memory: createMemory(db) };
  } catch {
    try { db?.close(); } catch { /* already closed or never opened */ }
    return { status: "unreadable" };
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

/** Applies the forward steps under a write lock; false when another process moved the store past this version. */
function migrate(db: sqlite.DatabaseSync): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    const v = userVersion(db);
    if (v > SCHEMA_VERSION) {
      db.exec("ROLLBACK");
      return false;
    }
    for (let step = v; step < SCHEMA_VERSION; step++) db.exec(STEPS[step]!);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
    throw err;
  }
}

type Row = Record<string, unknown>;

const LINE_COLUMNS = "o.id, o.created_at, o.type, o.title";
const NEWEST_FIRST = "ORDER BY o.created_at DESC, o.id DESC";
const UNEMBEDDED = "NOT EXISTS (SELECT 1 FROM observation_vectors v WHERE v.observation_id = o.id AND v.model = ?)";

function toLine(row: Row): ObservationLine {
  return { id: Number(row.id), createdAtMs: Number(row.created_at), type: row.type as ObservationType, title: String(row.title) };
}

/** The one renderer of `#<id> <YYYY-MM-DD> <type> <title>`, dated in local time. */
export function formatLine(line: ObservationLine): string {
  const d = new Date(line.createdAtMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `#${line.id} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${line.type} ${line.title}`;
}

// Search fuses a keyword list and a vector list by reciprocal rank (k = RRF_K),
// each list cut at LIST_DEPTH rows; equal scores go to the newest row.
const RRF_K = 60;
const LIST_DEPTH = 50;

function newestFirst(a: ObservationLine, b: ObservationLine): number {
  return b.createdAtMs - a.createdAtMs || b.id - a.id;
}

/** Quotes every whitespace-separated term so raw input never parses as FTS5 syntax; "" when there are none. */
function ftsQuery(text: string, joiner: " " | " OR "): string {
  return text.split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"`).join(joiner);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i]! * b[i]!;
  return Number.isNaN(sum) ? -Infinity : sum;
}

/** The dedupe key: sha256 hex of the case- and whitespace-normalized title and narrative. */
function contentHash(title: string, narrative: string): string {
  const normalized = (title + "\n" + narrative).toLowerCase().replace(/\s+/g, " ").trim();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function samePosition(a: Position | null, b: Position | null): boolean {
  return a === null || b === null ? a === b : a.uuid === b.uuid && a.timestamp === b.timestamp;
}

function createMemory(db: sqlite.DatabaseSync): Memory {
  const one = (sql: string, ...params: sqlite.SQLInputValue[]) => db.prepare(sql).get(...params) as Row | undefined;
  const all = (sql: string, ...params: sqlite.SQLInputValue[]) => db.prepare(sql).all(...params) as Row[];

  function transaction<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
      throw err;
    }
  }

  function position(sessionId: string): Position | null {
    const row = one("SELECT position_uuid, position_ts FROM sessions WHERE id = ?", sessionId);
    if (!row || row.position_uuid === null || row.position_ts === null) return null;
    return { uuid: String(row.position_uuid), timestamp: String(row.position_ts) };
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
        request: String(row.request), investigated: String(row.investigated), learned: String(row.learned),
        completed: String(row.completed), next_steps: String(row.next_steps),
      };
    },

    appendDigest(input) {
      const { session, next, summary } = input;
      const stale = Symbol();
      const result = transaction(() => {
        if (!samePosition(position(session.id), input.expected)) return stale;
        db.prepare(
          `INSERT INTO sessions (id, agent, transcript_path, position_uuid, position_ts, rejections)
           VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, transcript_path = excluded.transcript_path,
             position_uuid = excluded.position_uuid, position_ts = excluded.position_ts, rejections = 0`,
        ).run(session.id, session.agent, session.transcriptPath, next.uuid, next.timestamp);
        const now = Date.now();
        const digestId = db.prepare(
          `INSERT INTO digests (session_id, created_at, model, cost_usd, request, investigated, learned, completed, next_steps)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          session.id, now, input.model, input.costUsd, summary.request, summary.investigated,
          summary.learned, summary.completed, summary.next_steps,
        ).lastInsertRowid;
        // ON CONFLICT names the unique column so a CHECK violation still throws; OR IGNORE would swallow it.
        const insertObservation = db.prepare(
          `INSERT INTO observations (digest_id, type, title, narrative, facts, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING`,
        );
        const insertFile = db.prepare("INSERT OR IGNORE INTO observation_files (path, observation_id, kind) VALUES (?, ?, ?)");
        for (const o of input.observations) {
          const inserted = insertObservation.run(
            digestId, o.type, o.title, o.narrative, JSON.stringify(o.facts), contentHash(o.title, o.narrative), now,
          );
          if (inserted.changes === 0) continue;
          for (const file of o.filesRead) insertFile.run(file, inserted.lastInsertRowid, "read");
          for (const file of o.filesModified) insertFile.run(file, inserted.lastInsertRowid, "modified");
        }
        return "appended" as const;
      });
      return result === stale ? "stale" : result;
    },

    recordRejection(session) {
      const row = one(
        `INSERT INTO sessions (id, agent, transcript_path, rejections) VALUES (?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET rejections = rejections + 1 RETURNING rejections`,
        session.id, session.agent, session.transcriptPath,
      );
      return Number(row!.rejections);
    },

    unembedded(model, limit) {
      return all(
        `SELECT o.id, o.title, o.narrative FROM observations o WHERE ${UNEMBEDDED}
         ORDER BY o.created_at, o.id LIMIT ?`,
        model, limit,
      ).map((row) => ({ id: Number(row.id), text: `${String(row.title)}\n${String(row.narrative)}` }));
    },

    putVectors(model, rows) {
      transaction(() => {
        const put = db.prepare("INSERT OR REPLACE INTO observation_vectors (observation_id, model, vector) VALUES (?, ?, ?)");
        for (const { id, vector } of rows) {
          put.run(id, model, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
        }
      });
    },

    search(query) {
      const filters: string[] = [];
      const params: sqlite.SQLInputValue[] = [];
      if (query.type !== null) { filters.push("o.type = ?"); params.push(query.type); }
      if (query.sinceMs !== null) { filters.push("o.created_at >= ?"); params.push(query.sinceMs); }
      if (query.file !== null) {
        filters.push("o.id IN (SELECT observation_id FROM observation_files WHERE path = ?)");
        params.push(query.file);
      }
      const where = filters.map((f) => ` AND ${f}`).join("");
      const keyword = (joiner: " " | " OR "): ObservationLine[] => {
        const match = ftsQuery(query.text, joiner);
        if (!match) return [];
        return all(
          `SELECT ${LINE_COLUMNS} FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid
           WHERE observations_fts MATCH ?${where}
           ORDER BY bm25(observations_fts), o.created_at DESC, o.id DESC LIMIT ?`,
          match, ...params, LIST_DEPTH,
        ).map(toLine);
      };
      const vector = query.vector;
      if (!vector || !one("SELECT 1 FROM observation_vectors WHERE model = ? LIMIT 1", vector.model)) {
        const and = keyword(" ");
        return (and.length > 0 ? and : keyword(" OR ")).slice(0, query.limit);
      }
      const byVector = all(
        `SELECT ${LINE_COLUMNS}, v.vector FROM observation_vectors v JOIN observations o ON o.id = v.observation_id
         WHERE v.model = ?${where}`,
        vector.model, ...params,
      ).map((row) => {
        const bytes = row.vector as Uint8Array;
        const stored = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        return { line: toLine(row), score: dot(stored, vector.values) };
      }).sort((x, y) => y.score - x.score || newestFirst(x.line, y.line)).slice(0, LIST_DEPTH).map((s) => s.line);
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

    timeline(id, depth) {
      const anchor = one(`SELECT ${LINE_COLUMNS} FROM observations o WHERE o.id = ?`, id);
      if (!anchor) return null;
      const at = Number(anchor.created_at);
      const before = all(
        `SELECT ${LINE_COLUMNS} FROM observations o WHERE (o.created_at, o.id) < (?, ?) ${NEWEST_FIRST} LIMIT ?`,
        at, id, depth,
      ).reverse();
      const after = all(
        `SELECT ${LINE_COLUMNS} FROM observations o WHERE (o.created_at, o.id) > (?, ?)
         ORDER BY o.created_at, o.id LIMIT ?`,
        at, id, depth,
      );
      return [...before, anchor, ...after].map(toLine);
    },

    get(ids) {
      const found: Observation[] = [];
      for (const id of ids) {
        const row = one(
          `SELECT ${LINE_COLUMNS}, o.narrative, o.facts, d.session_id FROM observations o
           JOIN digests d ON d.id = o.digest_id WHERE o.id = ?`,
          id,
        );
        if (!row) continue;
        const files = all("SELECT path, kind FROM observation_files WHERE observation_id = ? ORDER BY path", id);
        found.push({
          ...toLine(row),
          sessionId: String(row.session_id),
          narrative: String(row.narrative),
          facts: JSON.parse(String(row.facts)) as string[],
          filesRead: files.filter((f) => f.kind === "read").map((f) => String(f.path)),
          filesModified: files.filter((f) => f.kind === "modified").map((f) => String(f.path)),
        });
      }
      return found;
    },

    recent(limit) {
      return all(`SELECT ${LINE_COLUMNS} FROM observations o ${NEWEST_FIRST} LIMIT ?`, limit).map(toLine);
    },

    latestNextSteps() {
      const row = one("SELECT next_steps FROM digests ORDER BY created_at DESC, id DESC LIMIT 1");
      if (!row) return null;
      const text = String(row.next_steps).trim();
      return text.toLowerCase().replace(/\.$/, "") === "none" ? null : text;
    },

    fileHistory(relPath, limit) {
      return all(
        `SELECT ${LINE_COLUMNS} FROM observations o
         WHERE o.id IN (SELECT observation_id FROM observation_files WHERE path = ?) ${NEWEST_FIRST} LIMIT ?`,
        relPath, limit,
      ).map(toLine);
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
      return {
        observations: Number(counts.total),
        unembedded: Number(counts.pending),
        lastDigestMs: digests.last === null ? null : Number(digests.last),
        costUsdSince: Number(digests.cost),
      };
    },

    close: () => db.close(),
  };
}

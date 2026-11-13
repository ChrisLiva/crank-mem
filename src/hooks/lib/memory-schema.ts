import type * as sqlite from "node:sqlite";

// memory.db's schema: one forward step per version, applied by `migrate`.

export const SCHEMA_VERSION = 3;

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

const SCHEMA_V3 = `
ALTER TABLE digests ADD COLUMN origin TEXT;
CREATE TABLE observation_refs (
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  project TEXT NOT NULL, path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('read','modified')),
  PRIMARY KEY (observation_id, project, path, kind)) WITHOUT ROWID;
CREATE INDEX observation_refs_project_path ON observation_refs(project, path);
CREATE TABLE project_links (project TEXT PRIMARY KEY, last_ms INTEGER NOT NULL);
`;

/** STEPS[v] migrates a store at user_version v to v + 1. */
const STEPS: readonly string[] = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3];

export function userVersion(db: sqlite.DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

/**
 * Applies the forward steps under a write lock. Returns the version it found when it
 * applied a step, null when another process had already migrated the store, and
 * "newer" when another process moved it past this version.
 */
export function migrate(db: sqlite.DatabaseSync): number | null | "newer" {
  return transaction(db, () => {
    const v = userVersion(db);
    if (v >= SCHEMA_VERSION) return v > SCHEMA_VERSION ? "newer" : null;
    for (let step = v; step < SCHEMA_VERSION; step++) db.exec(STEPS[step]!);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return v;
  });
}

export function transaction<T>(db: sqlite.DatabaseSync, fn: () => T): T {
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

// SCHEMA_V1 copied verbatim from `git show 1a8eba3:src/hooks/lib/memory.ts`: the frozen
// version-1 schema that migration tests build stores from. Data only, so importing
// it registers no tests.

export const V1_DDL = `
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

// SCHEMA_V2 copied verbatim from `git show acac493:src/hooks/lib/memory-schema.ts`: the
// frozen version-2 step that migration tests apply over `V1_DDL`. Data only, so
// importing it registers no tests.

export const V2_DDL = `
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

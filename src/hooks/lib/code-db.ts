import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { CRANK_DIR, type CrankConfig } from "./config.ts";
import { SOURCE_EXTENSIONS } from "./indexable.ts";
import { fileFacts, walkProject, type FileFacts } from "./scanner.ts";
import type { GraphStatus } from "./wire.ts";

// .crank/code.db: the project's code graph. This module owns the schema, every open and the
// file-fact refresh the hooks and the CLI share. The store is derived data: a corrupt or
// other-version file is deleted and rebuilt, never migrated.

export const CODE_DB = "code.db";
const CODE_SCHEMA_VERSION = 1;
/** Files larger than this are never parsed. */
export const PARSE_MAX_BYTES = 256 * 1024;

export type Grammar =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "cpp"
  | "bash"
  | "java"
  | "c-sharp"
  | "ruby"
  | "php"
  | "powershell";

export const GRAMMARS: Record<string, Grammar> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "cpp",
  ".h": "cpp",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".sh": "bash",
  ".bash": "bash",
  ".java": "java",
  ".cs": "c-sharp",
  ".rb": "ruby",
  ".php": "php",
  ".ps1": "powershell",
  ".psm1": "powershell",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  tokens INTEGER NOT NULL,
  description TEXT NOT NULL,
  generated INTEGER NOT NULL,
  write_count INTEGER NOT NULL DEFAULT 0,
  churn_rank INTEGER,
  parsed_size INTEGER,
  parsed_mtime_ms REAL,
  parse_error TEXT
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  parent_id INTEGER,
  qualified_name TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  tokens INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS imports (
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  PRIMARY KEY (from_path, to_path)
);
CREATE TABLE IF NOT EXISTS namespaces (
  path TEXT NOT NULL,
  namespace TEXT NOT NULL,
  role TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  caller_symbol_id INTEGER,
  callee_name TEXT NOT NULL,
  receiver TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path);
CREATE INDEX IF NOT EXISTS calls_callee_name ON calls(callee_name);
CREATE INDEX IF NOT EXISTS calls_path ON calls(path);
CREATE INDEX IF NOT EXISTS imports_to_path ON imports(to_path);
CREATE INDEX IF NOT EXISTS namespaces_path ON namespaces(path);
`;

type CodeDbStatus = "open" | "missing" | "rebuild" | "unreadable" | "readonly";

export interface CodeDbOpen {
  status: CodeDbStatus;
  /** Present when `status` is `open`; the caller closes it. */
  db?: sqlite.DatabaseSync;
  /** Why the status is `rebuild`, `unreadable` or `readonly`. */
  reason?: string;
}

const NOTADB = 26;
const CORRUPT = 11;
const CANTOPEN = 14;
const READONLY = 8;
const READONLY_DIRECTORY = 1544;
const FS_DENIED = new Set(["EACCES", "EPERM", "EROFS"]);

export function codeDbPath(root: string): string {
  return path.join(root, CRANK_DIR, CODE_DB);
}

/** The open status a failure maps to; node:sqlite errors carry only `errcode`, fs errors a `code`. */
function failure(err: unknown): CodeDbOpen {
  const { errcode, code } = err as { errcode?: unknown; code?: unknown };
  if (errcode === NOTADB || errcode === CORRUPT)
    return { status: "rebuild", reason: `errcode ${errcode}` };
  if (errcode === READONLY || errcode === READONLY_DIRECTORY)
    return { status: "readonly", reason: "SQLITE_READONLY" };
  if (errcode === CANTOPEN) return { status: "unreadable", reason: "SQLITE_CANTOPEN" };
  if (typeof code === "string" && FS_DENIED.has(code))
    return { status: "unreadable", reason: code };
  return {
    status: "unreadable",
    reason: typeof errcode === "number" ? `errcode ${errcode}` : "unknown",
  };
}

function userVersion(db: sqlite.DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/**
 * Opens `<root>/.crank/code.db`. `read` opens read-write with `query_only` and answers `missing`
 * for an absent file or one with no schema yet; `write` creates the schema of an absent file and
 * proves the file writable before it returns `open`. Either returns `rebuild` for a corrupt file
 * or another schema version and leaves the file for the caller to delete.
 */
export function openCodeDb(root: string, mode: "read" | "write", busyMs = 0): CodeDbOpen {
  const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite | undefined;
  if (!mod) return { status: "unreadable", reason: "node:sqlite" };
  const file = codeDbPath(root);
  if (mode === "read" && !fs.existsSync(file)) return { status: "missing" };
  let db: sqlite.DatabaseSync | undefined;
  try {
    db = new mod.DatabaseSync(file, { timeout: busyMs });
    const version = userVersion(db);
    if (version !== 0 && version !== CODE_SCHEMA_VERSION) {
      db.close();
      return { status: "rebuild", reason: `user_version ${version}` };
    }
    if (mode === "read") {
      if (version === 0) {
        db.close();
        return { status: "missing" };
      }
      db.exec("PRAGMA query_only=ON");
    } else if (version === 0) {
      createSchema(db);
    } else {
      // A WAL store opens read-only without complaint and fails only at a real write.
      db.exec(`PRAGMA user_version=${CODE_SCHEMA_VERSION}`);
    }
    return { status: "open", db };
  } catch (err) {
    try {
      db?.close();
    } catch {
      // The failure already says why the open failed.
    }
    return failure(err);
  }
}

/** How long a read waits on a writer (WAL recovery reports busy for a moment). */
export const GRAPH_READ_BUSY_MS = 1000;

/**
 * Runs `fn` over the project's `code.db`, opened for read and closed after. A store that is
 * missing, will not open, or throws mid-read reads as absent: `fn` gets null, so every reader
 * answers "no graph" the same way. The linked projects' stores read through here too, never for write.
 */
export function readCodeDb<T>(root: string, fn: (db: sqlite.DatabaseSync | null) => T): T {
  const opened = openCodeDb(root, "read", GRAPH_READ_BUSY_MS);
  if (opened.status !== "open" || !opened.db) return fn(null);
  try {
    return fn(opened.db);
  } catch {
    return fn(null);
  } finally {
    opened.db.close();
  }
}

function createSchema(db: sqlite.DatabaseSync): void {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (userVersion(db) === 0) {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version=${CODE_SCHEMA_VERSION}`);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Deletes the store and its WAL files; the only delete. A missing file is not an error. */
export function deleteCodeDb(root: string): void {
  const file = codeDbPath(root);
  for (const name of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(name, { force: true });
}

/** Runs `fn` in one `BEGIN IMMEDIATE` transaction, committing when it returns and rolling back when it throws. */
export function transaction<T>(db: sqlite.DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const DERIVED_TABLES: [table: string, column: string][] = [
  ["symbols", "path"],
  ["imports", "from_path"],
  ["namespaces", "path"],
  ["calls", "path"],
];

/** Deletes a path's `symbols`, `imports`, `namespaces` and `calls` rows; the caller holds the transaction. */
export function clearDerivedFacts(db: sqlite.DatabaseSync, rel: string): void {
  for (const [table, column] of DERIVED_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(rel);
  }
}

/** Deletes each path's `files` row and its `symbols`, `imports`, `namespaces` and `calls` rows; the caller holds the transaction. */
export function deletePaths(db: sqlite.DatabaseSync, paths: string[]): void {
  for (const rel of paths) clearDerivedFacts(db, rel);
  const del = db.prepare("DELETE FROM files WHERE path = ?");
  for (const rel of paths) del.run(rel);
}

/** Writes one file's facts, keeping its write count, churn rank and parse stamp; the caller holds the transaction. */
export function upsertFileFacts(db: sqlite.DatabaseSync, rel: string, facts: FileFacts): void {
  db.prepare(
    `INSERT INTO files (path, size, mtime_ms, tokens, description, generated)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
       tokens = excluded.tokens, description = excluded.description, generated = excluded.generated`,
  ).run(rel, facts.size, facts.mtimeMs, facts.tokens, facts.description, facts.generated ? 1 : 0);
}

export interface FactsRefresh {
  changed: number;
  added: number;
  removed: number;
  /** True when the deadline passed before every new or changed file was read. */
  partial: boolean;
}

/**
 * Brings the `files` rows in line with the project: rows the uncapped walk no longer lists go
 * first and unbudgeted, then each new or changed file (size or mtime differs) is read until
 * `deadlineMs`, an absolute `Date.now()` time that `Infinity` removes.
 */
export function refreshFileFacts(
  root: string,
  config: CrankConfig,
  db: sqlite.DatabaseSync,
  deadlineMs: number,
): FactsRefresh {
  const walked = walkProject(root, config);
  const known = new Map<string, { size: number; mtimeMs: number }>();
  const rows = db.prepare("SELECT path, size, mtime_ms FROM files").all() as {
    path: string;
    size: number;
    mtime_ms: number;
  }[];
  for (const row of rows) known.set(row.path, { size: row.size, mtimeMs: row.mtime_ms });
  const listed = new Set(walked);
  const gone = [...known.keys()].filter((rel) => !listed.has(rel));
  if (gone.length > 0) transaction(db, () => deletePaths(db, gone));
  const result: FactsRefresh = { changed: 0, added: 0, removed: gone.length, partial: false };
  transaction(db, () => {
    for (const rel of walked) {
      if (Date.now() >= deadlineMs) {
        result.partial = true;
        break;
      }
      refreshOne(root, rel, config, db, known.get(rel), result);
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_refresh', ?)").run(
      new Date().toISOString(),
    );
  });
  return result;
}

/** Re-reads one walked file when its size or mtime moved or it is new; a file no longer indexable loses its rows. */
function refreshOne(
  root: string,
  rel: string,
  config: CrankConfig,
  db: sqlite.DatabaseSync,
  had: { size: number; mtimeMs: number } | undefined,
  result: FactsRefresh,
): void {
  if (had) {
    try {
      const stat = fs.statSync(path.join(root, rel));
      if (stat.size === had.size && stat.mtimeMs === had.mtimeMs) return;
    } catch {
      // Unreadable now: fileFacts decides below.
    }
  }
  const facts = fileFacts(root, rel, config);
  if (facts === null) {
    if (had) {
      deletePaths(db, [rel]);
      result.removed++;
    }
    return;
  }
  upsertFileFacts(db, rel, facts);
  if (had) result.changed++;
  else result.added++;
}

export interface FileRow {
  path: string;
  description: string;
  tokens: number;
}

/**
 * The files at or under `prefix` (a posix relative path, empty for the whole project) whose path
 * is `from` or later, in SQLite's binary path order.
 */
export function filesUnder(db: sqlite.DatabaseSync, prefix: string, from = ""): FileRow[] {
  const all = prefix === "";
  return db
    .prepare(
      `SELECT path, description, tokens FROM files
       WHERE (? OR path = ? OR (path >= ? AND path < ?)) AND path >= ?
       ORDER BY path`,
    )
    .all(all ? 1 : 0, prefix, `${prefix}/`, `${prefix}0`, from) as unknown as FileRow[];
}

/** True when a grammar reads the path's extension and the file is small enough to parse. */
export function parseable(rel: string, size: number): boolean {
  const ext = path.extname(path.basename(rel)).toLowerCase();
  return Object.hasOwn(GRAMMARS, ext) && size <= PARSE_MAX_BYTES;
}

export interface PendingFile {
  path: string;
  writeCount: number;
  /** The file's place in the churn list, null outside it. */
  churnRank: number | null;
}

/** The parseable files whose size or mtime differs from their parse stamp (a null stamp differs), in `files` order. */
export function pendingFiles(db: sqlite.DatabaseSync): PendingFile[] {
  const rows = db
    .prepare(
      "SELECT path, size, mtime_ms, parsed_size, parsed_mtime_ms, write_count, churn_rank FROM files",
    )
    .all() as {
    path: string;
    size: number;
    mtime_ms: number;
    parsed_size: number | null;
    parsed_mtime_ms: number | null;
    write_count: number;
    churn_rank: number | null;
  }[];
  return rows
    .filter(
      (row) =>
        parseable(row.path, row.size) &&
        (row.parsed_size !== row.size || row.parsed_mtime_ms !== row.mtime_ms),
    )
    .map((row) => ({ path: row.path, writeCount: row.write_count, churnRank: row.churn_rank }));
}

export function pendingPaths(db: sqlite.DatabaseSync): Set<string> {
  return new Set(pendingFiles(db).map((file) => file.path));
}

export function pendingCount(db: sqlite.DatabaseSync): number {
  return pendingFiles(db).length;
}

export interface GraphCounts {
  files: number;
  pending: number;
  /** Source extensions no grammar reads, most files first, ties by extension. */
  gaps: string[];
}

/** What the session-start pointer says about the graph: file count, files awaiting a parse, and the languages with no symbol ranges. */
export function graphCounts(db: sqlite.DatabaseSync): GraphCounts {
  const rows = db.prepare("SELECT path FROM files").all() as { path: string }[];
  const byExt = new Map<string, number>();
  for (const { path: rel } of rows) {
    const ext = path.extname(path.basename(rel)).toLowerCase();
    if (SOURCE_EXTENSIONS.has(ext) && !Object.hasOwn(GRAMMARS, ext))
      byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const gaps = [...byExt].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([ext]) => ext);
  return { files: rows.length, pending: pendingCount(db), gaps };
}

export interface GraphHealth {
  status: GraphStatus;
  files: number;
  /** Parseable files, pending or not. */
  parseable: number;
  pending: number;
  /** ISO time of the last file-fact refresh, null before one. */
  lastRefresh: string | null;
}

/** What `stats` and `/health` report of the graph; a store that is not `open` reports zero counts. */
export function graphHealth(root: string): GraphHealth {
  const none = { files: 0, parseable: 0, pending: 0, lastRefresh: null };
  const opened = openCodeDb(root, "read", GRAPH_READ_BUSY_MS);
  if (opened.status !== "open" || !opened.db) {
    return { status: opened.status === "readonly" ? "unreadable" : opened.status, ...none };
  }
  try {
    const rows = opened.db.prepare("SELECT path, size FROM files").all() as {
      path: string;
      size: number;
    }[];
    const meta = opened.db.prepare("SELECT value FROM meta WHERE key = 'last_refresh'").get() as
      | { value: string }
      | undefined;
    return {
      status: "open",
      files: rows.length,
      parseable: rows.filter((r) => parseable(r.path, r.size)).length,
      pending: pendingCount(opened.db),
      lastRefresh: meta?.value ?? null,
    };
  } catch {
    return { status: "unreadable", ...none };
  } finally {
    opened.db.close();
  }
}

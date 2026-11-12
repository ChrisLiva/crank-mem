import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { fileStamp } from "./cerebrum-files.ts";

// memory.db's upkeep: the snapshot folder beside the store and its file names, the daily
// pass (snapshot, then the store's stale delete, then the trim), the snapshot before a
// migration, and saving the current store before a restore.

/** Snapshots of the store, relative to the folder that holds it. */
export const SNAPSHOT_DIR = path.join("backups", "memory");

/** How often the maintenance pass snapshots the store, and how long a stale-flagged row survives it. */
const MAINTAIN_EVERY_MS = 24 * 3_600_000;
const STALE_KEEP_MS = 90 * 24 * 3_600_000;
/** The trim removes a .tmp only past this age: a snapshot in flight in another process is younger. */
const TMP_KEEP_MS = 3_600_000;

let snapshotCount = 0;

/** Daily snapshots the maintenance pass writes and trims; the pre-migration `-v<n>.db` copies never match. */
const DAILY_SNAPSHOT = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;
const DAILY_KEEP = 7;

export function snapshotDir(storeFile: string): string {
  return path.join(path.dirname(storeFile), SNAPSHOT_DIR);
}

/** The snapshot of `storeFile` whose `.db` name sorts last, with its mtime; null when the folder is missing, unreadable or empty. */
export function latestSnapshot(storeFile: string): { file: string; atMs: number } | null {
  const dir = snapshotDir(storeFile);
  try {
    const name = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".db"))
      .sort()
      .at(-1);
    if (name === undefined) return null;
    const file = path.join(dir, name);
    return { file, atMs: fs.statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/** Writes a copy of the store to `<dir>/<name>` through a unique .tmp file; throws on failure, leaving no .tmp behind. */
function writeSnapshot(db: sqlite.DatabaseSync, dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, name);
  const tmp = `${final}.${process.pid}.${snapshotCount++}.tmp`;
  try {
    db.prepare("VACUUM INTO ?").run(tmp);
    fs.renameSync(tmp, final);
    return final;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** True for a .tmp in `dir` last written over TMP_KEEP_MS ago; false when it has vanished. */
function abandonedTmp(dir: string, name: string): boolean {
  if (!name.endsWith(".tmp")) return false;
  try {
    return Date.now() - fs.statSync(path.join(dir, name)).mtimeMs > TMP_KEEP_MS;
  } catch {
    return false;
  }
}

/**
 * The daily pass. Null when the newest `.db` snapshot is no more than MAINTAIN_EVERY_MS old at nowMs.
 * Otherwise: writes `<fileStamp>.db`, calls deleteStale(nowMs - STALE_KEEP_MS), trims daily names
 * to DAILY_KEEP and removes every .tmp older than an hour. Throws, before deleteStale, when the snapshot fails.
 * `nowMs` sets only the due comparison and the stale cutoff: the snapshot's name is `fileStamp()`
 * and its mtime the real write time.
 */
export function dailyUpkeep(
  db: sqlite.DatabaseSync,
  storeFile: string,
  nowMs: number,
  deleteStale: (cutoffMs: number) => number,
): { snapshot: string; deleted: number } | null {
  const latest = latestSnapshot(storeFile);
  if (latest !== null && nowMs - latest.atMs <= MAINTAIN_EVERY_MS) return null;
  const dir = snapshotDir(storeFile);
  const snapshot = writeSnapshot(db, dir, `${fileStamp()}.db`);
  const deleted = deleteStale(nowMs - STALE_KEEP_MS);
  const names = fs.readdirSync(dir);
  const daily = names.filter((n) => DAILY_SNAPSHOT.test(n)).sort();
  for (const n of [...daily.slice(0, -DAILY_KEEP), ...names.filter((n) => abandonedTmp(dir, n))]) {
    fs.rmSync(path.join(dir, n), { force: true });
  }
  return { snapshot, deleted };
}

/** Writes `<fileStamp>-v<version>.db`; throws on failure, leaving no .tmp. */
export function snapshotBeforeMigration(
  db: sqlite.DatabaseSync,
  storeFile: string,
  version: number,
): void {
  writeSnapshot(db, snapshotDir(storeFile), `${fileStamp()}-v${version}.db`);
}

/** SQLITE_NOTADB (26) or SQLITE_CORRUPT (11), extended codes included: the store is damaged, not busy or unwritable. */
function isDamaged(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && [26, 11].includes(code & 0xff);
}

/**
 * Before a restore: saves the store as a daily-named snapshot, or, when it is damaged
 * (SQLITE_NOTADB / SQLITE_CORRUPT), moves it and its -wal/-shm to `<stamp>.damaged*`.
 * Null when no store exists. Throws any other failure.
 */
export function saveCurrentStore(mod: typeof sqlite, storeFile: string): string | null {
  if (!fs.existsSync(storeFile)) return null;
  const dir = snapshotDir(storeFile);
  const stamp = fileStamp();
  // Read-write, as openForRead explains.
  const current = new mod.DatabaseSync(storeFile);
  try {
    return writeSnapshot(current, dir, `${stamp}.db`);
  } catch (err) {
    if (!isDamaged(err)) throw err;
  } finally {
    current.close();
  }
  const savedAs = path.join(dir, `${stamp}.damaged`);
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(storeFile, savedAs);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(storeFile + suffix)) fs.renameSync(storeFile + suffix, savedAs + suffix);
  }
  return savedAs;
}

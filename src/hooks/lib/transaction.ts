import type * as sqlite from "node:sqlite";

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

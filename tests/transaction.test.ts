import { describe, expect, test } from "bun:test";
import type * as sqlite from "node:sqlite";
import { transaction } from "../src/hooks/lib/transaction.ts";

function openDb(): sqlite.DatabaseSync {
  const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite;
  const db = new mod.DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (v TEXT)");
  return db;
}

function rows(db: sqlite.DatabaseSync): number {
  return Number((db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n);
}

describe("transaction", () => {
  test("rethrows the original error when fn already ended the transaction", () => {
    const db = openDb();
    const run = () =>
      transaction(db, () => {
        db.exec("ROLLBACK");
        throw new Error("marker");
      });
    expect(run).toThrow("marker");
    db.close();
  });

  test("commits when fn returns", () => {
    const db = openDb();
    const result = transaction(db, () => {
      db.exec("INSERT INTO t VALUES ('a')");
      return 7;
    });
    expect(result).toBe(7);
    expect(rows(db)).toBe(1);
    db.close();
  });

  test("leaves no row when fn throws", () => {
    const db = openDb();
    expect(() =>
      transaction(db, () => {
        db.exec("INSERT INTO t VALUES ('a')");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(rows(db)).toBe(0);
    db.close();
  });
});

import { describe, expect, test } from "bun:test";
import type * as sqlite from "node:sqlite";
import { transaction } from "../src/hooks/lib/transaction.ts";

describe("transaction", () => {
  test("rethrows the original error when fn already ended the transaction", () => {
    const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite;
    const db = new mod.DatabaseSync(":memory:");
    const run = () =>
      transaction(db, () => {
        db.exec("ROLLBACK");
        throw new Error("marker");
      });
    expect(run).toThrow("marker");
    db.close();
  });
});

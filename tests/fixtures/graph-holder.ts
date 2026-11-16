// Holds a write lock on a project's code.db so a hook has to wait on it. It spins, like
// usage-writer.ts, so a test can start it, wait for the ready file and race a hook against it.
// argv: <project root> <hold time, ms> <ready file>

import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";

const [root, holdMs, ready] = process.argv.slice(2);
const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite;
const db = new mod.DatabaseSync(path.join(root!, ".crank/code.db"));
db.exec("BEGIN IMMEDIATE");
fs.writeFileSync(ready!, "");
const until = Date.now() + Number(holdMs);
while (Date.now() < until) {}
db.exec("ROLLBACK");
db.close();

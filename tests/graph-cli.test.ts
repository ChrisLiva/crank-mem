import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { makeCrankProject, runCli, tempDir, type CliRun } from "./helpers.ts";

const MORE = /^… (\d+) more files from (\S+): crank-mem anatomy --from (\S+)$/;

/** The paths an anatomy page lists, in printed order. */
function pagePaths(run: CliRun): string[] {
  return [...run.stdout.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!);
}

/** code.db and the WAL files that may sit beside it. */
function codeDbFiles(root: string): string[] {
  return ["code.db", "code.db-wal", "code.db-shm"]
    .map((name) => path.join(root, ".crank", name))
    .filter((file) => fs.existsSync(file));
}

describe("anatomy", () => {
  test("pages through every indexable file once, in path order, and lists no filtered file", () => {
    const files: Record<string, string> = {};
    const expected: string[] = [];
    for (let n = 0; n <= 500; n++) {
      // Mixed case: binary order and locale order disagree on it.
      const rel = `src/dir/${(n % 2 ? "X" : "x").repeat(60)}${n}.ts`;
      files[rel] = `export const v${n} = ${n};\n`;
      expected.push(rel);
    }
    files[".env"] = "TOKEN=secret\n";
    files["dist/out.ts"] = "export const out = 1;\n";
    files[".hidden/a.ts"] = "export const h = 1;\n";
    files["logo.png"] = "png";
    files["nul.ts"] = "export const a = 1;\0export const b = 2;\n";
    files["package-lock.json"] = "{}";
    files["huge.txt"] = "x".repeat(1024 * 1024 + 1);
    const root = makeCrankProject(files);

    const seen: string[] = [];
    let args = ["anatomy"];
    let startsAt: string | undefined;
    let pages = 0;
    for (;;) {
      const run = runCli(root, args);
      expect(run.status).toBe(0);
      expect(run.stdout.length).toBeLessThanOrEqual(25_000);
      const listed = pagePaths(run);
      if (startsAt !== undefined) expect(listed[0]).toBe(startsAt);
      seen.push(...listed);
      pages++;
      const more = MORE.exec(run.stdout.trimEnd().split("\n").at(-1)!);
      if (!more) break;
      expect(Number(more[1])).toBe(expected.length - seen.length);
      expect(more[3]).toBe(more[2]!);
      startsAt = more[2]!;
      args = ["anatomy", "--from", startsAt];
    }

    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual([...expected].sort());
    expect(new Set(seen).size).toBe(501);
  });

  test("a deleted file disappears on the next run", () => {
    const root = makeCrankProject({
      "a.ts": "export const a = 1;\n",
      "b.ts": "export const b = 1;\n",
    });
    expect(pagePaths(runCli(root, ["anatomy"]))).toEqual(["a.ts", "b.ts"]);
    fs.rmSync(path.join(root, "b.ts"));
    expect(pagePaths(runCli(root, ["anatomy"]))).toEqual(["a.ts"]);
  });

  describe("a store it cannot use", () => {
    const sqliteModule = () => process.getBuiltinModule("node:sqlite") as typeof sqlite;
    const project = () => makeCrankProject({ "a.ts": "export const a = 1;\n" });

    test("a store at another schema version is rebuilt and the command answers", () => {
      const root = project();
      const file = path.join(root, ".crank/code.db");
      const db = new (sqliteModule().DatabaseSync)(file);
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE files (x); PRAGMA user_version = 99");
      db.close();
      const run = runCli(root, ["anatomy"]);
      expect(run.status).toBe(0);
      expect(pagePaths(run)).toEqual(["a.ts"]);
      expect(pagePaths(runCli(root, ["anatomy"]))).toEqual(["a.ts"]);
    });

    test("a garbage store is rebuilt and the command answers", () => {
      const root = project();
      fs.writeFileSync(path.join(root, ".crank/code.db"), "this is not a database\n".repeat(200));
      const run = runCli(root, ["anatomy"]);
      expect(run.status).toBe(0);
      expect(pagePaths(run)).toEqual(["a.ts"]);
    });

    test("an unreadable store exits 1 with the fix, and a read-only one answers without refreshing", () => {
      const root = project();
      expect(runCli(root, ["anatomy"]).status).toBe(0);
      const bytes = fs.readFileSync(path.join(root, ".crank/code.db"));
      const restore = () => {
        for (const file of codeDbFiles(root)) fs.chmodSync(file, 0o644);
      };
      try {
        for (const file of codeDbFiles(root)) fs.chmodSync(file, 0o000);
        const refused = runCli(root, ["anatomy"]);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("is not readable (SQLITE_CANTOPEN). Fix: crank-mem scan");
        expect(refused.stdout).toBe("");

        restore();
        fs.writeFileSync(path.join(root, "b.ts"), "export const b = 1;\n");
        for (const file of codeDbFiles(root)) fs.chmodSync(file, 0o444);
        const answered = runCli(root, ["anatomy"]);
        expect(answered.status).toBe(0);
        expect(pagePaths(answered)).toEqual(["a.ts"]);
      } finally {
        restore();
      }
      expect(fs.readFileSync(path.join(root, ".crank/code.db")).equals(bytes)).toBe(true);
      expect(pagePaths(runCli(root, ["anatomy"]))).toEqual(["a.ts", "b.ts"]);
    });
  });

  test("a sensitive path and a path outside every project are refused", () => {
    const root = makeCrankProject({ ".env": "TOKEN=secret\n", "a.ts": "export const a = 1;\n" });
    const sensitive = runCli(root, ["anatomy", ".env"]);
    expect(sensitive.status).toBe(1);
    expect(sensitive.stderr).toContain("is a sensitive file; crank-mem does not read it.");
    expect(sensitive.stdout).toBe("");
    const outside = runCli(root, ["anatomy", tempDir("crank-outside-")]);
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain("is outside every installed project.");
  });

  test("only a parseable file is marked pending, and the count ends the listing", () => {
    const root = makeCrankProject({
      "a.ts": "export const a = 1;\n",
      "notes.md": "# Notes\n",
      "big.ts": "// " + "x".repeat(300 * 1024) + "\n",
    });
    const run = runCli(root, ["anatomy"]);
    expect(run.status).toBe(0);
    const lines = run.stdout.trimEnd().split("\n");
    const marked = lines.filter((line) => line.includes("(symbols pending)"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("`a.ts`");
    expect(lines.at(-1)).toBe("(1 file(s) still pending parse)");
  });
});

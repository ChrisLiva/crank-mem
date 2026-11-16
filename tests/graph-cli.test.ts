import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { spawnSync } from "node:child_process";
import { refreshGraph } from "../src/cli/code-parse.ts";
import { loadConfig } from "../src/hooks/lib/config.ts";
import {
  childEnv,
  makeCrankProject,
  REPO_ROOT,
  runCli,
  setMtime,
  tempDir,
  type CliRun,
} from "./helpers.ts";

const MORE = /^… (\d+) more files from (\S+): crank-mem anatomy --from (\S+)$/;

/** The paths an anatomy page lists, in printed order. */
function pagePaths(run: CliRun): string[] {
  return [...run.stdout.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!);
}

/** An anatomy page's entries by path, each the entry line with its symbol lines. */
function blocks(stdout: string): Map<string, string> {
  const entries = new Map<string, string>();
  let current: string | null = null;
  for (const line of stdout.split("\n")) {
    const head = /^- `([^`]+)`/.exec(line);
    if (head) {
      current = head[1]!;
      entries.set(current, line);
    } else if (current !== null && line.startsWith("  - ")) {
      entries.set(current, `${entries.get(current)}\n${line}`);
    }
  }
  return entries;
}

/** Every page of `anatomy`, following its `--from` lines, with the last line of the last page. */
function allPages(root: string): {
  entries: Map<string, string>;
  last: string;
  /** The line directly above each page's `… more` line. */
  aboveMore: string[];
} {
  const entries = new Map<string, string>();
  const aboveMore: string[] = [];
  let args = ["anatomy"];
  for (;;) {
    const run = runCli(root, args);
    expect(run.status).toBe(0);
    for (const [rel, block] of blocks(run.stdout)) entries.set(rel, block);
    const last = run.stdout.trimEnd().split("\n").at(-1)!;
    const more = MORE.exec(last);
    if (!more) return { entries, last, aboveMore };
    aboveMore.push(run.stdout.trimEnd().split("\n").at(-2)!);
    args = ["anatomy", "--from", more[2]!];
  }
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

  test("a parsed file lists its top-level symbols; a file over 256 KiB or without a grammar lists none and is never pending", () => {
    const root = makeCrankProject({
      "src/a.ts":
        "export function alpha() {\n  return 1;\n}\nexport class Beta {\n  gamma() {}\n}\nexport const delta = () => 2;\n",
      "notes.md": "# Notes\n",
      "big.ts": "// " + "x".repeat(300 * 1024) + "\nexport function huge() {}\n",
    });
    const run = runCli(root, ["anatomy"]);
    expect(run.status).toBe(0);
    const entries = blocks(run.stdout);
    expect([...entries.keys()]).toEqual(["big.ts", "notes.md", "src/a.ts"]);
    expect(entries.get("src/a.ts")).toMatch(/^  - alpha \(fn, L1–L3, ~\d+ tok\)$/m);
    expect(entries.get("src/a.ts")).toMatch(/^  - Beta \(class, L4–L6, ~\d+ tok\)$/m);
    expect(entries.get("src/a.ts")).not.toContain("gamma");
    expect(entries.get("big.ts")).not.toContain("  - ");
    expect(entries.get("notes.md")).not.toContain("  - ");
    expect(run.stdout).not.toContain("pending");
  });

  test("a changed file is parsed again", () => {
    const root = makeCrankProject({ "a.ts": "export function one() {}\n" });
    expect(blocks(runCli(root, ["anatomy"]).stdout).get("a.ts")).toContain("  - one (");

    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "export function one() {}\nexport function two() {}\n");
    setMtime(file, Date.now() + 5000);
    const again = blocks(runCli(root, ["anatomy"]).stdout).get("a.ts")!;
    expect(again).toContain("  - one (");
    expect(again).toContain("  - two (");
  });

  test("a file that changes after its text is read stays pending until the next run", async () => {
    const root = makeCrankProject({ "b.ts": "export function first() {}\n" });
    const file = path.join(root, "b.ts");
    const refreshed = await refreshGraph(root, loadConfig(path.join(root, ".crank")), {
      deadlineMs: Infinity,
      afterRead(rel) {
        if (rel !== "b.ts") return;
        fs.writeFileSync(file, "export function first() {}\nexport function late() {}\n");
        setMtime(file, Date.now() + 1000);
      },
    });
    expect(refreshed.status).toBe("open");

    // The rows are still the parse of the text that was read.
    const restore = () => {
      for (const f of codeDbFiles(root)) fs.chmodSync(f, 0o644);
    };
    try {
      for (const f of codeDbFiles(root)) fs.chmodSync(f, 0o444);
      const stale = runCli(root, ["anatomy"]);
      expect(stale.status).toBe(0);
      expect(stale.stdout).toContain("  - first (");
      expect(stale.stdout).not.toContain("late");
    } finally {
      restore();
    }
    expect(runCli(root, ["anatomy"]).stdout).toContain("  - late (");
  });

  test("a parse killed mid-run leaves every file whole or pending", () => {
    const files: Record<string, string> = {};
    for (let n = 0; n < 2000; n++) {
      files[`src/m${n % 20}/f${n}.ts`] =
        `export function a${n}() {\n  return b${n}();\n}\nexport function b${n}() {\n  return ${n};\n}\nexport class C${n} {}\n`;
    }
    const root = makeCrankProject(files);
    const killer = path.join(REPO_ROOT, "tests/fixtures/graph-killer.ts");
    const killed = spawnSync(process.execPath, [killer, root, "500"], {
      encoding: "utf-8",
      timeout: 60_000,
      env: childEnv(),
    });
    expect(killed.signal).toBe("SIGKILL");

    // Read what the kill left before any refresh can repair it.
    const restore = () => {
      for (const f of codeDbFiles(root)) fs.chmodSync(f, 0o644);
    };
    let left: Map<string, string>;
    let leftEnd: string;
    let leftAbove: string[];
    try {
      for (const f of codeDbFiles(root)) fs.chmodSync(f, 0o444);
      ({ entries: left, last: leftEnd, aboveMore: leftAbove } = allPages(root));
    } finally {
      restore();
    }
    const pendingTotal = Number(/^\((\d+) file\(s\) still pending parse\)$/.exec(leftEnd)?.[1]);
    const marked = [...left.values()].filter((b) =>
      b.split("\n")[0]!.endsWith("(symbols pending)"),
    );
    expect(pendingTotal).toBeGreaterThan(0);
    expect(marked).toHaveLength(pendingTotal);
    // Every capped page reports the pending count directly above its `… more` line.
    expect(leftAbove.length).toBeGreaterThan(0);
    for (const line of leftAbove) expect(line).toBe(leftEnd);
    expect(left.size).toBe(2000);
    expect(left.size - marked.length).toBeGreaterThanOrEqual(500);

    const fresh = allPages(makeCrankProject(files));
    expect(fresh.last).not.toContain("pending");
    for (const [rel, block] of left) {
      if (!block.split("\n")[0]!.endsWith("(symbols pending)"))
        expect(block).toBe(fresh.entries.get(rel)!);
    }

    expect(allPages(root).last).not.toContain("pending");
  }, 120_000);
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { spawnSync } from "node:child_process";
import { openCodeDb, refreshFileFacts } from "../src/hooks/lib/code-db.ts";
import { loadConfig } from "../src/hooks/lib/config.ts";
import {
  childEnv,
  git,
  gitCommit,
  graphProject,
  makeCrankProject,
  REPO_ROOT,
  runCli,
  runHook,
  setMtime,
  tempDir,
  withReadOnlyCodeDb,
  type CliRun,
} from "./helpers.ts";
import { claudePostEdit, claudePostWrite, claudeSessionStart } from "./fixtures/payloads.ts";

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

  test("Most active files lists written files, then the churn list, and a committed file stops counting as written", () => {
    const root = makeCrankProject({
      "a.ts": "export const a = 1;\n",
      "b.ts": "export const b = 1;\n",
    });
    git(root, "init", "-q");
    gitCommit(root, "one");
    for (const n of [2, 3]) {
      fs.writeFileSync(path.join(root, "b.ts"), `export const b = ${n};\n`);
      gitCommit(root, `b ${n}`);
    }
    const hook = (script: string, payload: object) =>
      expect(runHook(script, JSON.stringify(payload)).status).toBe(0);
    const active = () =>
      withReadOnlyCodeDb(root, () => {
        const run = runCli(root, ["anatomy"]);
        expect(run.status).toBe(0);
        return run.stdout;
      });
    const section = (stdout: string) =>
      [...stdout.split("## All files")[0]!.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!);
    hook("src/hooks/session-start.ts", claudeSessionStart(root));
    expect(active().startsWith("## Most active files\n\n")).toBe(true);
    expect(section(active())).toEqual(["b.ts", "a.ts"]);

    fs.writeFileSync(path.join(root, "c.ts"), "export const c = 1;\n");
    hook("src/hooks/post-write.ts", claudePostWrite(root, path.join(root, "c.ts")));
    expect(section(active())).toEqual(["c.ts", "b.ts", "a.ts"]);
    // A continuation page repeats no section.
    const next = runCli(root, ["anatomy", "--from", "b.ts"]);
    expect(next.stdout).not.toContain("## Most active files");
    // That run was writable and parsed every file; a parse keeps each file's write count and churn rank.
    expect(section(active())).toEqual(["c.ts", "b.ts", "a.ts"]);

    gitCommit(root, "c");
    hook("src/hooks/session-start.ts", claudeSessionStart(root));
    expect(section(active())).toEqual(["b.ts", "a.ts", "c.ts"]);

    // A later write to a churned file adds no pin.
    fs.appendFileSync(path.join(root, "c.ts"), "export const c2 = 2;\n");
    hook("src/hooks/post-write.ts", claudePostEdit(root, path.join(root, "c.ts")));
    expect(section(active())).toEqual(["b.ts", "a.ts", "c.ts"]);
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

  test("a parsed file lists its top-level symbols; a file over 256 KiB or without a grammar lists none and is never pending", () => {
    const root = makeCrankProject({
      "src/a.ts":
        "export function alpha() {\n  return 1;\n}\nexport class Beta {\n  gamma() {}\n}\nexport const delta = () => 2;\n",
      "src/c.ts": '// Calls alpha\nimport { alpha } from "./a";\nexport const c = alpha();\n',
      "empty.ts": "",
      "notes.md": "# Notes\n",
      "big.ts": "// " + "x".repeat(300 * 1024) + "\nexport function huge() {}\n",
    });
    const run = runCli(root, ["anatomy"]);
    expect(run.status).toBe(0);
    const entries = blocks(run.stdout);
    expect([...entries.keys()]).toEqual(["big.ts", "empty.ts", "notes.md", "src/a.ts", "src/c.ts"]);
    // An entry is the path, its description and its token estimate, and never the file's imports.
    const entryLine = (rel: string) => entries.get(rel)!.split("\n")[0];
    expect(entryLine("src/c.ts")).toMatch(/^- `src\/c\.ts` — Calls alpha \(~\d+ tok\)$/);
    expect(entryLine("empty.ts")).toMatch(/^- `empty\.ts` \(~\d+ tok\)$/);
    expect(entries.get("src/c.ts")).not.toMatch(/\.\/a|src\/a\.ts|import/);
    expect(entries.get("src/a.ts")).toMatch(/^  - alpha \(fn, L1–L3, ~\d+ tok\)$/m);
    expect(entries.get("src/a.ts")).toMatch(/^  - Beta \(class, L4–L6, ~\d+ tok\)$/m);
    expect(entries.get("src/a.ts")).not.toContain("gamma");
    expect(entries.get("big.ts")).not.toContain("  - ");
    expect(entries.get("notes.md")).not.toContain("  - ");
    expect(run.stdout).not.toContain("pending");
  });

  test("a changed file is parsed again", () => {
    const root = makeCrankProject({
      "a.ts": "export function one() {}\n",
      "b.ts": "export const b = 1;\n",
    });
    expect(blocks(runCli(root, ["anatomy"]).stdout).get("a.ts")).toContain("  - one (");

    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "export function one() {}\nexport function two() {}\n");
    setMtime(file, Date.now() + 5000);
    const again = blocks(runCli(root, ["anatomy"]).stdout).get("a.ts")!;
    expect(again).toContain("  - one (");
    expect(again).toContain("  - two (");

    fs.rmSync(path.join(root, "b.ts"));
    expect(pagePaths(runCli(root, ["anatomy"]))).toEqual(["a.ts"]);
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

/** The sites a `callers` or `callees` answer lists, as `<file>:<line> <label>` with ` (inferred)` where marked, split at the no-single-definition heading. */
function listed(stdout: string): { resolved: string[]; unresolved: string[] } {
  const [before = "", after = ""] = stdout.split(/^.*no single definition:\n/m);
  const parse = (text: string) => {
    const out: string[] = [];
    let group = "";
    for (const line of text.split("\n")) {
      const row = /^\s*(\d+)│(\S+)\s+.*?( \(inferred\))?$/.exec(line);
      if (row) out.push(`${group}:${row[1]} ${row[2]}${row[3] ?? ""}`);
      else if (!line.includes("│")) group = line;
    }
    return out;
  };
  return { resolved: parse(before), unresolved: parse(after) };
}

describe("callers and callees", () => {
  const callers = (root: string, ...args: string[]) => runCli(root, ["callers", ...args]);

  test("a call resolves to the same file first, then to what the caller imports, and a deleted caller drops out", () => {
    const root = makeCrankProject({
      "src/util.ts": "export function helper() {}\nexport function shared() {}\n",
      "src/a.ts": [
        'import { helper } from "./util";',
        "function shared() {}",
        "export function one() {",
        "  shared();",
        "  helper();",
        "}",
        "export class Box {",
        "  run() {",
        "    this.step();",
        "  }",
        "  step() {}",
        "}",
        "",
      ].join("\n"),
      "src/b.ts": 'import { helper } from "./util";\nexport function two() {\n  helper();\n}\n',
    });
    // Both files define `shared`; the call in a.ts reaches its own.
    expect(listed(callers(root, "src/a.ts", "shared").stdout)).toEqual({
      resolved: ["src/a.ts:4 one"],
      unresolved: [],
    });
    expect(listed(callers(root, "src/util.ts", "shared").stdout).resolved).toEqual([]);
    expect(listed(callers(root, "Box.step").stdout).resolved).toEqual(["src/a.ts:9 Box.run"]);
    expect(listed(callers(root, "helper").stdout).resolved).toEqual([
      "src/a.ts:5 one",
      "src/b.ts:3 two",
    ]);

    fs.rmSync(path.join(root, "src/b.ts"));
    const after = callers(root, "helper");
    expect(listed(after.stdout).resolved).toEqual(["src/a.ts:5 one"]);
    expect(after.stdout).toContain("1 call sites in 1 files.");
  });

  test("a name defined in two imported files, or called on an object, resolves only when one candidate remains", () => {
    const root = makeCrankProject({
      "src/p.ts": "export function dup() {}\n",
      "src/q.ts": "export function dup() {}\n",
      "src/c.ts":
        'import { dup } from "./p";\nimport "./q";\nexport function use() {\n  dup();\n}\n',
      "src/one.ts": "export class One {\n  go() {}\n}\n",
      "src/two.ts": "export class Two {\n  go() {}\n}\n",
      "src/e1.ts": 'import { One } from "./one";\nexport function e1(o: One) {\n  o.go();\n}\n',
      "src/e2.ts":
        'import { One } from "./one";\nimport { Two } from "./two";\nexport function e2(o: One) {\n  o.go();\n}\n',
    });
    for (const file of ["src/p.ts", "src/q.ts"]) {
      expect(listed(callers(root, file, "dup").stdout)).toEqual({
        resolved: [],
        unresolved: ["src/c.ts:4 use"],
      });
    }
    expect(callers(root, "src/p.ts", "dup").stdout).toContain(
      "Call sites named dup with no single definition:",
    );
    expect(listed(callers(root, "One.go").stdout)).toEqual({
      resolved: ["src/e1.ts:3 e1 (inferred)"],
      unresolved: ["src/e2.ts:4 e2"],
    });
  });

  test("Java resolves a name unique in the project but never to a test file; C# also needs a shared namespace", () => {
    const root = makeCrankProject({
      "src/main/Svc.java": "class Svc {\n  void persist() {}\n}\n",
      "src/test/java/SvcTest.java": "class SvcTest {\n  void persist() {}\n}\n",
      "src/main/App.java": "class App {\n  void go(Svc svc) {\n    svc.persist();\n  }\n}\n",
      "src/Models/Repo.cs":
        "namespace Acme.Data {\n  class Repo {\n    public void Persist() {}\n  }\n}\n",
      "src/Models/Thing.cs":
        "namespace Other.Place {\n  class Thing {\n    public void Persist() {}\n  }\n}\n",
      "src/App/Runner.cs":
        "using Acme.Data;\nnamespace Tool {\n  class Runner {\n    void Go(Repo r) {\n      r.Persist();\n    }\n  }\n}\n",
    });
    expect(listed(callers(root, "src/main/Svc.java", "persist").stdout).resolved).toEqual([
      "src/main/App.java:3 App.go (inferred)",
    ]);
    expect(listed(callers(root, "src/test/java/SvcTest.java", "persist").stdout).resolved).toEqual(
      [],
    );
    expect(listed(callers(root, "src/Models/Repo.cs", "Persist").stdout).resolved).toEqual([
      "src/App/Runner.cs:5 Tool.Runner.Go (inferred)",
    ]);
    expect(listed(callers(root, "src/Models/Thing.cs", "Persist").stdout).resolved).toEqual([]);
  });

  test("two files that each define a name give each importer its own", () => {
    const root = makeCrankProject({
      "src/a.ts": "export function save() {}\n",
      "src/b.ts": "export function save() {}\n",
      "src/ua.ts": 'import { save } from "./a";\nexport function useA() {\n  save();\n}\n',
      "src/ub.ts": 'import { save } from "./b";\nexport function useB() {\n  save();\n}\n',
    });
    const a = callers(root, "src/a.ts", "save");
    expect(listed(a.stdout)).toEqual({ resolved: ["src/ua.ts:3 useA"], unresolved: [] });
    expect(a.stdout).not.toContain("src/ub.ts");
  });

  test("an ambiguous name is refused with pasteable candidates, a miss offers close names, and every spelling of one symbol answers alike", () => {
    const twice = makeCrankProject({
      "src/a.ts": "export function save() {}\n",
      "src/b.ts": "export function save() {}\n",
    });
    const ambiguous = callers(twice, "save");
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stdout).toBe("");
    expect(ambiguous.stderr).toContain("crank-mem: save names 2 symbols.");
    expect(ambiguous.stderr).toContain("Close: src/a.ts save, src/b.ts save");
    expect(callers(twice, "src/a.ts", "save").status).toBe(0);

    const root = makeCrankProject({
      "src/box.ts": "export class Box {\n  save() {}\n}\n",
      "src/put.ts": 'import { Box } from "./box";\nexport function put(b: Box) {\n  b.save();\n}\n',
    });
    const byQualified = callers(root, "Box.save");
    expect(byQualified.status).toBe(0);
    expect(listed(byQualified.stdout).resolved).toEqual(["src/put.ts:3 put (inferred)"]);
    expect(callers(root, "src/box.ts", "save").stdout).toBe(byQualified.stdout);
    expect(callers(root, "save").stdout).toBe(byQualified.stdout);

    const miss = callers(root, "ox.sa");
    expect(miss.status).toBe(1);
    expect(miss.stdout).toBe("");
    expect(miss.stderr).toContain("crank-mem: no symbol ox.sa.");
    expect(miss.stderr).toContain("Close: src/box.ts Box.save");
    const none = callers(root, "nosuch");
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("crank-mem: no symbol nosuch.");
    expect(none.stderr).not.toContain("Close:");
  });

  describe("the printed layout", () => {
    const files = {
      "src/lib/memory.ts": [
        "export function readStoreSync(root: string, fn: (m: string) => string): string {",
        "  return fn(root);",
        "}",
        "export function storeStatus(root: string): string {",
        "  return readStoreSync(root, (memory) => memory);",
        "}",
        "",
      ].join("\n"),
      "src/lib/format.ts": "export function pretty(text: string): string {\n  return text;\n}\n",
      "src/cli/stats.ts": [
        'import { readStoreSync } from "../lib/memory.ts";',
        'import { pretty } from "../lib/format.ts";',
        "",
        "export function captureSummary(root: string): string {",
        "  const read = readStoreSync(root, (m) => m);",
        "  const shown = pretty(read);",
        "  return external(shown);",
        "}",
        "",
      ].join("\n"),
      "src/lib/citations.ts": [
        'import { readStoreSync } from "./memory.ts";',
        "export function storeLinks(root: string): string {",
        "  const links = readStoreSync(root, (m) => m);",
        "  return links;",
        "}",
        "",
      ].join("\n"),
      "src/lib/injection.ts": [
        'import { readStoreSync } from "./memory.ts";',
        "export function readRecall(root: string): string {",
        "  return readStoreSync(root, (memory) => memory);",
        "}",
        "",
      ].join("\n"),
    };

    test("callers groups the sites by file with a gutter, padded labels and the follow-up commands", () => {
      const run = callers(makeCrankProject(files), "readStoreSync");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(
        [
          "readStoreSync  src/lib/memory.ts:1-3  fn",
          "src/cli/stats.ts",
          "     5│captureSummary  const read = readStoreSync(root, (m) => m);",
          "src/lib/citations.ts",
          "     3│storeLinks      const links = readStoreSync(root, (m) => m);",
          "src/lib/injection.ts",
          "     3│readRecall      return readStoreSync(root, (memory) => memory);",
          "src/lib/memory.ts",
          "     5│storeStatus     return readStoreSync(root, (memory) => memory);",
          "4 call sites in 4 files.",
          "Open one: crank-mem unfold src/cli/stats.ts captureSummary",
          "Wider: crank-mem impact readStoreSync",
          "",
        ].join("\n"),
      );
    });

    test("callees groups the calls by the file defining each callee and lists the unresolved ones apart", () => {
      const run = runCli(makeCrankProject(files), ["callees", "captureSummary"]);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(
        [
          "captureSummary  src/cli/stats.ts:4-8  fn",
          "src/lib/format.ts",
          "     6│pretty         const shown = pretty(read);",
          "src/lib/memory.ts",
          "     5│readStoreSync  const read = readStoreSync(root, (m) => m);",
          "2 call sites in 2 files.",
          "Calls with no single definition:",
          "     7│external       return external(shown);",
          "Open one: crank-mem unfold src/lib/format.ts pretty",
          "Wider: crank-mem callers captureSummary",
          "",
        ].join("\n"),
      );
    });
  });

  test("a sensitive file and a path outside every project are refused", () => {
    const root = makeCrankProject({ ".env": "TOKEN=secret\n", "a.ts": "export const a = 1;\n" });
    const anatomySensitive = runCli(root, ["anatomy", ".env"]);
    expect(anatomySensitive.status).toBe(1);
    expect(anatomySensitive.stderr).toContain("is a sensitive file; crank-mem does not read it.");
    expect(anatomySensitive.stdout).toBe("");
    const anatomyOutside = runCli(root, ["anatomy", tempDir("crank-outside-")]);
    expect(anatomyOutside.status).toBe(1);
    expect(anatomyOutside.stderr).toContain("is outside every installed project.");
    for (const command of ["callers", "callees", "impact"]) {
      const sensitive = runCli(root, [command, ".env", "a"]);
      expect(sensitive.status).toBe(1);
      expect(sensitive.stderr).toContain("is a sensitive file; crank-mem does not read it.");
      expect(sensitive.stdout).toBe("");
      const outside = runCli(root, [command, tempDir("crank-outside-"), "a"]);
      expect(outside.status).toBe(1);
      expect(outside.stderr).toContain("is outside every installed project.");
    }
    const lone = runCli(root, ["impact", ".env"]);
    expect(lone.status).toBe(1);
    expect(lone.stderr).toContain(
      "crank-mem: .env is a sensitive file; crank-mem does not read it.",
    );
    expect(lone.stdout).toBe("");
    const stray = path.join(tempDir("crank-outside-"), "x.ts");
    fs.writeFileSync(stray, "export const x = 1;\n");
    const strayRun = runCli(root, ["impact", stray]);
    expect(strayRun.status).toBe(1);
    expect(strayRun.stderr).toContain("is outside every installed project.");
  });

  test("a path in another installed project answers from that project's store", () => {
    const payments = makeCrankProject({
      "src/p.ts": "export function pay() {}\n",
      "src/u.ts": 'import { pay } from "./p";\nexport function checkout() {\n  pay();\n}\n',
    });
    const home = makeCrankProject({ "src/h.ts": "export const h = 1;\n" });
    const file = path.join(payments, "src/p.ts");
    expect(listed(callers(home, file, "pay").stdout).resolved).toEqual(["src/u.ts:3 checkout"]);
    const run = runCli(home, ["impact", file, "pay"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("└─ checkout");
    expect(run.stdout).toContain("src/u.ts:3");
  });

  test("a store the file system will not let it write answers from what it holds and counts the files still pending", () => {
    const root = makeCrankProject({
      "src/lib.ts": "export function target() {}\n",
      "src/user.ts": 'import { target } from "./lib";\nexport function use() {\n  target();\n}\n',
    });
    expect(listed(callers(root, "target").stdout).resolved).toEqual(["src/user.ts:3 use"]);

    const user = path.join(root, "src/user.ts");
    setMtime(user, Date.now() + 5000);
    const opened = openCodeDb(root, "write");
    refreshFileFacts(root, loadConfig(path.join(root, ".crank")), opened.db!, Infinity);
    opened.db!.close();

    const restore = () => {
      for (const file of codeDbFiles(root)) fs.chmodSync(file, 0o644);
    };
    try {
      for (const file of codeDbFiles(root)) fs.chmodSync(file, 0o444);
      const run = callers(root, "target");
      expect(run.status).toBe(0);
      expect(listed(run.stdout).resolved).toEqual(["src/user.ts:3 use"]);
      expect(run.stdout.trimEnd().split("\n").at(-1)).toBe("(1 file(s) still pending parse)");
      const tree = runCli(root, ["impact", "target"]);
      expect(tree.status).toBe(0);
      expect(tree.stdout).toContain("└─ use");
      expect(tree.stdout.trimEnd().split("\n").at(-1)).toBe("(1 file(s) still pending parse)");
    } finally {
      restore();
    }
    expect(callers(root, "target").stdout).not.toContain("pending");
  });
});

describe("a store the commands cannot refresh", () => {
  test("a store another process holds busy fails `scan`, and `callers` answers with the not-fresh line", () => {
    const root = graphProject({
      "src/lib.ts": "export function target() {}\n",
      "src/user.ts": 'import { target } from "./lib";\nexport function use() {\n  target();\n}\n',
    });
    const holder = openCodeDb(root, "write");
    holder.db!.exec("BEGIN IMMEDIATE");
    try {
      // The open itself reports busy, which `scan` must not read as a store to delete.
      expect(openCodeDb(root, "write").status).toBe("busy");
      const scan = runCli(root, ["scan"]);
      expect(scan.status).toBe(1);
      expect(scan.stderr).toContain("crank-mem: code.db busy, scan skipped");
      expect(scan.stdout).not.toContain("full scan complete");

      const run = runCli(root, ["callers", "target"]);
      expect(run.status).toBe(0);
      expect(listed(run.stdout).resolved).toEqual(["src/user.ts:3 use"]);
      expect(run.stdout.trimEnd().split("\n").at(-1)).toBe("(code.db busy; answer may be stale)");
    } finally {
      holder.db!.exec("ROLLBACK");
      holder.db!.close();
    }
    expect(runCli(root, ["callers", "target"]).stdout).not.toContain("busy");
    expect(runCli(root, ["scan"]).stdout).toContain("full scan complete");
  }, 30_000);

  test("a rebuild whose delete the file system refuses exits 1 with the OS error", () => {
    const root = makeCrankProject({ "a.ts": "export function x() {}\n" });
    const sqliteModule = process.getBuiltinModule("node:sqlite") as typeof sqlite;
    const db = new sqliteModule.DatabaseSync(path.join(root, ".crank/code.db"));
    db.exec("CREATE TABLE files (x); PRAGMA user_version = 99");
    db.close();
    const crank = path.join(root, ".crank");
    try {
      fs.chmodSync(crank, 0o555);
      const run = runCli(root, ["callers", "x"]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "crank-mem: .crank/code.db is not readable (EACCES). Fix: crank-mem scan",
      );
      expect(run.stderr).not.toContain("at ");
      const job = runCli(root, ["graph-job", root]);
      expect(job.status).toBe(1);
      const scan = runCli(root, ["scan"]);
      expect(scan.status).toBe(1);
      expect(scan.stderr).toContain("crank-mem: could not delete .crank/code.db (EACCES)");
      expect(scan.stdout).not.toContain("full scan complete");
    } finally {
      fs.chmodSync(crank, 0o755);
    }
    expect(runCli(root, ["scan"]).status).toBe(0);
  });
});

describe("impact", () => {
  const impact = (root: string, ...args: string[]) => runCli(root, ["impact", ...args]);
  const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

  test("it prints each caller's callers down to the depth: two levels by default, up to three", () => {
    const root = makeCrankProject({
      "src/chain.ts": [
        "export function leaf() {}",
        "export function mid() {",
        "  leaf();",
        "}",
        "export function top() {",
        "  mid();",
        "}",
        "export function outer() {",
        "  top();",
        "}",
        "",
      ].join("\n"),
    });
    expect(impact(root, "leaf").stdout).toBe(
      lines(
        "leaf  src/chain.ts:1",
        "└─ mid                src/chain.ts:3",
        "   └─ top             src/chain.ts:6",
      ),
    );
    expect(impact(root, "leaf", "--depth", "3").stdout).toBe(
      lines(
        "leaf  src/chain.ts:1",
        "└─ mid                src/chain.ts:3",
        "   └─ top             src/chain.ts:6",
        "      └─ outer        src/chain.ts:9",
      ),
    );
    expect(impact(root, "--depth", "1", "leaf").stdout).toBe(
      lines("leaf  src/chain.ts:1", "└─ mid                src/chain.ts:3"),
    );
    // Nothing calls outer: the root line stands alone.
    expect(impact(root, "src/chain.ts", "outer").stdout).toBe("outer  src/chain.ts:8\n");
  });

  test("a depth outside 1 to 3, a missing value and a wrong argument count print the usage line", () => {
    const root = makeCrankProject({ "a.ts": "export function a() {}\n" });
    for (const args of [
      ["a", "--depth", "0"],
      ["a", "--depth", "4"],
      ["a", "--depth", "x"],
      ["a", "--depth"],
      [],
      ["a.ts", "a", "b"],
    ]) {
      const run = impact(root, ...args);
      expect(run.status).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("Usage: crank-mem impact");
    }
  });

  test("a cycle stops where it returns to a symbol on its path", () => {
    const root = makeCrankProject({
      "src/cycle.ts": "export function a() {\n  b();\n}\nexport function b() {\n  a();\n}\n",
    });
    const run = impact(root, "a", "--depth", "3");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      lines(
        "a  src/cycle.ts:1",
        "└─ b                  src/cycle.ts:5",
        "   └─ a               src/cycle.ts:2 (shown above)",
      ),
    );
  });

  test("a symbol reached twice prints its callers once and later says where", () => {
    const root = makeCrankProject({
      "src/diamond.ts": [
        "export function r() {}",
        "export function p() {",
        "  r();",
        "}",
        "export function q() {",
        "  r();",
        "}",
        "export function s() {",
        "  p();",
        "  q();",
        "}",
        "export function t() {",
        "  s();",
        "}",
        "",
      ].join("\n"),
    });
    expect(impact(root, "r", "--depth", "3").stdout).toBe(
      lines(
        "r  src/diamond.ts:1",
        "├─ p                  src/diamond.ts:3",
        "│  └─ s               src/diamond.ts:9",
        "│     └─ t            src/diamond.ts:13",
        "└─ q                  src/diamond.ts:6",
        "   └─ s               src/diamond.ts:10 (shown above)",
      ),
    );
  });

  test("a symbol with more than 50 callers prints its count and no subtree", () => {
    const build = (callers: number) =>
      makeCrankProject({
        "src/hub.ts": [
          "export function root() {}",
          "export function hub() {",
          "  root();",
          "}",
          ...Array.from({ length: callers }, (_, n) => `export function c${n}() {\n  hub();\n}`),
          "",
        ].join("\n"),
      });
    const hub = impact(build(51), "root");
    expect(hub.status).toBe(0);
    expect(hub.stdout).toBe(
      lines("root  src/hub.ts:1", "└─ hub                src/hub.ts:3 (51 callers, not expanded)"),
    );
    const edge = impact(build(50), "root").stdout.split("\n");
    expect(edge).toHaveLength(53);
    expect(edge[1]).toBe("└─ hub                src/hub.ts:3");
    expect(edge[2]).toBe("   ├─ c0              src/hub.ts:6");
  });

  describe("the printed layout", () => {
    const files = {
      "src/lib/memory.ts": [
        "export function readStoreSync(root: string, fn: (m: string) => string): string {",
        "  return fn(root);",
        "}",
        "export function storeStatus(root: string): string {",
        "  return readStoreSync(root, (memory) => memory);",
        "}",
        "",
      ].join("\n"),
      "src/cli/stats.ts": [
        'import { readStoreSync } from "../lib/memory.ts";',
        "",
        "export function captureSummary(root: string): string {",
        "  return readStoreSync(root, (m) => m);",
        "}",
        "export function captureRows(root: string): string {",
        "  return captureSummary(root);",
        "}",
        "",
      ].join("\n"),
      "src/cli/server.ts": [
        'import { captureSummary } from "./stats.ts";',
        'import { storeStatus } from "../lib/memory.ts";',
        "export function health(root: string): string {",
        "  return captureSummary(root);",
        "}",
        "export function projectsBody(root: string): string {",
        "  return storeStatus(root);",
        "}",
        "",
      ].join("\n"),
      "src/lib/citations.ts": [
        'import { readStoreSync } from "./memory.ts";',
        "export function storeLinks(root: string): string {",
        "  return readStoreSync(root, (m) => m);",
        "}",
        "export function citationCheck(root: string): string {",
        "  return storeLinks(root);",
        "}",
        "",
      ].join("\n"),
      "src/lib/injection.ts": [
        'import { readStoreSync, storeStatus } from "./memory.ts";',
        "export function readRecall(root: string): string {",
        "  return readStoreSync(root, (memory) => memory);",
        "}",
        "export function subagentInjection(root: string): string {",
        "  return storeStatus(root);",
        "}",
        "",
      ].join("\n"),
    };

    test("a symbol's tree lays out its callers with tree lines, padded names and call sites", () => {
      const run = impact(makeCrankProject(files), "readStoreSync");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(
        lines(
          "readStoreSync  src/lib/memory.ts:1",
          "├─ captureSummary     src/cli/stats.ts:4",
          "│  ├─ health          src/cli/server.ts:4",
          "│  └─ captureRows     src/cli/stats.ts:7",
          "├─ storeLinks         src/lib/citations.ts:3",
          "│  └─ citationCheck   src/lib/citations.ts:6",
          "├─ readRecall         src/lib/injection.ts:3",
          "└─ storeStatus        src/lib/memory.ts:5",
          "   ├─ projectsBody    src/cli/server.ts:7",
          "   └─ subagentInjection  src/lib/injection.ts:6",
        ),
      );
    });

    test("a file lists the callers of each of its symbols, then the files that import it", () => {
      const root = makeCrankProject({
        "src/x.ts": "export function f1() {}\nexport function f2() {}\nexport function f3() {}\n",
        "src/y.ts": 'import { f1 } from "./x";\nexport function useF1() {\n  f1();\n}\n',
        "src/z.ts": 'import { f2 } from "./x";\nexport function useF2() {\n  f2();\n}\n',
      });
      const run = impact(root, "src/x.ts");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(
        lines(
          "src/x.ts",
          "f1  src/x.ts:1",
          "└─ useF1              src/y.ts:3",
          "f2  src/x.ts:2",
          "└─ useF2              src/z.ts:3",
          "Imported by:",
          "src/y.ts",
          "src/z.ts",
        ),
      );
    });
  });
});

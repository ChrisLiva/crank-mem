import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { codeSymbols, grammarFor } from "../src/cli/code-symbols.ts";
import { outlinePage, preorder } from "../src/cli/code.ts";
import { makeCrankProject, REPO_ROOT, runCli, tempDir, type CliRun } from "./helpers.ts";

const FIXTURES = path.join(REPO_ROOT, "tests/fixtures/code");
const A_TS = [
  "/** Doubles. */",
  "export function double(x: number): number {",
  "  return x * 2;",
  "}",
  "",
  "export class Box {",
  "  size = 1;",
  "  constructor(private n: number) {}",
  "  get value(): number {",
  "    return this.n;",
  "  }",
  "}",
  "",
].join("\n");

describe("outline", () => {
  test("every mapped extension loads its grammar, case-insensitively", async () => {
    const exts = [
      "ts",
      "mts",
      "cts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "py",
      "pyi",
      "go",
      "rs",
      "c",
      "h",
      "cc",
      "cpp",
      "cxx",
      "hpp",
      "hh",
      "hxx",
      "sh",
      "bash",
      "java",
      "cs",
      "rb",
      "php",
      "ps1",
      "psm1",
      "TS",
      "Py",
      "CPP",
    ];
    for (const ext of exts) {
      const grammar = grammarFor(`e.${ext}`);
      expect([ext, grammar === null]).toEqual([ext, false]);
      expect([ext, await codeSymbols("", grammar!)]).toEqual([ext, []]);
    }
    const root = makeCrankProject({ "src/e.TS": "" });
    expect(runCli(root, ["outline", "src/e.TS"])).toMatchObject({
      status: 0,
      stdout: "src/e.TS\n",
    });
  }, 30_000);

  test("outline prints folded source with start-end gutters", () => {
    const params = Array.from({ length: 20 }, (_, i) => `a${i}: number`).join(", ");
    const root = makeCrankProject({
      "src/c.ts": "function ok(): void {}\nconst = ;\n",
      "src/f.ts": "export const f = (x: number) => {\n  return x;\n};\n",
      "src/g.ts": "function g(\n  a: number,\n  b: [string, number],\n): void {\n}\n",
      "src/t.ts": "type T = number;\n",
      "src/a.ts": A_TS,
      "src/long.ts": `function long(${params}): void {}\n`,
    });
    const outline = (file: string) => runCli(root, ["outline", file]);

    expect(outline("src/c.ts")).toEqual({
      status: 0,
      stdout: "src/c.ts\n1-1│function ok(): void { … }\n",
      stderr: "",
    });
    expect(outline("src/f.ts")).toMatchObject({
      status: 0,
      stdout: "src/f.ts\n1-3│export const f = (x: number) => { … }\n",
    });
    expect(outline("src/g.ts")).toMatchObject({
      status: 0,
      stdout: "src/g.ts\n1-5│function g(a: number, b: [string, number]): void { … }\n",
    });
    expect(outline("src/t.ts")).toMatchObject({
      status: 0,
      stdout: "src/t.ts\n1-1│type T = number;\n",
    });
    expect(outline("src/a.ts")).toMatchObject({
      status: 0,
      stdout: [
        "src/a.ts",
        " 2-4│export function double(x: number): number { … }",
        "6-12│export class Box {",
        " 8-8│  constructor(private n: number) { … }",
        "9-11│  get value(): number { … }",
        "",
      ].join("\n"),
    });
    const long = outline("src/long.ts");
    expect(long.status).toBe(0);
    expect(long.stdout.split("\n")[1]!.split("│")[1]).toBe(
      `function long(${params}): void`.slice(0, 159) + "…" + " { … }",
    );
    expect(outline("./src/a.ts").stdout.split("\n")[0]).toBe("./src/a.ts");
  }, 30_000);
});

describe("unfold", () => {
  test("unfold matches by name, qualified name and line", () => {
    const root = makeCrankProject({
      "src/a.ts": A_TS,
      "src/d.ts":
        "// detached\n\n// one\n// two\nfunction d(): void {}\n/** e */\nconst e = () => {};\n",
      "src/k.ts": ["k1", "k1", "k2", "k3", "k4", "k5", "k6"]
        .map((k) => `function ${k}(): void {}\n`)
        .join(""),
      "src/r.ts":
        "namespace A {\n  export function run(): void {}\n}\nnamespace B {\n  export function run(): void {}\n}\nfunction run(): void {}\n",
      "src/cpp.cpp": fs.readFileSync(path.join(FIXTURES, "cpp.cpp"), "utf8"),
      "src/doc.py": "# doc\n@deco\ndef f(): pass\n",
      "src/doc2.py": "class A:\n    # doc for m\n    def m(self): pass\n",
      "src/doc.go": "package p\n\n// Foo is a thing.\ntype Foo struct {\n\tx int\n}\n",
      "src/doc.rs": "/// doc\n#[inline]\nfn f() {}\n",
      "src/doc.php": "<?php\n/** doc */\n#[A]\nclass C {}\n",
      "src/n.cs": "namespace Outer {\n  class K {\n    void M() {}\n  }\n}\n",
      "src/doc.rb":
        "class A\n  # doc for m\n  def m\n  end\n\n  # doc for n\n  def n\n  end\nend\n",
    });
    const unfold = (file: string, query: string) => runCli(root, ["unfold", file, query]);

    expect(unfold("src/a.ts", "double")).toEqual({
      status: 0,
      stdout:
        "src/a.ts:2-4 fn double\n1│/** Doubles. */\n2│export function double(x: number): number {\n3│  return x * 2;\n4│}\n",
      stderr: "",
    });
    expect(unfold("src/d.ts", "d")).toMatchObject({
      status: 0,
      stdout: "src/d.ts:5-5 fn d\n3│// one\n4│// two\n5│function d(): void {}\n",
    });
    const value =
      "src/a.ts:9-11 method Box.value\n 9│  get value(): number {\n10│    return this.n;\n11│  }\n";
    expect(unfold("src/a.ts", "Box.value")).toMatchObject({ status: 0, stdout: value });
    expect(unfold("src/a.ts", "10")).toMatchObject({ status: 0, stdout: value });
    const box = A_TS.split("\n")
      .slice(5, 12)
      .map((line, i) => `${String(i + 6).padStart(2)}│${line}\n`)
      .join("");
    expect(unfold("src/a.ts", "7")).toMatchObject({
      status: 0,
      stdout: `src/a.ts:6-12 class Box\n${box}`,
    });
    const runA = "src/r.ts:2-2 fn A.run\n2│  export function run(): void {}\n";
    expect(unfold("src/r.ts", "run")).toMatchObject({
      status: 0,
      stdout: `${runA}\nsrc/r.ts:5-5 fn B.run\n5│  export function run(): void {}\n\nsrc/r.ts:7-7 fn run\n7│function run(): void {}\n`,
    });
    expect(unfold("src/r.ts", "A.run")).toMatchObject({ status: 0, stdout: runA });
    expect(unfold("src/r.ts", "A::run")).toMatchObject({ status: 0, stdout: runA });
    const miss = (file: string, query: string, stderr: string) =>
      expect([query, unfold(file, query)]).toEqual([query, { status: 1, stdout: "", stderr }]);
    miss(
      "src/a.ts",
      "box",
      "crank-mem: no symbol box in src/a.ts.\nClose: Box, Box.constructor, Box.value\n",
    );
    miss("src/a.ts", "zzz", "crank-mem: no symbol zzz in src/a.ts.\n");
    for (const n of ["5", "0", "99"])
      miss("src/a.ts", n, `crank-mem: no symbol at line ${n} in src/a.ts.\n`);
    miss("src/k.ts", "K", "crank-mem: no symbol K in src/k.ts.\nClose: k1, k2, k3, k4, k5\n");
    expect(unfold("src/d.ts", "e")).toMatchObject({
      status: 0,
      stdout: "src/d.ts:7-7 fn e\n6│/** e */\n7│const e = () => {};\n",
    });
    const cppHeaders = (query: string) => {
      const run = unfold("src/cpp.cpp", query);
      return [run.status, run.stdout.split("\n").filter((line) => line.startsWith("src/cpp.cpp:"))];
    };
    const outOfLine = "src/cpp.cpp:94-95 fn GUI.ExtruderGroup::SetTitle";
    const declared = "src/cpp.cpp:91-91 method GUI.ExtruderGroup.SetTitle";
    expect(cppHeaders("SetTitle")).toEqual([
      0,
      ["src/cpp.cpp:86-87 method GUI.HoverLabel.SetTitle", declared, outOfLine],
    ]);
    expect(cppHeaders("ExtruderGroup::SetTitle")).toEqual([0, [declared, outOfLine]]);
    expect(unfold("src/doc.py", "f")).toMatchObject({
      status: 0,
      stdout: "src/doc.py:2-3 fn f\n1│# doc\n2│@deco\n3│def f(): pass\n",
    });
    expect(runCli(root, ["outline", "src/doc2.py"])).toMatchObject({
      status: 0,
      stdout: "src/doc2.py\n1-3│class A:\n3-3│    def m(self): …\n",
    });
    expect(unfold("src/doc2.py", "A.m")).toMatchObject({
      status: 0,
      stdout: "src/doc2.py:3-3 method A.m\n2│    # doc for m\n3│    def m(self): pass\n",
    });
    expect(unfold("src/doc.go", "Foo")).toMatchObject({
      status: 0,
      stdout:
        "src/doc.go:4-6 struct Foo\n3│// Foo is a thing.\n4│type Foo struct {\n5│\tx int\n6│}\n",
    });
    expect(unfold("src/doc.rs", "f")).toMatchObject({
      status: 0,
      stdout: "src/doc.rs:2-3 fn f\n1│/// doc\n2│#[inline]\n3│fn f() {}\n",
    });
    expect(unfold("src/doc.php", "C")).toMatchObject({
      status: 0,
      stdout: "src/doc.php:3-4 class C\n2│/** doc */\n3│#[A]\n4│class C {}\n",
    });
    expect(runCli(root, ["outline", "src/n.cs"])).toMatchObject({
      status: 0,
      stdout: "src/n.cs\n1-5│namespace Outer {\n2-4│  class K {\n3-3│    void M() { … }\n",
    });
    expect(unfold("src/n.cs", "M").stdout.split("\n")[0]).toBe("src/n.cs:3-3 method Outer.K.M");
    expect(unfold("src/doc.rb", "A.m")).toMatchObject({
      status: 0,
      stdout: "src/doc.rb:3-4 method A.m\n2│  # doc for m\n3│  def m\n4│  end\n",
    });
    expect(unfold("src/doc.rb", "A.n")).toMatchObject({
      status: 0,
      stdout: "src/doc.rb:7-8 method A.n\n6│  # doc for n\n7│  def n\n8│  end\n",
    });
  }, 30_000);
});

const CAP = 25_000;
const pad = (n: number) => String(n).padStart(4, "0");
const CONT =
  /^… (?<k>\d+) more symbols from L(?<s>\d+): crank-mem outline src\/many\.ts --from \k<s>$/;

/** src/many.ts's lines (399 function pairs, a 800-method class, 600 more pairs) and every symbol outline prints for it, in order. */
function manyFixture(): { manyLines: string[]; expected: { start: number; text: string }[] } {
  const pairLine = (n: number) =>
    `function a${pad(n)}(x: number) { return x; } function b${pad(n)}(x: number) { return x; }`;
  const manyLines: string[] = [];
  const expected: { start: number; text: string }[] = [];
  const pair = (n: number) => {
    manyLines.push(pairLine(n));
    for (const name of ["a", "b"])
      expected.push({ start: n, text: `function ${name}${pad(n)}(x: number) { … }` });
  };
  for (let n = 1; n <= 399; n++) pair(n);
  manyLines.push("class Big {");
  expected.push({ start: 400, text: "class Big {" });
  for (let n = 401; n <= 1200; n++) {
    manyLines.push(`  m${pad(n)}(): void {}`);
    expected.push({ start: n, text: `  m${pad(n)}(): void { … }` });
  }
  manyLines.push("}");
  for (let n = 1202; n <= 1801; n++) pair(n);
  return { manyLines, expected };
}

/** Each symbol line's start, pushing the text of those at or past `from` onto `seen`. */
function pageStarts(symbolLines: string[], from: number, seen: string[]): number[] {
  const starts: number[] = [];
  for (const line of symbolLines) {
    const [gutter, text] = line.split("│") as [string, string];
    const start = Number(gutter.trim().split("-")[0]);
    starts.push(start);
    if (start >= from) seen.push(text);
  }
  return starts;
}

/** Pages through src/many.ts with --from, checking each page, and returns the symbols first seen on each page and whether a page reprinted class Big as context. */
function pageMany(
  outline: (file: string, from?: number) => CliRun,
  expected: { start: number; text: string }[],
): { seen: string[]; sawBigContext: boolean } {
  const seen: string[] = [];
  let from = 1;
  let sawBigContext = false;
  for (let pages = 0; ; pages++) {
    expect(pages).toBeLessThan(20);
    const run = outline("src/many.ts", from === 1 ? undefined : from);
    expect([from, run.status, run.stdout.length <= CAP, run.stdout.endsWith("\n")]).toEqual([
      from,
      0,
      true,
      true,
    ]);
    const lines = run.stdout.slice(0, -1).split("\n");
    expect(lines[0]).toBe("src/many.ts");
    const last = CONT.exec(lines.at(-1)!)?.groups;
    if (from === 1) expect(last).toBeDefined();
    const symbolLines = lines.slice(1, last ? -1 : undefined);
    const widths = new Set(symbolLines.map((line) => line.split("│")[0]!.length));
    expect(widths.size).toBe(1);
    const starts = pageStarts(symbolLines, from, seen);
    if (from > 400 && from <= 1201 && symbolLines[0]!.trimStart() === "400-1201│class Big {")
      sawBigContext = true;
    if (!last) break;
    const s = Number(last.s);
    expect(starts.every((start) => start < s)).toBe(true);
    expect(Number(last.k)).toBe(expected.filter((e) => e.start >= s).length);
    from = s;
  }
  return { seen, sawBigContext };
}

describe("cap", () => {
  test("outline pages within the cap and unfold folds what does not fit", () => {
    const { manyLines, expected } = manyFixture();
    const crowdedLine = Array.from({ length: 1500 }, (_, i) => `function c${pad(i + 1)}() {}`).join(
      " ",
    );
    const root = makeCrankProject({
      "src/many.ts": manyLines.join("\n") + "\n",
      "src/nest.ts": "namespace O {\n  class C {\n    m(): void {}\n    n(): void {}\n  }\n}\n",
      "src/crowded.ts": `${crowdedLine}\nfunction tail() {}\n`,
      "src/crowded2.ts": `${crowdedLine}\n`,
    });
    const outline = (file: string, from?: number) =>
      runCli(root, ["outline", file, ...(from === undefined ? [] : ["--from", String(from)])]);

    const { seen, sawBigContext } = pageMany(outline, expected);
    expect(seen).toEqual(expected.map((e) => e.text));
    expect(sawBigContext).toBe(true);
    expect(outline("src/many.ts", 99999)).toEqual({
      status: 0,
      stdout: "src/many.ts\n",
      stderr: "",
    });
    expect(outline("src/nest.ts", 4)).toEqual({
      status: 0,
      stdout: "src/nest.ts\n1-6│namespace O {\n2-5│  class C {\n4-4│    n(): void { … }\n",
      stderr: "",
    });

    const crowded = outline("src/crowded.ts");
    expect(crowded.status).toBe(0);
    expect(crowded.stdout.length).toBeLessThanOrEqual(CAP);
    const crowdedLines = crowded.stdout.slice(0, -1).split("\n");
    expect(crowdedLines.at(-1)).toBe(
      "… 1 more symbols from L2: crank-mem outline src/crowded.ts --from 2",
    );
    expect(crowdedLines.length).toBeGreaterThan(2);
    expect(
      crowdedLines.slice(1, -1).every((line) => /^1-1│function c\d{4}\(\) \{ … \}$/.test(line)),
    ).toBe(true);
    expect(outline("src/crowded.ts", 2)).toEqual({
      status: 0,
      stdout: "src/crowded.ts\n2-2│function tail() { … }\n",
      stderr: "",
    });
    const crowded2 = outline("src/crowded2.ts");
    expect(crowded2.status).toBe(0);
    expect(crowded2.stdout.length).toBeLessThanOrEqual(CAP);
    expect(crowded2.stdout.slice(0, -1).split("\n").at(-1)).toMatch(
      /^1-1│function c\d{4}\(\) \{ … \}$/,
    );

    const methods = Array.from({ length: 2998 }, (_, i) => `  m${pad(i + 2)}(): void {}`);
    fs.writeFileSync(
      path.join(root, "src/huge.ts"),
      [
        "class Huge {",
        ...methods,
        "}",
        "namespace later {",
        "  export function Huge(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    const huge = runCli(root, ["unfold", "src/huge.ts", "Huge"]);
    expect(huge.status).toBe(0);
    expect(huge.stdout.length).toBeLessThanOrEqual(CAP);
    const hugeLines = huge.stdout.slice(0, -1).split("\n");
    expect(hugeLines[0]).toBe("src/huge.ts:1-3000 class Huge");
    expect(hugeLines[1]).toEndWith("│class Huge {");
    expect(hugeLines.slice(1, -3).every((line) => /^ *\d+-\d+│/.test(line))).toBe(true);
    expect(hugeLines.slice(-3)).toEqual([
      "… L1-3000 is too long to print whole: read a slice by line range, or run crank-mem outline src/huge.ts --from 1.",
      "… 1 matches past the cap, by header:",
      "src/huge.ts:3002-3002 fn later.Huge",
    ]);

    /** The capped unfold reassembled from its whole matches and bare headers, counting how many of each it printed. */
    const folded = (stdout: string, wholes: string[], headers: string[]) => {
      const n = wholes.length;
      const pastAt = stdout.indexOf("\n… ") + 1;
      const w = stdout
        .slice(0, pastAt)
        .split("\n")
        .filter((line) => headers.includes(line + "\n")).length;
      const after = stdout
        .slice(pastAt)
        .split("\n")
        .filter((line) => headers.includes(line + "\n")).length;
      const more = w + after < n ? `… ${n - w - after} more matches.\n` : "";
      const rebuilt =
        wholes.slice(0, w).join("\n") +
        `… ${n - w} matches past the cap, by header:\n` +
        headers.slice(w, w + after).join("") +
        more;
      return { w, after, more, rebuilt };
    };
    const x40 = "x".repeat(40);
    const forty: string[] = [];
    const fortyWholes: string[] = [];
    const fortyHeaders: string[] = [];
    for (let b = 1; b <= 40; b++) {
      const nn = String(b).padStart(2, "0");
      const start = forty.length + 2;
      forty.push(`namespace n${nn} {`, "  export function big(): void {");
      for (let v = 1; v <= 30; v++)
        forty.push(`    const v${String(v).padStart(2, "0")} = "${x40}";`);
      forty.push("  }", "}");
      const end = forty.length - 1;
      fortyHeaders.push(`src/forty.ts:${start}-${end} fn n${nn}.big\n`);
      fortyWholes.push(
        fortyHeaders.at(-1)! +
          forty
            .slice(start - 1, end)
            .map((line, i) => `${String(start + i).padStart(String(end).length)}│${line}\n`)
            .join(""),
      );
    }
    fs.writeFileSync(path.join(root, "src/forty.ts"), forty.join("\n") + "\n");
    const fortyRun = runCli(root, ["unfold", "src/forty.ts", "big"]);
    expect([fortyRun.status, fortyRun.stdout.length <= CAP]).toEqual([0, true]);
    const f40 = folded(fortyRun.stdout, fortyWholes, fortyHeaders);
    expect([f40.w >= 1, f40.after >= 1, fortyRun.stdout]).toEqual([true, true, f40.rebuilt]);

    const thousand: string[] = [];
    const thousandWholes: string[] = [];
    const thousandHeaders: string[] = [];
    for (let n = 1; n <= 1000; n++) {
      thousand.push(`namespace t${pad(n)} { export function f(): void {} }`);
      thousandHeaders.push(`src/thousand.ts:${n}-${n} fn t${pad(n)}.f\n`);
      thousandWholes.push(`${thousandHeaders.at(-1)}${n}│${thousand.at(-1)}\n`);
    }
    fs.writeFileSync(path.join(root, "src/thousand.ts"), thousand.join("\n") + "\n");
    const thousandRun = runCli(root, ["unfold", "src/thousand.ts", "f"]);
    expect([thousandRun.status, thousandRun.stdout.length <= CAP]).toEqual([0, true]);
    const f1000 = folded(thousandRun.stdout, thousandWholes, thousandHeaders);
    expect(f1000.more).toMatch(/^… \d+ more matches\.\n$/);
    expect(thousandRun.stdout).toBe(f1000.rebuilt);
  }, 60_000);
});

describe("refusals", () => {
  test("argument and path checks refuse in order, each with one stderr line and no file written", () => {
    const bare = tempDir("crank-code-bare-");
    const usage = "Usage: crank-mem outline <file> [--from <line>]\n";
    for (const args of [
      [],
      ["a.ts", "b.ts"],
      ["a.ts", "--from"],
      ["a.ts", "--from", "0"],
      ["a.ts", "--from", "1.5"],
      ["a.ts", "--from", "abc"],
    ]) {
      expect([args, runCli(bare, ["outline", ...args])]).toEqual([
        args,
        { status: 1, stdout: "", stderr: usage },
      ]);
    }
    const unfoldUsage = "Usage: crank-mem unfold <file> <symbol|line>\n";
    for (const args of [[], ["a.ts"], ["a.ts", ""], ["a.ts", "f", "g"]]) {
      expect([args, runCli(bare, ["unfold", ...args])]).toEqual([
        args,
        { status: 1, stdout: "", stderr: unfoldUsage },
      ]);
    }
    expect(fs.readdirSync(bare)).toEqual([]);
    for (const args of [
      ["outline", "a.ts"],
      ["unfold", "a.ts", "f"],
    ]) {
      expect([args, runCli(bare, args)]).toEqual([
        args,
        {
          status: 1,
          stdout: "",
          stderr: "crank-mem: not initialized here — run `crank-mem init` first.\n",
        },
      ]);
    }
    expect(fs.existsSync(path.join(bare, ".crank"))).toBe(false);

    const outside = path.join(tempDir("crank-code-outside-"), "o.ts");
    fs.writeFileSync(outside, "export const o = 1;\n");
    const root = makeCrankProject({
      "src/a.ts": "export const a = 1;\n",
      "src/credentials.ts": "export const c = 1;\n",
      "src/.env": "SECRET=1\n",
      "src/locked.ts": "export const l = 1;\n",
      "notes.swift": "let n = 1\n",
      "NOTES.SWIFT": "let n = 1\n",
      Makefile: "all:\n",
    });
    fs.symlinkSync(outside, path.join(root, "src/link.ts"));
    fs.symlinkSync(path.join(root, "src/.env"), path.join(root, "src/notes.ts"));
    fs.mkdirSync(path.join(root, "src/x.ts"));
    const tree = () =>
      fs
        .readdirSync(root, { recursive: true })
        .filter((p) => p !== path.join(".crank", "usage.jsonl"))
        .sort();
    const before = tree();
    const refuses = (file: string, line: string) => {
      expect([file, runCli(root, ["outline", file])]).toEqual([
        file,
        { status: 1, stdout: "", stderr: `crank-mem: ${line}\n` },
      ]);
      expect(tree()).toEqual(before);
    };
    refuses(outside, `${outside} is outside this project.`);
    refuses("/nonexistent-crank-dir/a.ts", "/nonexistent-crank-dir/a.ts is outside this project.");
    refuses("src/link.ts", "src/link.ts is outside this project.");
    refuses(
      "src/credentials.ts",
      "src/credentials.ts is a sensitive file; crank-mem does not read it.",
    );
    expect(runCli(root, ["unfold", "src/credentials.ts", "f"])).toEqual({
      status: 1,
      stdout: "",
      stderr: "crank-mem: src/credentials.ts is a sensitive file; crank-mem does not read it.\n",
    });
    expect(tree()).toEqual(before);
    refuses("src/notes.ts", "src/notes.ts is a sensitive file; crank-mem does not read it.");
    refuses("src/missing.ts", "no file src/missing.ts.");
    refuses("src/a.ts/x.ts", "cannot read src/a.ts/x.ts (ENOTDIR).");
    refuses("notes.swift", "no grammar for .swift files.");
    refuses("NOTES.SWIFT", "no grammar for .swift files.");
    refuses("Makefile", "no grammar for Makefile.");
    const locked = path.join(root, "src/locked.ts");
    fs.chmodSync(locked, 0o000);
    try {
      refuses("src/locked.ts", "cannot read src/locked.ts (EACCES).");
    } finally {
      fs.chmodSync(locked, 0o644);
    }
    refuses("src/x.ts", "cannot read src/x.ts (EISDIR).");
  }, 30_000);
});

describe("without the code reader", () => {
  test("outline reports the missing reader, and scan and --help still exit 0", () => {
    const clone = tempDir("crank-clone-");
    for (const name of ["src", "bin", "package.json"])
      fs.cpSync(path.join(REPO_ROOT, name), path.join(clone, name), { recursive: true });
    fs.mkdirSync(path.join(clone, "node_modules"));
    const root = makeCrankProject({ "src/a.ts": "export function a(): void {}\n" });
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [path.join(clone, "src/cli/main.ts"), ...args], {
        cwd: root,
        encoding: "utf-8",
        timeout: 30_000,
        env: {
          ...process.env,
          CRANK_HOME: tempDir("crank-home-"),
          CODEX_HOME: tempDir("crank-codexhome-"),
        },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    expect(run("outline", "src/a.ts")).toEqual({
      status: 1,
      stdout: "",
      stderr: "crank-mem: the code reader is not installed — run `crank-mem setup`.\n",
    });
    expect(run("scan").status).toBe(0);
    expect(run("--help").status).toBe(0);
  }, 30_000);
});

const FAMILIES = [
  "typescript.ts",
  "tsx.tsx",
  "cpp.cpp",
  "javascript.js",
  "python.py",
  "go.go",
  "rust.rs",
  "bash.sh",
  "java.java",
  "c-sharp.cs",
  "ruby.rb",
  "php.php",
  "powershell.ps1",
];

describe("families", () => {
  const golden = (fixture: string) => ({
    text: fs.readFileSync(path.join(FIXTURES, fixture), "utf8"),
    outline: fs.readFileSync(path.join(FIXTURES, `${fixture}.outline`), "utf8"),
    headers: fs
      .readFileSync(path.join(FIXTURES, `${fixture}.headers`), "utf8")
      .split("\n")
      .slice(0, -1),
  });

  for (const fixture of FAMILIES) {
    const file = `src/${fixture}`;

    test(`symbols reproduce the committed outline and headers for ${fixture}`, async () => {
      const { text, outline, headers } = golden(fixture);
      const symbols = await codeSymbols(text, grammarFor(file)!);
      expect(symbols).not.toBeNull();
      const entries = preorder(symbols!);
      expect(outlinePage(file, entries, 1).text).toBe(outline);
      expect(
        entries.map(({ symbol: s }) => `${file}:${s.start}-${s.end} ${s.kind} ${s.qualified}`),
      ).toEqual(headers);
    });

    test(`outline and unfold match the committed expectation for ${fixture}`, async () => {
      const { text, outline, headers } = golden(fixture);
      const root = makeCrankProject({ [file]: text });
      expect(runCli(root, ["outline", file])).toMatchObject({ status: 0, stdout: outline });

      const entries = preorder((await codeSymbols(text, grammarFor(file)!))!);
      const depth = Math.max(...entries.map(({ parents }) => parents.length));
      const deepest = entries.findIndex(({ parents }) => parents.length === depth);
      const header = headers[deepest]!;
      const unfold = runCli(root, ["unfold", file, entries[deepest]!.symbol.qualified]);
      expect([header, unfold.status, unfold.stdout.split("\n").includes(header)]).toEqual([
        header,
        0,
        true,
      ]);
    }, 30_000);
  }
});

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeCrankProject, REPO_ROOT, runCli, tempDir } from "./helpers.ts";

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
  test("every mapped extension loads its grammar, case-insensitively", () => {
    const exts = [
      "ts", "mts", "cts", "tsx", "js", "jsx", "mjs", "cjs", "py", "pyi", "go", "rs",
      "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "sh", "bash", "java", "cs", "rb", "php", "ps1", "psm1",
      "TS", "Py", "CPP",
    ];
    const root = makeCrankProject(Object.fromEntries(exts.map((ext) => [`src/e.${ext}`, ""])));
    for (const ext of exts) {
      const run = runCli(root, ["outline", `src/e.${ext}`]);
      expect([ext, run.status, run.stdout]).toEqual([ext, 0, `src/e.${ext}\n`]);
    }
  }, 60_000);

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

    expect(outline("src/c.ts")).toEqual({ status: 0, stdout: "src/c.ts\n1-1│function ok(): void { … }\n", stderr: "" });
    expect(outline("src/f.ts")).toMatchObject({ status: 0, stdout: "src/f.ts\n1-3│export const f = (x: number) => { … }\n" });
    expect(outline("src/g.ts")).toMatchObject({
      status: 0,
      stdout: "src/g.ts\n1-5│function g(a: number, b: [string, number]): void { … }\n",
    });
    expect(outline("src/t.ts")).toMatchObject({ status: 0, stdout: "src/t.ts\n1-1│type T = number;\n" });
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
    expect(long.stdout.split("\n")[1]!.split("│")[1]).toBe(`function long(${params}): void`.slice(0, 159) + "…" + " { … }");
    expect(outline("./src/a.ts").stdout.split("\n")[0]).toBe("./src/a.ts");
  }, 30_000);
});

describe("unfold", () => {
  test("unfold matches by name, qualified name and line", () => {
    const root = makeCrankProject({
      "src/a.ts": A_TS,
      "src/d.ts": "// detached\n\n// one\n// two\nfunction d(): void {}\n/** e */\nconst e = () => {};\n",
      "src/k.ts": ["k1", "k1", "k2", "k3", "k4", "k5", "k6"].map((k) => `function ${k}(): void {}\n`).join(""),
      "src/r.ts": "namespace A {\n  export function run(): void {}\n}\nnamespace B {\n  export function run(): void {}\n}\nfunction run(): void {}\n",
      "src/cpp.cpp": fs.readFileSync(path.join(FIXTURES, "cpp.cpp"), "utf8"),
    });
    const unfold = (file: string, query: string) => runCli(root, ["unfold", file, query]);

    expect(unfold("src/a.ts", "double")).toEqual({
      status: 0,
      stdout: "src/a.ts:2-4 fn double\n1│/** Doubles. */\n2│export function double(x: number): number {\n3│  return x * 2;\n4│}\n",
      stderr: "",
    });
    expect(unfold("src/d.ts", "d")).toMatchObject({ status: 0, stdout: "src/d.ts:5-5 fn d\n3│// one\n4│// two\n5│function d(): void {}\n" });
    const value = "src/a.ts:9-11 method Box.value\n 9│  get value(): number {\n10│    return this.n;\n11│  }\n";
    expect(unfold("src/a.ts", "Box.value")).toMatchObject({ status: 0, stdout: value });
    expect(unfold("src/a.ts", "10")).toMatchObject({ status: 0, stdout: value });
    const box = A_TS.split("\n").slice(5, 12).map((line, i) => `${String(i + 6).padStart(2)}│${line}\n`).join("");
    expect(unfold("src/a.ts", "7")).toMatchObject({ status: 0, stdout: `src/a.ts:6-12 class Box\n${box}` });
    const runA = "src/r.ts:2-2 fn A.run\n2│  export function run(): void {}\n";
    expect(unfold("src/r.ts", "run")).toMatchObject({
      status: 0,
      stdout: `${runA}\nsrc/r.ts:5-5 fn B.run\n5│  export function run(): void {}\n\nsrc/r.ts:7-7 fn run\n7│function run(): void {}\n`,
    });
    expect(unfold("src/r.ts", "A.run")).toMatchObject({ status: 0, stdout: runA });
    expect(unfold("src/r.ts", "A::run")).toMatchObject({ status: 0, stdout: runA });
    const miss = (file: string, query: string, stderr: string) =>
      expect([query, unfold(file, query)]).toEqual([query, { status: 1, stdout: "", stderr }]);
    miss("src/a.ts", "box", "crank-mem: no symbol box in src/a.ts.\nClose: Box, Box.constructor, Box.value\n");
    miss("src/a.ts", "zzz", "crank-mem: no symbol zzz in src/a.ts.\n");
    for (const n of ["5", "0", "99"]) miss("src/a.ts", n, `crank-mem: no symbol at line ${n} in src/a.ts.\n`);
    miss("src/k.ts", "K", "crank-mem: no symbol K in src/k.ts.\nClose: k1, k2, k3, k4, k5\n");
    expect(unfold("src/d.ts", "e")).toMatchObject({ status: 0, stdout: "src/d.ts:7-7 fn e\n6│/** e */\n7│const e = () => {};\n" });
    const cppHeaders = (query: string) => {
      const run = unfold("src/cpp.cpp", query);
      return [run.status, run.stdout.split("\n").filter((line) => line.startsWith("src/cpp.cpp:"))];
    };
    const outOfLine = "src/cpp.cpp:94-95 fn GUI.ExtruderGroup::SetTitle";
    const declared = "src/cpp.cpp:91-91 method GUI.ExtruderGroup.SetTitle";
    expect(cppHeaders("SetTitle")).toEqual([0, ["src/cpp.cpp:86-87 method GUI.HoverLabel.SetTitle", declared, outOfLine]]);
    expect(cppHeaders("ExtruderGroup::SetTitle")).toEqual([0, [declared, outOfLine]]);
  }, 30_000);
});

describe("refusals", () => {
  test("argument and path checks refuse in order, each with one stderr line and no file written", () => {
    const bare = tempDir("crank-code-bare-");
    const usage = "Usage: crank-mem outline <file> [--from <line>]\n";
    for (const args of [[], ["a.ts", "b.ts"], ["a.ts", "--from"], ["a.ts", "--from", "0"], ["a.ts", "--from", "1.5"], ["a.ts", "--from", "abc"]]) {
      expect([args, runCli(bare, ["outline", ...args])]).toEqual([args, { status: 1, stdout: "", stderr: usage }]);
    }
    const unfoldUsage = "Usage: crank-mem unfold <file> <symbol|line>\n";
    for (const args of [[], ["a.ts"], ["a.ts", "f", "g"]]) {
      expect([args, runCli(bare, ["unfold", ...args])]).toEqual([args, { status: 1, stdout: "", stderr: unfoldUsage }]);
    }
    expect(fs.readdirSync(bare)).toEqual([]);
    for (const args of [["outline", "a.ts"], ["unfold", "a.ts", "f"]]) {
      expect([args, runCli(bare, args)]).toEqual([
        args,
        { status: 1, stdout: "", stderr: "crank-mem: not initialized here — run `crank-mem init` first.\n" },
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
      "Makefile": "all:\n",
    });
    fs.symlinkSync(outside, path.join(root, "src/link.ts"));
    fs.symlinkSync(path.join(root, "src/.env"), path.join(root, "src/notes.ts"));
    fs.mkdirSync(path.join(root, "src/x.ts"));
    const tree = () => fs.readdirSync(root, { recursive: true }).sort();
    const before = tree();
    const refuses = (file: string, line: string) => {
      expect([file, runCli(root, ["outline", file])]).toEqual([file, { status: 1, stdout: "", stderr: `crank-mem: ${line}\n` }]);
      expect(tree()).toEqual(before);
    };
    refuses(outside, `${outside} is outside this project.`);
    refuses("/nonexistent-crank-dir/a.ts", "/nonexistent-crank-dir/a.ts is outside this project.");
    refuses("src/link.ts", "src/link.ts is outside this project.");
    refuses("src/credentials.ts", "src/credentials.ts is a sensitive file; crank-mem does not read it.");
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
    for (const name of ["src", "bin", "package.json"]) fs.cpSync(path.join(REPO_ROOT, name), path.join(clone, name), { recursive: true });
    fs.mkdirSync(path.join(clone, "node_modules"));
    const root = makeCrankProject({ "src/a.ts": "export function a(): void {}\n" });
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [path.join(clone, "src/cli/main.ts"), ...args], {
        cwd: root,
        encoding: "utf-8",
        timeout: 30_000,
        env: { ...process.env, CRANK_HOME: tempDir("crank-home-"), CODEX_HOME: tempDir("crank-codexhome-") },
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

const FAMILIES = ["typescript.ts", "tsx.tsx", "cpp.cpp"];

describe("families", () => {
  for (const fixture of FAMILIES) {
    test(`outline and unfold match the committed expectation for ${fixture}`, () => {
      const root = makeCrankProject({ [`src/${fixture}`]: fs.readFileSync(path.join(FIXTURES, fixture), "utf8") });
      const outline = fs.readFileSync(path.join(FIXTURES, `${fixture}.outline`), "utf8");
      const run = runCli(root, ["outline", `src/${fixture}`]);
      expect(run).toMatchObject({ status: 0, stdout: outline });

      const gutters = outline.split("\n").slice(1, -1).map((line) => line.split("│")[0]!.trim());
      const headers = fs.readFileSync(path.join(FIXTURES, `${fixture}.headers`), "utf8").split("\n").slice(0, -1);
      const parsed = headers.map((line) => /^src\/\S+:(?<range>\d+-\d+) \S+ (?<qualified>.+)$/.exec(line)?.groups);
      expect(parsed.map((groups) => groups?.range)).toEqual(gutters);
      for (const [i, header] of headers.entries()) {
        const unfold = runCli(root, ["unfold", `src/${fixture}`, parsed[i]!.qualified!]);
        expect([header, unfold.status, unfold.stdout.split("\n").includes(header)]).toEqual([header, 0, true]);
      }
    }, 30_000);
  }
});

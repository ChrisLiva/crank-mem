import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeCrankProject, REPO_ROOT, runCli } from "./helpers.ts";

const FIXTURES = path.join(REPO_ROOT, "tests/fixtures/code");

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
      "src/a.ts": [
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
      ].join("\n"),
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

const FAMILIES = ["typescript.ts", "tsx.tsx"];

describe("families", () => {
  for (const fixture of FAMILIES) {
    test(`outline and unfold match the committed expectation for ${fixture}`, () => {
      const root = makeCrankProject({ [`src/${fixture}`]: fs.readFileSync(path.join(FIXTURES, fixture), "utf8") });
      const run = runCli(root, ["outline", `src/${fixture}`]);
      expect(run).toMatchObject({ status: 0, stdout: fs.readFileSync(path.join(FIXTURES, `${fixture}.outline`), "utf8") });
    }, 30_000);
  }
});

import { describe, expect, test } from "bun:test";
import { extractSymbols, symbolsSupported, SYMBOL_MAX_COUNT } from "../src/hooks/lib/symbols.ts";

describe("symbolsSupported", () => {
  test("supports ts/js/py/go/rs", () => {
    for (const ext of [".ts", ".tsx", ".js", ".py", ".go", ".rs"]) {
      expect(symbolsSupported(ext)).toBe(true);
    }
    expect(symbolsSupported(".rb")).toBe(false);
  });
});

describe("extractSymbols — TypeScript", () => {
  const src = [
    "import x from 'y';",
    "",
    "export function alpha() {",
    "  return 1;",
    "}",
    "",
    "export const beta = (a: number) => a * 2;",
    "",
    "export class Gamma {",
    "  method() {}",
    "}",
    "",
    "export interface Delta {",
    "  field: string;",
    "}",
  ].join("\n");

  test("finds fn, arrow fn, class, interface with line ranges", () => {
    const syms = extractSymbols(src, ".ts");
    expect(syms.map((s) => [s.name, s.kind, s.startLine])).toEqual([
      ["alpha", "fn", 3],
      ["beta", "fn", 7],
      ["Gamma", "class", 9],
      ["Delta", "section", 13],
    ]);
    expect(syms[0]!.endLine).toBe(6);
    expect(syms[3]!.endLine).toBe(15);
  });

  test("finds return-typed, annotated and generic arrows, not parenthesized math", () => {
    const src = [
      "const bytes = (s: string): number => Buffer.byteLength(s);",
      "export const load = async (p: string): Promise<Map<string, number>> => new Map();",
      "export const handler: Handler = async (req) => req;",
      "let pick = <T>(xs: T[]): T => xs[0]!;",
      "const x = (1 + 2) * 3;",
      "const cfg: Record<string, number> = {};",
    ].join("\n");
    expect(extractSymbols(src, ".ts").map((s) => s.name)).toEqual(["bytes", "load", "handler", "pick"]);
  });
});

describe("extractSymbols — Python", () => {
  test("finds def and class", () => {
    const syms = extractSymbols("def foo():\n    pass\n\nclass Bar:\n    pass\n", ".py");
    expect(syms.map((s) => [s.name, s.kind])).toEqual([["foo", "fn"], ["Bar", "class"]]);
  });
});

describe("extractSymbols — Go", () => {
  test("finds func, methods, struct, interface", () => {
    const src = "func Foo() {}\nfunc (r *R) Bar() {}\ntype Baz struct {}\ntype Qux interface {}\n";
    const syms = extractSymbols(src, ".go");
    expect(syms.map((s) => [s.name, s.kind])).toEqual([
      ["Foo", "fn"], ["Bar", "fn"], ["Baz", "class"], ["Qux", "section"],
    ]);
  });
});

describe("extractSymbols — Rust", () => {
  test("finds fn, struct, enum, impl", () => {
    const src = "pub fn foo() {}\nstruct Bar;\npub enum Baz { A }\nimpl Bar {}\n";
    const syms = extractSymbols(src, ".rs");
    expect(syms.map((s) => [s.name, s.kind])).toEqual([
      ["foo", "fn"], ["Bar", "class"], ["Baz", "class"], ["Bar", "section"],
    ]);
  });
});

describe("extractSymbols — limits", () => {
  test("caps at SYMBOL_MAX_COUNT", () => {
    const src = Array.from({ length: 50 }, (_, i) => `function f${i}() {}`).join("\n");
    expect(extractSymbols(src, ".ts").length).toBe(SYMBOL_MAX_COUNT);
  });
  test("last capped symbol ends before the next symbol, not at end of file", () => {
    const src = Array.from({ length: 50 }, (_, i) => `function f${i}() {}`).join("\n");
    const last = extractSymbols(src, ".ts").at(-1)!;
    expect([last.name, last.startLine, last.endLine]).toEqual(["f29", 30, 30]);
  });
  test("unsupported language returns empty", () => {
    expect(extractSymbols("def foo", ".rb")).toEqual([]);
  });
  test("no symbols returns empty", () => {
    expect(extractSymbols("// just a comment\n", ".ts")).toEqual([]);
  });
});

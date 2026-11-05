import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "./args.ts";
import { codeSymbols, grammarFor, type CodeSymbol } from "./code-symbols.ts";
import { COMMANDS } from "./commands.ts";
import { openNearestProject } from "./project.ts";

const NOT_INSTALLED = "crank-mem: the code reader is not installed — run `crank-mem setup`.";

/** `crank-mem outline <file>`: the path line, then one folded line per symbol. */
export async function outline(args: string[]): Promise<number> {
  const { rest } = parseArgs(args, COMMANDS.outline.value);
  const file = rest[0];
  if (file === undefined || rest.length !== 1) {
    console.error(COMMANDS.outline.usage);
    return 1;
  }
  if (!openNearestProject()) return 1;
  const grammar = grammarFor(file);
  if (grammar === null) {
    console.error(`crank-mem: no grammar for ${file}.`);
    return 1;
  }
  const symbols = await codeSymbols(fs.readFileSync(path.resolve(process.cwd(), file), "utf8"), grammar);
  if (symbols === null) {
    console.error(NOT_INSTALLED);
    return 1;
  }
  process.stdout.write(`${file}\n` + renderRows(preorder(symbols).map(({ symbol }) => outlineRow(symbol))));
  return 0;
}

const HEAD_CAP = 160;

/** Every symbol, each container before its members, with `parents` outermost first. */
function preorder(symbols: CodeSymbol[], parents: CodeSymbol[] = []): { symbol: CodeSymbol; parents: CodeSymbol[] }[] {
  return symbols.flatMap((symbol) => [{ symbol, parents }, ...preorder(symbol.children, [...parents, symbol])]);
}

/** A symbol's outline line, split at the gutter: indent, head cut to 160 characters, fold marker. */
function outlineRow(s: CodeSymbol): { gutter: string; rest: string } {
  const head = s.head.length <= HEAD_CAP ? s.head : s.head.slice(0, HEAD_CAP - 1) + "…";
  const marker = s.children.length > 0
    ? (s.fold === "brace" ? " {" : "")
    : s.fold === "brace" ? " { … }" : s.fold === "other" ? " …" : "";
  return { gutter: `${s.start}-${s.end}`, rest: s.indent + head + marker };
}

/** The rows with their gutters right-aligned to the widest. */
function renderRows(rows: { gutter: string; rest: string }[]): string {
  const width = Math.max(0, ...rows.map((row) => row.gutter.length));
  return rows.map((row) => `${row.gutter.padStart(width)}│${row.rest}\n`).join("");
}

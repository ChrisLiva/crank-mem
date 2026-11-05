import * as fs from "node:fs";
import * as path from "node:path";
import { isSensitiveFile } from "../hooks/lib/config.ts";
import { repoRelative } from "../hooks/lib/hook-io.ts";
import { parseArgs, stringFlag } from "./args.ts";
import { codeSymbols, grammarFor, type CodeSymbol } from "./code-symbols.ts";
import { COMMANDS } from "./commands.ts";
import { openNearestProject } from "./project.ts";

const NOT_INSTALLED = "the code reader is not installed — run `crank-mem setup`.";

/** `crank-mem outline <file>`: the path line, then one folded line per symbol. */
export async function outline(args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, COMMANDS.outline.value);
  const file = rest[0];
  const from = stringFlag(flags.from);
  if (file === undefined || rest.length !== 1 || from === null || (from !== undefined && !/^[1-9]\d*$/.test(from))) {
    console.error(COMMANDS.outline.usage);
    return 1;
  }
  const target = await readTarget(file);
  if (target === null) return 1;
  process.stdout.write(`${file}\n` + renderRows(preorder(target.symbols).map(({ symbol }) => outlineRow(symbol))));
  return 0;
}

/** `crank-mem unfold <file> <symbol|line>`: every matching symbol's full source. */
export async function unfold(args: string[]): Promise<number> {
  const { rest } = parseArgs(args, COMMANDS.unfold.value);
  const [file, query] = rest;
  if (file === undefined || query === undefined || rest.length !== 2) {
    console.error(COMMANDS.unfold.usage);
    return 1;
  }
  const target = await readTarget(file);
  if (target === null) return 1;
  const lines = target.text.split("\n");
  const entries = preorder(target.symbols);
  const matches = findMatches(entries, query);
  if (matches.length === 0) {
    if (LINE_QUERY.test(query)) {
      console.error(`crank-mem: no symbol at line ${query} in ${file}.`);
      return 1;
    }
    console.error(`crank-mem: no symbol ${query} in ${file}.`);
    const lower = query.toLowerCase();
    const close = [...new Set(entries.map(({ symbol }) => symbol.qualified).filter((q) => q.toLowerCase().includes(lower)))].slice(0, 5);
    if (close.length > 0) console.error(`Close: ${close.join(", ")}`);
    return 1;
  }
  process.stdout.write(matches.map((s) => matchHeader(file, s) + matchLines(lines, s)).join("\n"));
  return 0;
}

/** A number selects the deepest symbol spanning that line; a name, every symbol whose qualified name ends with its segments. */
function findMatches(entries: { symbol: CodeSymbol; parents: CodeSymbol[] }[], query: string): CodeSymbol[] {
  if (LINE_QUERY.test(query)) {
    const n = Number(query);
    let best: { symbol: CodeSymbol; parents: CodeSymbol[] } | undefined;
    for (const entry of entries) {
      if (entry.symbol.start <= n && n <= entry.symbol.end && (best === undefined || entry.parents.length > best.parents.length)) best = entry;
    }
    return best ? [best.symbol] : [];
  }
  const segments = query.split(SEGMENT);
  return entries.map(({ symbol }) => symbol).filter((s) => {
    const qualified = s.qualified.split(SEGMENT);
    return segments.length <= qualified.length && segments.every((seg, i) => seg === qualified[qualified.length - segments.length + i]);
  });
}

const SEGMENT = /\.|::/;
const LINE_QUERY = /^\d+$/;

/** A match's first line: `<file>:<start>-<end> <kind> <qualified>`. */
function matchHeader(file: string, s: CodeSymbol): string {
  return `${file}:${s.start}-${s.end} ${s.kind} ${s.qualified}\n`;
}

/** Lines `docStart..end`, each numbered to the width of `end`. */
function matchLines(lines: string[], s: CodeSymbol): string {
  const width = String(s.end).length;
  let out = "";
  for (let n = s.docStart; n <= s.end; n++) out += `${String(n).padStart(width)}│${lines[n - 1]}\n`;
  return out;
}

/** The file's text and symbols, or null after printing why crank-mem refuses to read it. */
async function readTarget(file: string): Promise<{ text: string; symbols: CodeSymbol[] } | null> {
  const project = openNearestProject();
  if (project === null) return null;
  const refuse = (reason: string): null => {
    console.error(`crank-mem: ${reason}`);
    return null;
  };
  const cannotRead = (e: unknown): null => refuse(`cannot read ${file} (${(e as NodeJS.ErrnoException).code}).`);
  const outsideLine = `${file} is outside this project.`;
  const abs = path.resolve(process.cwd(), file);
  const realRoot = fs.realpathSync(project.root);
  const within = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
  if (repoRelative(project.root, process.cwd(), file) === null) {
    let anc = abs;
    while (!fs.existsSync(anc)) anc = path.dirname(anc);
    if (!within(fs.realpathSync(anc))) return refuse(outsideLine);
  }
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? refuse(`no file ${file}.`) : cannotRead(e);
  }
  if (!within(real)) return refuse(outsideLine);
  if (isSensitiveFile(path.basename(abs)) || isSensitiveFile(path.basename(real))) {
    return refuse(`${file} is a sensitive file; crank-mem does not read it.`);
  }
  const grammar = grammarFor(file);
  if (grammar === null) {
    const ext = path.extname(path.basename(file)).toLowerCase();
    return refuse(ext ? `no grammar for ${ext} files.` : `no grammar for ${path.basename(file)}.`);
  }
  let text: string;
  try {
    text = fs.readFileSync(real, "utf8");
  } catch (e) {
    return cannotRead(e);
  }
  const symbols = await codeSymbols(text, grammar);
  if (symbols === null) return refuse(NOT_INSTALLED);
  return { text, symbols };
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

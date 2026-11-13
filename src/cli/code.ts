import * as fs from "node:fs";
import * as path from "node:path";
import { isSensitiveFile } from "../hooks/lib/config.ts";
import { ownerOf } from "../hooks/lib/owner.ts";
import { cliActor, recordUsage, type CodeOutcome } from "../hooks/lib/usage.ts";
import { parseArgs, stringFlag } from "./args.ts";
import { codeSymbols, grammarFor, type CodeSymbol } from "./code-symbols.ts";
import { COMMANDS } from "./commands.ts";

const NOT_INSTALLED = "the code reader is not installed — run `crank-mem setup`.";

/** `crank-mem outline <file>`: the path line, then one folded line per symbol. */
export async function outline(args: string[]): Promise<number> {
  const started = Date.now();
  const { flags, rest } = parseArgs(args, COMMANDS.outline.value);
  const file = rest[0];
  const from = stringFlag(flags.from);
  if (
    file === undefined ||
    rest.length !== 1 ||
    from === null ||
    (from !== undefined && !/^[1-9]\d*$/.test(from))
  ) {
    console.error(COMMANDS.outline.usage);
    return 1;
  }
  const target = await readTarget(file);
  if (target === null) return 1;
  const page =
    target.outcome === "ok"
      ? outlinePage(file, preorder(target.symbols), from === undefined ? 1 : Number(from))
      : { text: "", listed: 0, capped: false };
  process.stdout.write(page.text);
  recordUsage(target.root, cliActor(), {
    channel: "outline",
    path: target.path,
    from: from === undefined ? null : Number(from),
    matches: page.listed,
    chars: page.text.length,
    capped: page.capped,
    outcome: target.outcome,
    ms: Date.now() - started,
  });
  return target.outcome === "ok" ? 0 : 1;
}

const CAP = 25_000;

/**
 * The outline page from line `n`: whole runs of equal-start rows while they and the continuation
 * line fit under CAP, with the number of symbol rows it lists after its context rows and whether
 * CAP cut it.
 */
export function outlinePage(
  file: string,
  entries: { symbol: CodeSymbol; parents: CodeSymbol[] }[],
  n: number,
): { text: string; listed: number; capped: boolean } {
  const head = `${file}\n`;
  const first = entries.findIndex(({ symbol }) => symbol.start >= n);
  if (first === -1) return { text: head, listed: 0, capped: false };
  const listed = entries.slice(first);
  const ctx = listed[0]!.parents.filter((p) => p.start < n).map(outlineRow);
  const rows = listed.map(({ symbol }) => outlineRow(symbol));
  const cont = (i: number) => {
    if (i >= listed.length) return "";
    const s = listed[i]!.symbol.start;
    return `… ${listed.length - i} more symbols from L${s}: crank-mem outline ${file} --from ${s}\n`;
  };
  const page = (count: number, extra: string) => ({
    text: head + renderRows([...ctx, ...rows.slice(0, count)]) + extra,
    listed: count,
    capped: count < listed.length,
  });
  let chosen = new RowsSize(ctx);
  let i = 0;
  while (i < listed.length) {
    let j = i;
    const grown = chosen.copy();
    while (j < listed.length && listed[j]!.symbol.start === listed[i]!.symbol.start)
      grown.add(rows[j++]!);
    if (head.length + grown.length + cont(j).length <= CAP) {
      chosen = grown;
      i = j;
      continue;
    }
    if (i > 0) return page(i, cont(i));
    return page(
      prefixFitting(new RowsSize(ctx), rows.slice(0, j), CAP - head.length - cont(j).length),
      cont(j),
    );
  }
  return page(listed.length, "");
}

/** `crank-mem unfold <file> <symbol|line>`: every matching symbol's full source. */
export async function unfold(args: string[]): Promise<number> {
  const started = Date.now();
  const { rest } = parseArgs(args, COMMANDS.unfold.value);
  const [file, query] = rest;
  if (file === undefined || !query || rest.length !== 2) {
    console.error(COMMANDS.unfold.usage);
    return 1;
  }
  const target = await readTarget(file);
  if (target === null) return 1;
  const shown = target.outcome === "ok" ? showMatches(file, query, target) : null;
  const printed = shown ?? { text: "", matches: 0, capped: false };
  process.stdout.write(printed.text);
  recordUsage(target.root, cliActor(), {
    channel: "unfold",
    path: target.path,
    symbol: query,
    matches: printed.matches,
    chars: printed.text.length,
    capped: printed.capped,
    outcome: target.outcome === "ok" && shown === null ? "not-found" : target.outcome,
    ms: Date.now() - started,
  });
  return shown === null ? 1 : 0;
}

/** Every match of `query` capped under CAP, or null after printing that none matched. */
function showMatches(
  file: string,
  query: string,
  target: { text: string; symbols: CodeSymbol[] },
): { text: string; matches: number; capped: boolean } | null {
  const lines = target.text.split("\n");
  const entries = preorder(target.symbols);
  const matches = findMatches(entries, query);
  if (matches.length === 0) {
    if (LINE_QUERY.test(query)) {
      console.error(`crank-mem: no symbol at line ${query} in ${file}.`);
      return null;
    }
    console.error(`crank-mem: no symbol ${query} in ${file}.`);
    const lower = query.toLowerCase();
    const close = [
      ...new Set(
        entries
          .map(({ symbol }) => symbol.qualified)
          .filter((q) => q.toLowerCase().includes(lower)),
      ),
    ].slice(0, 5);
    if (close.length > 0) console.error(`Close: ${close.join(", ")}`);
    return null;
  }
  return { ...cappedMatches(file, lines, matches), matches: matches.length };
}

/**
 * Whole matches while they fit under CAP, folding a first match too long to print; the rest by
 * header while those fit. `capped` is true when CAP folded or dropped a match.
 */
function cappedMatches(
  file: string,
  lines: string[],
  matches: CodeSymbol[],
): { text: string; capped: boolean } {
  const n = matches.length;
  const header = (i: number) => matchHeader(file, matches[i]!);
  const more = (j: number) => `… ${j} more matches.\n`;
  const past = (k: number) => `… ${k} matches past the cap, by header:\n`;
  const reserve = (i: number) =>
    i + 1 < n
      ? past(n - i - 1).length + header(i + 1).length + (i + 2 < n ? more(n - i - 2).length : 0)
      : 0;
  let out = "";
  let i = 0;
  for (; i < n; i++) {
    const piece = (i > 0 ? "\n" : "") + header(i) + matchLines(lines, matches[i]!);
    if (out.length + piece.length + reserve(i) > CAP) break;
    out += piece;
  }
  const capped = i < n;
  if (i === 0 && n > 0) {
    const s = matches[0]!;
    const tooLong = `… L${s.start}-${s.end} is too long to print whole: read a slice by line range, or run crank-mem outline ${file} --from ${s.start}.\n`;
    const budget = CAP - header(0).length - tooLong.length - reserve(0);
    const rows = preorder([s]).map(({ symbol }) => outlineRow(symbol));
    out =
      header(0) + renderRows(rows.slice(0, prefixFitting(new RowsSize(), rows, budget))) + tooLong;
    i = 1;
  }
  if (i < n) {
    out += past(n - i);
    let j = i;
    while (j < n && out.length + header(j).length + (j + 1 < n ? more(n - j - 1).length : 0) <= CAP)
      out += header(j++);
    if (j < n) out += more(n - j);
  }
  return { text: out, capped };
}

/** A number selects the deepest symbol spanning that line; a name, every symbol whose qualified name ends with its segments. */
function findMatches(
  entries: { symbol: CodeSymbol; parents: CodeSymbol[] }[],
  query: string,
): CodeSymbol[] {
  if (LINE_QUERY.test(query)) {
    const n = Number(query);
    let best: { symbol: CodeSymbol; parents: CodeSymbol[] } | undefined;
    for (const entry of entries) {
      if (
        entry.symbol.start <= n &&
        n <= entry.symbol.end &&
        (best === undefined || entry.parents.length > best.parents.length)
      )
        best = entry;
    }
    return best ? [best.symbol] : [];
  }
  const segments = query.split(SEGMENT);
  return entries
    .map(({ symbol }) => symbol)
    .filter((s) => {
      const qualified = s.qualified.split(SEGMENT);
      return (
        segments.length <= qualified.length &&
        segments.every((seg, i) => seg === qualified[qualified.length - segments.length + i])
      );
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

type Target = { root: string; path: string } & (
  | { outcome: "ok"; text: string; symbols: CodeSymbol[] }
  | { outcome: Exclude<CodeOutcome, "ok"> }
);

/**
 * The file's text and symbols, or the refusal it took after printing why crank-mem refuses to
 * read it. Null, after printing why, when no installed project owns the file.
 */
async function readTarget(file: string): Promise<Target | null> {
  const owner = ownerOf(path.resolve(process.cwd(), file));
  if (owner.kind === "unowned") {
    console.error(`crank-mem: ${file} is outside every installed project.`);
    return null;
  }
  const at = { root: owner.root, path: owner.rel.split(path.sep).join("/") };
  const refuse = (reason: string, outcome: Exclude<CodeOutcome, "ok">): Target => {
    console.error(`crank-mem: ${reason}`);
    return { ...at, outcome };
  };
  const cannotRead = (e: unknown): Target =>
    refuse(`cannot read ${file} (${(e as NodeJS.ErrnoException).code}).`, "refused");
  const within = owner.kind === "worktree" ? owner.top : owner.root;
  const real = checkedPath(file, within, refuse, cannotRead);
  if (typeof real !== "string") return real;
  const grammar = grammarFor(file);
  if (grammar === null) {
    const ext = path.extname(path.basename(file)).toLowerCase();
    return refuse(
      ext ? `no grammar for ${ext} files.` : `no grammar for ${path.basename(file)}.`,
      "no-reader",
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(real, "utf8");
  } catch (e) {
    return cannotRead(e);
  }
  const symbols = await codeSymbols(text, grammar);
  if (symbols === null) return refuse(NOT_INSTALLED, "no-reader");
  return { ...at, outcome: "ok", text, symbols };
}

/**
 * `file`'s real path once it passes the existence, outside (real path under `within`'s) and
 * sensitive checks, in that order, or the refusal the first failing check took.
 */
function checkedPath(
  file: string,
  within: string,
  refuse: (reason: string, outcome: Exclude<CodeOutcome, "ok">) => Target,
  cannotRead: (e: unknown) => Target,
): string | Target {
  const outsideLine = `${file} is outside this project.`;
  const abs = path.resolve(process.cwd(), file);
  const realRoot = fs.realpathSync(within);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? refuse(`no file ${file}.`, "not-found")
      : cannotRead(e);
  }
  if (!inside(real)) return refuse(outsideLine, "refused");
  if (isSensitiveFile(path.basename(abs)) || isSensitiveFile(path.basename(real))) {
    return refuse(`${file} is a sensitive file; crank-mem does not read it.`, "refused");
  }
  return real;
}

const HEAD_CAP = 160;

/** Every symbol, each container before its members, with `parents` outermost first. */
export function preorder(
  symbols: CodeSymbol[],
  parents: CodeSymbol[] = [],
): { symbol: CodeSymbol; parents: CodeSymbol[] }[] {
  return symbols.flatMap((symbol) => [
    { symbol, parents },
    ...preorder(symbol.children, [...parents, symbol]),
  ]);
}

/** A symbol's outline line, split at the gutter: indent, head cut to HEAD_CAP, fold marker. */
function outlineRow(s: CodeSymbol): { gutter: string; rest: string } {
  const head = s.head.length <= HEAD_CAP ? s.head : s.head.slice(0, HEAD_CAP - 1) + "…";
  const marker =
    s.children.length > 0
      ? s.fold === "brace"
        ? " {"
        : ""
      : s.fold === "brace"
        ? " { … }"
        : s.fold === "other"
          ? " …"
          : "";
  return { gutter: `${s.start}-${s.end}`, rest: s.indent + head + marker };
}

/** The running length of rows as renderRows prints them. */
class RowsSize {
  private count = 0;
  private rest = 0;
  private width = 0;

  constructor(rows: { gutter: string; rest: string }[] = []) {
    for (const row of rows) this.add(row);
  }

  add(row: { gutter: string; rest: string }): this {
    this.count += 1;
    this.rest += row.rest.length;
    this.width = Math.max(this.width, row.gutter.length);
    return this;
  }

  copy(): RowsSize {
    return Object.assign(new RowsSize(), this);
  }

  get length(): number {
    return this.count * (this.width + 2) + this.rest;
  }
}

/** How many of `rows`, from the first, fit within `budget` printed after the rows `size` already holds. */
function prefixFitting(
  size: RowsSize,
  rows: { gutter: string; rest: string }[],
  budget: number,
): number {
  let p = 0;
  while (p < rows.length && size.copy().add(rows[p]!).length <= budget) size.add(rows[p++]!);
  return p;
}

/** The rows with their gutters right-aligned to the widest. */
function renderRows(rows: { gutter: string; rest: string }[]): string {
  const width = Math.max(0, ...rows.map((row) => row.gutter.length));
  return rows.map((row) => `${row.gutter.padStart(width)}│${row.rest}\n`).join("");
}

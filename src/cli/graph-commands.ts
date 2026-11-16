import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import {
  calleesOf,
  callersOf,
  findSymbols,
  similarSymbols,
  symbolSets,
  type Site,
  type SymbolRow,
} from "../hooks/lib/code-graph.ts";
import {
  filesUnder,
  openCodeDb,
  pendingCount,
  pendingPaths,
  type FileRow,
} from "../hooks/lib/code-db.ts";
import { CRANK_DIR, loadConfig } from "../hooks/lib/config.ts";
import { toPosix } from "../hooks/lib/indexable.ts";
import { ownerOf } from "../hooks/lib/owner.ts";
import { parseArgs, stringFlag } from "./args.ts";
import { CAP, checkedPath } from "./code.ts";
import { refreshGraph } from "./code-parse.ts";
import { COMMANDS } from "./commands.ts";

// The graph commands over .crank/code.db: each opens the store, brings its file facts current
// within COMMAND_REFRESH_MS and answers from it.

/** How long a command spends bringing the store current before it answers. */
export const COMMAND_REFRESH_MS = 10_000;
/** How long a command waits on another process's write lock. */
const BUSY_MS = 2000;

/** `crank-mem anatomy [<dir>] [--from <path>]`: one entry per file, in path order, a page at a time. */
export async function anatomy(args: string[]): Promise<number> {
  const started = Date.now();
  const { flags, rest } = parseArgs(args, COMMANDS.anatomy.value);
  const from = stringFlag(flags.from);
  if (rest.length > 1 || from === null) {
    console.error(COMMANDS.anatomy.usage);
    return 1;
  }
  const scope = commandScope(rest[0] ?? ".");
  if (scope === null) return 1;
  const db = await refreshedStore(scope.root, started + COMMAND_REFRESH_MS);
  if (db === null) return 1;
  try {
    const rows = filesUnder(db, scope.prefix, from);
    const pending = pendingPaths(db);
    process.stdout.write(anatomyPage(rows, pending, rest[0] ?? "", pending.size, symbolLines(db)));
    return 0;
  } finally {
    db.close();
  }
}

/** The project that owns `target` and its path inside it, or null after printing why crank-mem refuses it. */
function commandScope(target: string): { root: string; prefix: string } | null {
  const owner = ownerOf(path.resolve(process.cwd(), target));
  if (owner.kind === "unowned") {
    console.error(`crank-mem: ${target} is outside every installed project.`);
    return null;
  }
  const refused = (reason: string) => {
    console.error(`crank-mem: ${reason}`);
    return { root: owner.root, path: toPosix(owner.rel), outcome: "refused" as const };
  };
  const within = owner.kind === "worktree" ? owner.top : owner.root;
  const real = checkedPath(target, within, refused, (e) =>
    refused(`cannot read ${target} (${(e as NodeJS.ErrnoException).code}).`),
  );
  if (typeof real !== "string") return null;
  return { root: owner.root, prefix: toPosix(owner.rel) };
}

/**
 * The store brought current by `deadlineMs`, opened to read. A store the file system will not let
 * this process write is read as it stands. Null, after printing why, when the store cannot be opened.
 */
async function refreshedStore(
  root: string,
  deadlineMs: number,
): Promise<sqlite.DatabaseSync | null> {
  const refreshed = await refreshGraph(root, loadConfig(path.join(root, CRANK_DIR)), {
    deadlineMs,
    busyMs: BUSY_MS,
  });
  const opened = refreshed.status === "unreadable" ? null : openCodeDb(root, "read", BUSY_MS);
  if (opened?.status === "open" && opened.db) return opened.db;
  console.error(
    `crank-mem: .crank/code.db is not readable (${refreshed.reason ?? opened?.reason ?? opened?.status}). Fix: crank-mem scan`,
  );
  return null;
}

/** A file's top-level symbols as indented entry lines, cut to CAP with a pointer to `outline` when a file has more. */
function symbolLines(db: sqlite.DatabaseSync): (rel: string) => string {
  const select = db.prepare(
    `SELECT name, kind, start_line, end_line, tokens FROM symbols
     WHERE path = ? AND parent_id IS NULL ORDER BY start_line, id`,
  );
  return (rel) => {
    const symbols = select.all(rel) as {
      name: string;
      kind: string;
      start_line: number;
      end_line: number;
      tokens: number;
    }[];
    let out = "";
    for (const [i, s] of symbols.entries()) {
      const line = `  - ${s.name} (${s.kind}, L${s.start_line}–L${s.end_line}, ~${s.tokens} tok)\n`;
      if (out.length + line.length > CAP) {
        return `${out}  … ${symbols.length - i} more symbols: crank-mem outline ${rel}\n`;
      }
      out += line;
    }
    return out;
  };
}

/** One page of entries under CAP; `pending` marks the files the code reader has yet to parse. */
function anatomyPage(
  rows: FileRow[],
  pending: Set<string>,
  dir: string,
  pendingTotal: number,
  symbolsOf: (rel: string) => string,
): string {
  const entryOf = (row: FileRow) =>
    `- \`${row.path}\`${row.description ? ` — ${row.description}` : ""} (~${row.tokens} tok)${pending.has(row.path) ? " (symbols pending)" : ""}\n${symbolsOf(row.path)}`;
  const more = (i: number) =>
    `… ${rows.length - i} more files from ${rows[i]!.path}: crank-mem anatomy${dir ? ` ${dir}` : ""} --from ${rows[i]!.path}\n`;
  const pendingLine = pendingTotal > 0 ? `(${pendingTotal} file(s) still pending parse)\n` : "";
  let out = "";
  let shown = 0;
  while (shown < rows.length) {
    const footer = shown + 1 < rows.length ? pendingLine + more(shown + 1) : pendingLine;
    const entry = entryOf(rows[shown]!);
    if (shown > 0 && out.length + entry.length + footer.length > CAP) break;
    out += entry;
    shown++;
  }
  return out + (shown < rows.length ? pendingLine + more(shown) : pendingLine);
}

/** `crank-mem callers [<file>] <symbol>`: the sites that call the symbol, then the sites that might. */
export function callers(args: string[]): Promise<number> {
  return symbolCommand("callers", args, callersReport);
}

/** `crank-mem callees [<file>] <symbol>`: the calls made inside the symbol, then the ones with no single definition. */
export function callees(args: string[]): Promise<number> {
  return symbolCommand("callees", args, calleesReport);
}

type Report = (db: sqlite.DatabaseSync, root: string, set: SymbolRow[]) => string;

async function symbolCommand(
  name: "callers" | "callees",
  args: string[],
  report: Report,
): Promise<number> {
  const started = Date.now();
  const { rest } = parseArgs(args, COMMANDS[name].value);
  if (rest.length < 1 || rest.length > 2 || rest.includes("")) {
    console.error(COMMANDS[name].usage);
    return 1;
  }
  const file = rest.length === 2 ? rest[0] : undefined;
  const symbol = rest.at(-1)!;
  const scope = commandScope(file ?? ".");
  if (scope === null) return 1;
  const db = await refreshedStore(scope.root, started + COMMAND_REFRESH_MS);
  if (db === null) return 1;
  try {
    const within = file === undefined ? null : scope.prefix;
    const set = chosenSymbol(db, symbol, within, file);
    if (set === null) return 1;
    process.stdout.write(report(db, scope.root, set) + pendingLine(db));
    return 0;
  } finally {
    db.close();
  }
}

/** The one symbol `symbol` names, or null after printing that it names none or several. */
function chosenSymbol(
  db: sqlite.DatabaseSync,
  symbol: string,
  within: string | null,
  file: string | undefined,
): SymbolRow[] | null {
  const query = within === null ? symbol : { file: within, symbol };
  const sets = symbolSets(findSymbols(db, query));
  if (sets.length === 1) return sets[0]!;
  if (sets.length === 0) {
    console.error(`crank-mem: no symbol ${symbol}${file === undefined ? "" : ` in ${file}`}.`);
    printClose(symbolSets(similarSymbols(db, symbol, within)));
  } else {
    console.error(`crank-mem: ${symbol} names ${sets.length} symbols.`);
    printClose(sets);
  }
  return null;
}

const CLOSE_LIMIT = 5;

/** Up to CLOSE_LIMIT symbols, each in the form the commands take as `<file> <symbol>`. */
function printClose(sets: SymbolRow[][]): void {
  if (sets.length === 0) return;
  const forms = sets.slice(0, CLOSE_LIMIT).map(([row]) => `${row!.path} ${row!.qualified}`);
  console.error(`Close: ${forms.join(", ")}`);
}

/** The shortest form of the symbol the commands take: its qualified name, or with its file when that is not unique. */
function pasteable(db: sqlite.DatabaseSync, row: SymbolRow): string {
  const unique = symbolSets(findSymbols(db, row.qualified)).length === 1;
  return unique ? row.qualified : `${row.path} ${row.qualified}`;
}

function pendingLine(db: sqlite.DatabaseSync): string {
  const pending = pendingCount(db);
  return pending > 0 ? `(${pending} file(s) still pending parse)\n` : "";
}

const TOP_LEVEL = "(top level)";
const GUTTER_MIN = 6;
const SOURCE_LINE_CAP = 200;

/** A call site's source line, trimmed and cut to SOURCE_LINE_CAP, read from the project's file. */
function sourceReader(root: string): (rel: string, line: number) => string {
  const files = new Map<string, string[]>();
  return (rel, line) => {
    let lines = files.get(rel);
    if (lines === undefined) {
      try {
        lines = fs.readFileSync(path.join(root, rel), "utf-8").split("\n");
      } catch {
        lines = [];
      }
      files.set(rel, lines);
    }
    const text = (lines[line - 1] ?? "").trim();
    return text.length > SOURCE_LINE_CAP ? `${text.slice(0, SOURCE_LINE_CAP - 1)}…` : text;
  };
}

interface Row {
  /** The file heading the row sits under, null for a list with no headings. */
  group: string | null;
  line: number;
  label: string;
  text: string;
  inferred: boolean;
}

/** The rows under one heading per file, line numbers right-aligned and labels padded to the widest of every list shown. */
function renderRows(rows: Row[], all: Row[]): string {
  const gutter = Math.max(GUTTER_MIN, ...all.map((row) => String(row.line).length));
  const labels = Math.max(0, ...all.map((row) => row.label.length));
  let out = "";
  let group: string | null = null;
  for (const row of rows) {
    if (row.group !== null && row.group !== group) out += `${row.group}\n`;
    group = row.group;
    const inferred = row.inferred ? " (inferred)" : "";
    out += `${String(row.line).padStart(gutter)}│${row.label.padEnd(labels)}  ${row.text}${inferred}\n`;
  }
  return out;
}

function header(row: SymbolRow): string {
  return `${row.qualified}  ${row.path}:${row.start}-${row.end}  ${row.kind}\n`;
}

function countLine(sites: Site[], filesOf: (site: Site) => string): string {
  return `${sites.length} call sites in ${new Set(sites.map(filesOf)).size} files.\n`;
}

function callersReport(db: sqlite.DatabaseSync, root: string, set: SymbolRow[]): string {
  const sites = callersOf(db, set);
  const source = sourceReader(root);
  const rowOf = (site: Site): Row => ({
    group: site.path,
    line: site.line,
    label: site.caller?.qualified ?? TOP_LEVEL,
    text: source(site.path, site.line),
    inferred: site.how === "inferred",
  });
  const resolved = sites.resolved.map(rowOf);
  const unresolved = sites.unresolved.map(rowOf);
  const all = [...resolved, ...unresolved];
  const first = sites.resolved.find((site) => site.caller !== null);
  return (
    header(set[0]!) +
    renderRows(resolved, all) +
    countLine(sites.resolved, (site) => site.path) +
    (unresolved.length > 0
      ? `Call sites named ${set[0]!.name} with no single definition:\n${renderRows(unresolved, all)}`
      : "") +
    (first ? `Open one: crank-mem unfold ${first.path} ${first.caller!.qualified}\n` : "") +
    `Wider: crank-mem impact ${pasteable(db, set[0]!)}\n`
  );
}

/** The resolved sites by the file defining each callee, then by the call's line. */
function byCalleeFile(sites: Site[]): Site[] {
  return [...sites].sort(
    (a, b) =>
      (a.target!.path === b.target!.path ? 0 : a.target!.path < b.target!.path ? -1 : 1) ||
      a.line - b.line,
  );
}

function calleesReport(db: sqlite.DatabaseSync, root: string, set: SymbolRow[]): string {
  const sites = calleesOf(db, set);
  const source = sourceReader(root);
  const ordered = byCalleeFile(sites.resolved);
  const resolved = ordered.map((site): Row => ({
    group: site.target!.path,
    line: site.line,
    label: site.target!.qualified,
    text: source(site.path, site.line),
    inferred: site.how === "inferred",
  }));
  const unresolved = sites.unresolved.map((site): Row => ({
    group: null,
    line: site.line,
    label: site.callee,
    text: source(site.path, site.line),
    inferred: false,
  }));
  const all = [...resolved, ...unresolved];
  const first = ordered[0]?.target;
  return (
    header(set[0]!) +
    renderRows(resolved, all) +
    countLine(ordered, (site) => site.target!.path) +
    (unresolved.length > 0
      ? `Calls with no single definition:\n${renderRows(unresolved, all)}`
      : "") +
    (first ? `Open one: crank-mem unfold ${first.path} ${first.qualified}\n` : "") +
    `Wider: crank-mem callers ${pasteable(db, set[0]!)}\n`
  );
}

import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import {
  calleesOf,
  callersOf,
  findSymbols,
  IMPACT_DEFAULT_DEPTH,
  IMPACT_MAX_DEPTH,
  impactOf,
  importersOf,
  isIndexedFile,
  similarSymbols,
  symbolSets,
  symbolsInFile,
  TOP_LEVEL,
  type ImpactNode,
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
import {
  cliActor,
  recordUsage,
  type CodeOutcome,
  type GraphUsage,
  type UsageEvent,
} from "../hooks/lib/usage.ts";
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
  return serve(
    rest[0],
    started,
    (db, scope) => {
      const rows = filesUnder(db, scope.prefix, from);
      const pending = pendingPaths(db);
      const page = anatomyPage(rows, pending, rest[0] ?? "", pending.size, symbolLines(db));
      return {
        text: page.text,
        matches: page.shown,
        capped: page.shown < rows.length,
        outcome: "ok",
      };
    },
    (usage) => ({ channel: "anatomy", from: from ?? null, ...usage }),
  );
}

/** What a command answers: the text it prints, how many entries that holds and how the run ended. */
type Answer = { text: string; matches: number; capped: boolean; outcome: CodeOutcome };

const refusal = (outcome: Exclude<CodeOutcome, "ok">): Answer => ({
  text: "",
  matches: 0,
  capped: false,
  outcome,
});

/**
 * Runs one graph command over `target`'s project: prints the answer, records its usage line and
 * returns the exit status. A refused target and an unreadable store answer with a refusal.
 * Returns 1 without a line when no installed project owns the target.
 */
async function serve(
  target: string | undefined,
  started: number,
  answer: (db: sqlite.DatabaseSync, scope: Scope) => Answer,
  event: (usage: GraphUsage) => UsageEvent,
): Promise<number> {
  const scope = commandScope(target ?? ".");
  if (scope === null) return 1;
  const finish = (result: Answer, pending: number): number => {
    process.stdout.write(result.text);
    recordUsage(
      scope.root,
      cliActor(),
      event({
        path: target === undefined ? null : scope.prefix,
        matches: result.matches,
        chars: result.text.length,
        capped: result.capped,
        pending,
        outcome: result.outcome,
        ms: Date.now() - started,
      }),
    );
    return result.outcome === "ok" ? 0 : 1;
  };
  if (scope.refused !== null) return finish(refusal(scope.refused), 0);
  const db = await refreshedStore(scope.root, started + COMMAND_REFRESH_MS);
  if (db === null) return finish(refusal("refused"), 0);
  try {
    return finish(answer(db, scope), pendingCount(db));
  } finally {
    db.close();
  }
}

type Scope = { root: string; prefix: string; refused: Exclude<CodeOutcome, "ok"> | null };

/** The project that owns `target` and its path inside it, or null after printing that no project does. */
function commandScope(target: string): Scope | null {
  const owner = ownerOf(path.resolve(process.cwd(), target));
  if (owner.kind === "unowned") {
    console.error(`crank-mem: ${target} is outside every installed project.`);
    return null;
  }
  const at = { root: owner.root, prefix: toPosix(owner.rel) };
  const refuse = (reason: string, outcome: Exclude<CodeOutcome, "ok">) => {
    console.error(`crank-mem: ${reason}`);
    return { root: owner.root, path: at.prefix, outcome };
  };
  const within = owner.kind === "worktree" ? owner.top : owner.root;
  const real = checkedPath(target, within, refuse, (e) =>
    refuse(`cannot read ${target} (${(e as NodeJS.ErrnoException).code}).`, "refused"),
  );
  return {
    ...at,
    refused: typeof real === "string" || real.outcome === "ok" ? null : real.outcome,
  };
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
): { text: string; shown: number } {
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
  return { text: out + (shown < rows.length ? pendingLine + more(shown) : pendingLine), shown };
}

/** `crank-mem callers [<file>] <symbol>`: the sites that call the symbol, then the sites that might. */
export function callers(args: string[]): Promise<number> {
  return symbolCommand("callers", args, callersReport);
}

/** `crank-mem callees [<file>] <symbol>`: the calls made inside the symbol, then the ones with no single definition. */
export function callees(args: string[]): Promise<number> {
  return symbolCommand("callees", args, calleesReport);
}

type Listing = { text: string; matches: number };
type Report = (db: sqlite.DatabaseSync, root: string, set: SymbolRow[]) => Listing;

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
  return serve(
    file,
    started,
    (db, scope) => {
      const set = chosenSymbol(db, symbol, file === undefined ? null : scope.prefix, file);
      if (!Array.isArray(set)) return set;
      const done = report(db, scope.root, set);
      return {
        text: done.text + pendingLine(db),
        matches: done.matches,
        capped: false,
        outcome: "ok",
      };
    },
    (usage) => ({ channel: name, symbol, ...usage }),
  );
}

/** The one symbol `symbol` names, or the refusal after printing that it names none or several. */
function chosenSymbol(
  db: sqlite.DatabaseSync,
  symbol: string,
  within: string | null,
  file: string | undefined,
): SymbolRow[] | Answer {
  const query = within === null ? symbol : { file: within, symbol };
  const sets = symbolSets(findSymbols(db, query));
  if (sets.length === 1) return sets[0]!;
  if (sets.length === 0) {
    console.error(`crank-mem: no symbol ${symbol}${file === undefined ? "" : ` in ${file}`}.`);
    printClose(symbolSets(similarSymbols(db, symbol, within)));
    return refusal("not-found");
  }
  console.error(`crank-mem: ${symbol} names ${sets.length} symbols.`);
  printClose(sets);
  return refusal("refused");
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

function callersReport(db: sqlite.DatabaseSync, root: string, set: SymbolRow[]): Listing {
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
  const text =
    header(set[0]!) +
    renderRows(resolved, all) +
    countLine(sites.resolved, (site) => site.path) +
    (unresolved.length > 0
      ? `Call sites named ${set[0]!.name} with no single definition:\n${renderRows(unresolved, all)}`
      : "") +
    (first ? `Open one: crank-mem unfold ${first.path} ${first.caller!.qualified}\n` : "") +
    `Wider: crank-mem impact ${pasteable(db, set[0]!)}\n`;
  return { text, matches: resolved.length };
}

/** The resolved sites by the file defining each callee, then by the call's line. */
function byCalleeFile(sites: Site[]): Site[] {
  return [...sites].sort(
    (a, b) =>
      (a.target!.path === b.target!.path ? 0 : a.target!.path < b.target!.path ? -1 : 1) ||
      a.line - b.line,
  );
}

function calleesReport(db: sqlite.DatabaseSync, root: string, set: SymbolRow[]): Listing {
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
  const text =
    header(set[0]!) +
    renderRows(resolved, all) +
    countLine(ordered, (site) => site.target!.path) +
    (unresolved.length > 0
      ? `Calls with no single definition:\n${renderRows(unresolved, all)}`
      : "") +
    (first ? `Open one: crank-mem unfold ${first.path} ${first.qualified}\n` : "") +
    `Wider: crank-mem callers ${pasteable(db, set[0]!)}\n`;
  return { text, matches: resolved.length };
}

/** The `--depth` value, or null when it is not a whole number from 1 to IMPACT_MAX_DEPTH. */
function depthOf(value: string | boolean | undefined): number | null {
  if (value === undefined) return IMPACT_DEFAULT_DEPTH;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const depth = Number(value);
  return depth >= 1 && depth <= IMPACT_MAX_DEPTH ? depth : null;
}

function isRegularFile(target: string): boolean {
  try {
    return fs.statSync(path.resolve(process.cwd(), target)).isFile();
  } catch {
    return false;
  }
}

/**
 * `crank-mem impact [<file>] <symbol>`: the callers of the symbol, their callers and so on.
 * A lone argument that names an indexed file lists every symbol of that file with callers,
 * then the files importing it.
 */
export async function impact(args: string[]): Promise<number> {
  const started = Date.now();
  const { flags, rest } = parseArgs(args, COMMANDS.impact.value);
  const depth = depthOf(flags.depth);
  if (depth === null || rest.length < 1 || rest.length > 2 || rest.includes("")) {
    console.error(COMMANDS.impact.usage);
    return 1;
  }
  const lone = rest.length === 1 && isRegularFile(rest[0]!) ? rest[0] : undefined;
  const file = rest.length === 2 ? rest[0] : lone;
  return serve(
    file,
    started,
    (db, scope) => {
      const answer =
        lone !== undefined && isIndexedFile(db, scope.prefix)
          ? fileImpact(db, scope.prefix, depth)
          : symbolImpact(db, rest, scope.prefix, depth);
      return answer.outcome === "ok" ? { ...answer, text: answer.text + pendingLine(db) } : answer;
    },
    (usage) => ({ channel: "impact", symbol: lone === undefined ? rest.at(-1)! : null, ...usage }),
  );
}

/** The tree of the one symbol the arguments name, or the refusal after printing why they name none. */
function symbolImpact(
  db: sqlite.DatabaseSync,
  args: string[],
  prefix: string,
  depth: number,
): Answer {
  const named = args.length === 2;
  const set = chosenSymbol(db, args.at(-1)!, named ? prefix : null, named ? args[0] : undefined);
  if (!Array.isArray(set)) return set;
  const root = impactOf(db, [set], depth)[0]!;
  return { text: renderTree(root), matches: callerCount(root), capped: false, outcome: "ok" };
}

/** The file, the callers of each symbol in it that has any, then the files importing it. */
function fileImpact(db: sqlite.DatabaseSync, file: string, depth: number): Answer {
  const sets = symbolSets(symbolsInFile(db, file));
  const roots = impactOf(db, sets, depth).filter((root) => root.children.length > 0 || root.shown);
  const importers = importersOf(db, file);
  const text =
    `${file}\n${roots.map(renderTree).join("")}` +
    (importers.length > 0 ? `Imported by:\n${importers.join("\n")}\n` : "Imported by: none\n");
  const matches = roots.reduce((sum, root) => sum + callerCount(root), 0);
  return { text, matches, capped: false, outcome: "ok" };
}

/** The callers below `node`, at every depth. */
function callerCount(node: ImpactNode): number {
  return node.children.reduce((sum, child) => sum + 1 + callerCount(child), 0);
}

/** Each caller's tree prefix and name are padded to this width before its call site. */
const TREE_NAME_WIDTH = 20;

function notesOf(node: ImpactNode): string {
  if (node.shown) return " (shown above)";
  return node.hub === null ? "" : ` (${node.hub} callers, not expanded)`;
}

/** The root line, then its callers drawn as a tree, one line per caller. */
function renderTree(root: ImpactNode): string {
  const lines = [`${root.name}  ${root.path}:${root.line}${notesOf(root)}`];
  const draw = (node: ImpactNode, indent: string) => {
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      const head = `${indent}${last ? "└─" : "├─"} ${child.name}`;
      lines.push(`${head.padEnd(TREE_NAME_WIDTH)}  ${child.path}:${child.line}${notesOf(child)}`);
      draw(child, indent + (last ? "   " : "│  "));
    });
  };
  draw(root, "");
  return `${lines.join("\n")}\n`;
}

import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { COMMANDS } from "./commands.ts";
import { CRANK_DIR, loadConfig, type CrankConfig } from "../hooks/lib/config.ts";
import {
  clearDerivedFacts,
  deleteCodeDb,
  openCodeDb,
  parseable,
  pendingCount,
  pendingFiles,
  refreshFileFacts,
  transaction,
  type CodeDbOpen,
  type PendingFile,
} from "../hooks/lib/code-db.ts";
import { fileLinks, type FileLinks } from "../hooks/lib/imports.ts";
import { isInstalled } from "../hooks/lib/owner.ts";
import { rank } from "../hooks/lib/scanner.ts";
import { estimateTokens } from "../hooks/lib/tokens.ts";
import { codeFacts, grammarFor, type CallSite, type CodeSymbol } from "./code-symbols.ts";

// The one open-and-refresh path of the graph commands and the daemon's graph job: it opens
// code.db to write, brings the file facts current, then parses pending files, most active first,
// until the deadline. Each file's rows and its parse stamp commit together, so a killed run
// leaves every file whole or pending.

export interface RefreshOptions {
  /** Absolute `Date.now()` time to stop at; `Infinity` for none. */
  deadlineMs: number;
  /** How long to wait on another process's write lock. */
  busyMs?: number;
  /** Fires after each file's commit. */
  onProgress?: (done: number, total: number, rel: string) => void;
  /** Test seam: fires after a file's text is read and before that file's transaction. */
  afterRead?: (rel: string) => void;
}

export interface GraphRefresh {
  /**
   * `open`: the store is current as far as the deadline allowed. `readonly`: the file system
   * refuses writes, so nothing was refreshed. `unreadable`: the store cannot be opened (see
   * `reason`). `no-parser`: web-tree-sitter or a grammar did not load, so every parse stayed pending.
   */
  status: "open" | "readonly" | "unreadable" | "no-parser";
  reason?: string;
  /** Parseable files still unparsed; 0 when the store was not opened to write. */
  pending: number;
}

const DEFAULT_BUSY_MS = 2000;

/** The deadline `graph-job` gives one run; a store with more pending files resumes at the daemon's next sweep. */
const GRAPH_JOB_MS = 60_000;

/** SQLITE_BUSY; extended codes (261, 517) carry it in the low byte. */
const SQLITE_BUSY = 5;

function isBusy(err: unknown): boolean {
  const { errcode } = err as { errcode?: unknown };
  return typeof errcode === "number" && (errcode & 0xff) === SQLITE_BUSY;
}

/** True when an open's `reason` (`errcode <n>`, as `code-db.ts` → `failure` words it) names SQLITE_BUSY. */
function busyReason(reason: string | undefined): boolean {
  const code = /^errcode (\d+)$/.exec(reason ?? "")?.[1];
  return code !== undefined && isBusy({ errcode: Number(code) });
}

/** The store opened to write, rebuilt first when it is corrupt or another version. */
function openForRefresh(root: string, busyMs: number): CodeDbOpen {
  const opened = openCodeDb(root, "write", busyMs);
  if (opened.status !== "rebuild") return opened;
  deleteCodeDb(root);
  return openCodeDb(root, "write", busyMs);
}

export async function refreshGraph(
  root: string,
  config: CrankConfig,
  options: RefreshOptions,
): Promise<GraphRefresh> {
  const opened = openForRefresh(root, options.busyMs ?? DEFAULT_BUSY_MS);
  const db = opened.db;
  if (opened.status === "unreadable" && busyReason(opened.reason)) {
    // Another writer outlasted the busy wait: leave every file as it is for the next run.
    return { status: "open", pending: 0 };
  }
  if (opened.status !== "open" || db === undefined) {
    const status = opened.status === "readonly" ? "readonly" : "unreadable";
    return { status, reason: opened.reason ?? opened.status, pending: 0 };
  }
  try {
    refreshFileFacts(root, config, db, options.deadlineMs);
    const outcome = await parsePending(root, config, db, options);
    return { status: outcome === "no-parser" ? "no-parser" : "open", pending: pendingCount(db) };
  } catch (err) {
    // A writer held the lock past the busy wait: the files not yet committed stay pending.
    if (!isBusy(err)) throw err;
    return { status: "open", pending: pendingCount(db) };
  } finally {
    db.close();
  }
}

/** Most written first, then the churn list, then first-party source before the rest. */
function parseOrder(a: PendingFile, b: PendingFile): number {
  return (
    b.writeCount - a.writeCount ||
    (a.churnRank ?? Infinity) - (b.churnRank ?? Infinity) ||
    rank(a.path) - rank(b.path) ||
    (a.path < b.path ? -1 : 1)
  );
}

async function parsePending(
  root: string,
  config: CrankConfig,
  db: sqlite.DatabaseSync,
  options: RefreshOptions,
): Promise<"done" | "no-parser"> {
  const queue = pendingFiles(db).sort(parseOrder);
  const writer = prepareWriter(db);
  let done = 0;
  for (const { path: rel } of queue) {
    if (Date.now() >= options.deadlineMs) break;
    const outcome = await parseFile(root, rel, config, writer, options.afterRead);
    if (outcome === "no-parser") return "no-parser";
    if (outcome === "busy") break;
    if (outcome === "committed") options.onProgress?.(++done, queue.length, rel);
  }
  return "done";
}

/** What reading and parsing one file produced; null `facts` with an `error` records a failed parse. */
interface Parsed {
  rel: string;
  text: string;
  size: number;
  mtimeMs: number;
  facts: { symbols: CodeSymbol[]; calls: CallSite[] } | null;
  links: FileLinks;
  error: string | null;
}

/** The file's text; the error code of a read that fails while the file exists; null when the file is gone. */
function readText(file: string): { text: string } | { error: string } | null {
  try {
    return { text: fs.readFileSync(file, "utf-8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? null : { error: code ?? String(err) };
  }
}

/** Fills `parsed`'s facts and links; a parse that throws records its message as the file's `error`. */
async function extract(
  parsed: Parsed,
  root: string,
  config: CrankConfig,
  grammar: NonNullable<ReturnType<typeof grammarFor>>,
): Promise<"done" | "no-parser"> {
  try {
    parsed.facts = await codeFacts(parsed.text, grammar);
    // Nothing loaded: leave the file pending rather than stamp it parsed and empty.
    if (parsed.facts === null) return "no-parser";
    parsed.links = fileLinks(root, parsed.rel, parsed.text, config);
  } catch (err) {
    parsed.error = err instanceof Error ? err.message : String(err);
  }
  return "done";
}

async function parseFile(
  root: string,
  rel: string,
  config: CrankConfig,
  writer: Writer,
  afterRead?: (rel: string) => void,
): Promise<"committed" | "skipped" | "no-parser" | "busy"> {
  const grammar = grammarFor(rel);
  let stat: fs.Stats;
  try {
    // The stamp comes from before the read: a file that changes after it stays pending.
    stat = fs.statSync(path.join(root, rel));
  } catch {
    return "skipped";
  }
  if (grammar === null || !parseable(rel, stat.size)) return "skipped";
  const read = readText(path.join(root, rel));
  if (read === null) return "skipped";
  afterRead?.(rel);
  const parsed: Parsed = {
    rel,
    text: "text" in read ? read.text : "",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    facts: null,
    links: {},
    error: "error" in read ? read.error : null,
  };
  if (parsed.error === null && (await extract(parsed, root, config, grammar)) === "no-parser")
    return "no-parser";
  try {
    return writer.commit(parsed) ? "committed" : "skipped";
  } catch (err) {
    // Another writer holds the lock past the busy wait: this file and the rest stay pending.
    if (isBusy(err)) return "busy";
    throw err;
  }
}

interface Writer {
  /** Replaces the file's rows and stamp in one transaction; false when the file's row is gone. */
  commit(parsed: Parsed): boolean;
}

function prepareWriter(db: sqlite.DatabaseSync): Writer {
  const stamp = db.prepare(
    "UPDATE files SET parsed_size = ?, parsed_mtime_ms = ?, parse_error = ? WHERE path = ?",
  );
  const symbol = db.prepare(
    `INSERT INTO symbols (path, parent_id, qualified_name, name, kind, start_line, end_line, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const call = db.prepare(
    "INSERT INTO calls (path, line, caller_symbol_id, callee_name, receiver) VALUES (?, ?, ?, ?, ?)",
  );
  const importRow = db.prepare("INSERT OR IGNORE INTO imports (from_path, to_path) VALUES (?, ?)");
  const namespace = db.prepare("INSERT INTO namespaces (path, namespace, role) VALUES (?, ?, ?)");

  /** Inserts the symbols parent first, as `code.ts` → `preorder` lists them; returns each row id in that order. */
  function insertSymbols(parsed: Parsed): number[] {
    const lines = parsed.text.split("\n");
    const ids: number[] = [];
    const visit = (symbols: CodeSymbol[], parent: number | null) => {
      for (const s of symbols) {
        const body = lines.slice(s.start - 1, s.end).join("\n");
        const row = symbol.run(
          parsed.rel,
          parent,
          s.qualified,
          s.name,
          s.kind,
          s.start,
          s.end,
          estimateTokens(body, parsed.rel),
        );
        const id = Number(row.lastInsertRowid);
        ids.push(id);
        visit(s.children, id);
      }
    };
    visit(parsed.facts?.symbols ?? [], null);
    return ids;
  }

  function insertFacts(parsed: Parsed): void {
    const ids = insertSymbols(parsed);
    for (const c of parsed.facts?.calls ?? []) {
      const caller = c.enclosing === null ? null : (ids[c.enclosing] ?? null);
      call.run(parsed.rel, c.line, caller, c.callee, c.receiver);
    }
    for (const target of parsed.links.imports ?? []) importRow.run(parsed.rel, target);
    const { declares = [], uses = [] } = parsed.links.namespaces ?? {};
    for (const name of declares) namespace.run(parsed.rel, name, "declares");
    for (const name of uses) namespace.run(parsed.rel, name, "uses");
  }

  return {
    commit(parsed) {
      return transaction(db, () => {
        const stamped = stamp.run(parsed.size, parsed.mtimeMs, parsed.error, parsed.rel);
        if (stamped.changes === 0) return false;
        clearDerivedFacts(db, parsed.rel);
        if (parsed.error === null) insertFacts(parsed);
        return true;
      });
    },
  };
}

/** `crank-mem graph-job <root>` (internal: the daemon runs it): refresh the project's code.db for up to 60 s. */
export async function run(args: string[]): Promise<number> {
  const root = args[0];
  if (root === undefined) {
    console.error(COMMANDS["graph-job"].usage);
    return 1;
  }
  // A project uninstalled since the daemon looked has no graph to keep; a refresh would recreate it.
  if (!isInstalled(root)) return 0;
  const refreshed = await refreshGraph(root, loadConfig(path.join(root, CRANK_DIR)), {
    deadlineMs: Date.now() + GRAPH_JOB_MS,
  });
  if (refreshed.status === "unreadable" || refreshed.status === "readonly") {
    console.error(`crank-mem: .crank/code.db is not readable (${refreshed.reason})`);
    return 1;
  }
  return refreshed.status === "no-parser" ? 1 : 0;
}

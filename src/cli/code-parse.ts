import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { COMMANDS } from "./commands.ts";
import { CRANK_DIR, loadConfig, type CrankConfig } from "../hooks/lib/config.ts";
import {
  clearDerivedFacts,
  deleteCodeDb,
  isBusy,
  openCodeDb,
  parseable,
  pendingCount,
  pendingFiles,
  refreshFileFacts,
  type CodeDbOpen,
  type PendingFile,
} from "../hooks/lib/code-db.ts";
import { fileLinks, type FileLinks } from "../hooks/lib/imports.ts";
import { isInstalled } from "../hooks/lib/owner.ts";
import { byCodeUnit } from "../hooks/lib/indexable.ts";
import { rank } from "../hooks/lib/scanner.ts";
import { transaction } from "../hooks/lib/transaction.ts";
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
   * `open`: the store is current as far as the deadline allowed. `busy`: another process held the
   * write lock past the wait, so the refresh stopped short (`pending` counts what it left, 0 when
   * it never opened the store). `readonly`: the file system refuses writes, so nothing was
   * refreshed. `unreadable`: the store cannot be opened (see `reason`). `no-parser`: web-tree-sitter or a grammar did not load, so every parse stayed pending.
   */
  status: "open" | "busy" | "readonly" | "unreadable" | "no-parser";
  reason?: string;
  /** Parseable files still unparsed; 0 when the store was not opened to write. */
  pending: number;
  /** False when git's listing outlasted its budget, so the file list was not refreshed. */
  listed?: boolean;
}

const DEFAULT_BUSY_MS = 2000;

/** The deadline `graph-job` gives one run; a store with more pending files resumes at the daemon's next sweep. */
const GRAPH_JOB_MS = 60_000;

/** The error code of a delete that failed, or null when the store and its WAL files are gone. */
export function deleteStore(root: string): string | null {
  try {
    deleteCodeDb(root);
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? "unknown";
  }
}

/** The store opened to write, rebuilt first when it is corrupt or another version; a delete the file system refuses reads as `unreadable`. */
export function openForRefresh(root: string, busyMs: number): CodeDbOpen {
  const opened = openCodeDb(root, "write", busyMs);
  if (opened.status !== "rebuild") return opened;
  const failed = deleteStore(root);
  if (failed !== null) return { status: "unreadable", reason: failed };
  return openCodeDb(root, "write", busyMs);
}

export async function refreshGraph(
  root: string,
  config: CrankConfig,
  options: RefreshOptions,
): Promise<GraphRefresh> {
  const opened = openForRefresh(root, options.busyMs ?? DEFAULT_BUSY_MS);
  const db = opened.db;
  if (opened.status === "busy") {
    // Another writer outlasted the busy wait: leave every file as it is for the next run.
    return { status: "busy", pending: 0 };
  }
  if (opened.status !== "open" || db === undefined) {
    const status = opened.status === "readonly" ? "readonly" : "unreadable";
    return { status, reason: opened.reason ?? opened.status, pending: 0 };
  }
  try {
    const { listed } = refreshFileFacts(root, config, db, options.deadlineMs);
    const outcome = await parsePending(root, config, db, options);
    return {
      status: outcome === "no-parser" ? "no-parser" : "open",
      pending: pendingCount(db),
      listed,
    };
  } catch (err) {
    // A writer held the lock past the busy wait: the files not yet committed stay pending.
    if (!isBusy(err)) throw err;
    return { status: "busy", pending: pendingCount(db) };
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
    byCodeUnit(a.path, b.path)
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

interface FileStamp {
  rel: string;
  size: number;
  mtimeMs: number;
}

/** A file's parsed rows: its symbols and call sites, its links, and the text its symbols were measured on. */
interface Extracted {
  text: string;
  facts: { symbols: CodeSymbol[]; calls: CallSite[] };
  links: FileLinks;
}

/** What reading and parsing one file produced: its rows, or the `error` its stamp records for a read or parse that failed. */
type Parsed = FileStamp & ({ error: string } | ({ error: null } & Extracted));

/** The file's text; the error code of a read that fails while the file exists; null when the file is gone. */
function readText(file: string): { text: string } | { error: string } | null {
  try {
    return { text: fs.readFileSync(file, "utf-8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? null : { error: code ?? String(err) };
  }
}

/** The file's rows; a parse that throws records its message as the file's `error`; "no-parser" when nothing loaded. */
async function extract(
  rel: string,
  text: string,
  root: string,
  config: CrankConfig,
  grammar: NonNullable<ReturnType<typeof grammarFor>>,
): Promise<Extracted | { error: string } | "no-parser"> {
  try {
    const facts = await codeFacts(text, grammar);
    // Nothing loaded: leave the file pending rather than stamp it parsed and empty.
    if (facts === null) return "no-parser";
    return { text, facts, links: fileLinks(root, rel, text, config) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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
  const outcome = "error" in read ? read : await extract(rel, read.text, root, config, grammar);
  if (outcome === "no-parser") return "no-parser";
  const parsed: Parsed = {
    rel,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ...("error" in outcome ? outcome : { error: null, ...outcome }),
  };
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
  function insertSymbols(parsed: FileStamp & Extracted): number[] {
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
    visit(parsed.facts.symbols, null);
    return ids;
  }

  function insertFacts(parsed: FileStamp & Extracted): void {
    const ids = insertSymbols(parsed);
    for (const c of parsed.facts.calls) {
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

/** `crank-mem graph-job <root>` (internal: the daemon runs it): refresh the project's code.db for `GRAPH_JOB_MS`. */
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

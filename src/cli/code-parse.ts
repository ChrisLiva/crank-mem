import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import type { CrankConfig } from "../hooks/lib/config.ts";
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
  if (opened.status !== "open" || db === undefined) {
    const status = opened.status === "readonly" ? "readonly" : "unreadable";
    return { status, reason: opened.reason ?? opened.status, pending: 0 };
  }
  try {
    refreshFileFacts(root, config, db, options.deadlineMs);
    const outcome = await parsePending(root, config, db, options);
    return { status: outcome === "no-parser" ? "no-parser" : "open", pending: pendingCount(db) };
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

async function parseFile(
  root: string,
  rel: string,
  config: CrankConfig,
  writer: Writer,
  afterRead?: (rel: string) => void,
): Promise<"committed" | "skipped" | "no-parser"> {
  const grammar = grammarFor(rel);
  let stat: fs.Stats;
  let text: string;
  try {
    // The stamp comes from before the read: a file that changes after it stays pending.
    stat = fs.statSync(path.join(root, rel));
    if (grammar === null || !parseable(rel, stat.size)) return "skipped";
    text = fs.readFileSync(path.join(root, rel), "utf-8");
  } catch {
    return "skipped";
  }
  afterRead?.(rel);
  const parsed: Parsed = {
    rel,
    text,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    facts: null,
    links: {},
    error: null,
  };
  try {
    parsed.facts = await codeFacts(text, grammar);
    // Nothing loaded: leave the file pending rather than stamp it parsed and empty.
    if (parsed.facts === null) return "no-parser";
    parsed.links = fileLinks(root, rel, text, config);
  } catch (err) {
    parsed.error = err instanceof Error ? err.message : String(err);
  }
  return writer.commit(parsed) ? "committed" : "skipped";
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

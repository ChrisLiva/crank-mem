import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { GRAMMARS } from "./code-db.ts";
import { TEST_PATH } from "./indexable.ts";

// Reads over code.db's symbols, calls and imports: finding a symbol and resolving each call site
// to the one definition it reaches, when exactly one is provable.

export interface SymbolRow {
  id: number;
  path: string;
  parentId: number | null;
  qualified: string;
  name: string;
  kind: string;
  start: number;
  end: number;
}

interface CallRow {
  path: string;
  line: number;
  callerId: number | null;
  callee: string;
  receiver: string | null;
}

type How = "direct" | "inferred";

/** One call site: `target` is the definition it reaches, null when no single definition is provable. */
export interface Site {
  path: string;
  line: number;
  /** The symbol holding the call, null at top level. */
  caller: SymbolRow | null;
  callee: string;
  target: SymbolRow | null;
  how: How | null;
}

export interface Sites {
  resolved: Site[];
  unresolved: Site[];
}

/** A bare name or `Class.method`, or a name looked up in one file. */
export type SymbolQuery = string | { file: string; symbol: string };

const SYMBOL_COLUMNS = `id, path, parent_id AS parentId, qualified_name AS qualified, name, kind,
  start_line AS start, end_line AS end`;
const CALL_COLUMNS = `path, line, caller_symbol_id AS callerId, callee_name AS callee, receiver`;
const SYMBOL_ORDER = "ORDER BY path, start_line, id";

/** Callers in these languages resolve by a name that has one definition in the whole project. */
const UNIQUE_DEFINITION = new Set(["java", "ruby", "php", "bash", "powershell", "c-sharp"]);

type Arg = string | number | null;

interface Statements {
  byId: (id: number) => SymbolRow[];
  inFile: (file: string, name: string) => SymbolRow[];
  members: (parentId: number, name: string) => SymbolRow[];
  imported: (name: string, from: string) => SymbolRow[];
  named: (name: string) => SymbolRow[];
  /** The files declaring a namespace the file declares or uses. */
  sharingNamespace: (file: string) => string[];
}

const prepared = new WeakMap<sqlite.DatabaseSync, Statements>();

function statements(db: sqlite.DatabaseSync): Statements {
  const cached = prepared.get(db);
  if (cached) return cached;
  const symbols = (where: string) => {
    const stmt = db.prepare(`SELECT ${SYMBOL_COLUMNS} FROM symbols WHERE ${where} ${SYMBOL_ORDER}`);
    return (...args: Arg[]) => stmt.all(...args) as unknown as SymbolRow[];
  };
  const byId = symbols("id = ?");
  const inFile = symbols("path = ? AND name = ?");
  const members = symbols("parent_id = ? AND name = ?");
  const imported = symbols(
    "name = ? AND path IN (SELECT to_path FROM imports WHERE from_path = ?)",
  );
  const named = symbols("name = ?");
  const sharing = db.prepare(
    `SELECT DISTINCT d.path FROM namespaces d JOIN namespaces c ON c.namespace = d.namespace
     WHERE d.role = 'declares' AND c.path = ?`,
  );
  const made: Statements = {
    byId: (id) => byId(id),
    inFile: (file, name) => inFile(file, name),
    members: (parentId, name) => members(parentId, name),
    imported: (name, from) => imported(name, from),
    named: (name) => named(name),
    sharingNamespace: (file) => (sharing.all(file) as { path: string }[]).map((r) => r.path),
  };
  prepared.set(db, made);
  return made;
}

/** The symbols a query names: a name or qualified name, in every file or in the one `file` names. */
export function findSymbols(db: sqlite.DatabaseSync, query: SymbolQuery): SymbolRow[] {
  const { file, symbol } = typeof query === "string" ? { file: null, symbol: query } : query;
  return db
    .prepare(
      `SELECT ${SYMBOL_COLUMNS} FROM symbols
       WHERE (name = ? OR qualified_name = ?) AND (? IS NULL OR path = ?) ${SYMBOL_ORDER}`,
    )
    .all(symbol, symbol, file, file) as unknown as SymbolRow[];
}

/** The symbols whose qualified name holds `text`, in every file or in the one `file`, case-blind. */
export function similarSymbols(
  db: sqlite.DatabaseSync,
  text: string,
  file: string | null,
): SymbolRow[] {
  return db
    .prepare(
      `SELECT ${SYMBOL_COLUMNS} FROM symbols
       WHERE instr(lower(qualified_name), lower(?)) > 0 AND (? IS NULL OR path = ?) ${SYMBOL_ORDER}`,
    )
    .all(text, file, file) as unknown as SymbolRow[];
}

/** The rows grouped by `(path, qualified)`: an overload set is one symbol. */
export function symbolSets(rows: SymbolRow[]): SymbolRow[][] {
  const sets = new Map<string, SymbolRow[]>();
  for (const row of rows) {
    const key = `${row.path}\0${row.qualified}`;
    const set = sets.get(key);
    if (set) set.push(row);
    else sets.set(key, [row]);
  }
  return [...sets.values()];
}

interface Found {
  sets: SymbolRow[][];
  how: How;
}

function found(rows: SymbolRow[], how: How): Found | null {
  return rows.length === 0 ? null : { sets: symbolSets(rows), how };
}

/** The members named `name` of the nearest container holding one, starting at the caller itself. */
function enclosingMembers(s: Statements, name: string, caller: SymbolRow | null): SymbolRow[] {
  for (
    let at = caller;
    at !== null;
    at = at.parentId === null ? null : (s.byId(at.parentId)[0] ?? null)
  ) {
    const members = s.members(at.id, name);
    if (members.length > 0) return members;
  }
  return [];
}

/** Step 1: a bare call to a name defined in the caller's file, or a self call to a member of the enclosing class. */
function sameFile(s: Statements, call: CallRow, caller: SymbolRow | null): Found | null {
  if (call.receiver === "member") return null;
  const rows =
    call.receiver === "self"
      ? enclosingMembers(s, call.callee, caller)
      : s.inFile(call.path, call.callee);
  return found(rows, "direct");
}

/** Step 2: a name defined in the files the caller imports; a member call needs a method there. */
function viaImports(s: Statements, call: CallRow): Found | null {
  const rows = s.imported(call.callee, call.path);
  if (call.receiver !== "member") return found(rows, "direct");
  return found(
    rows.filter((row) => row.kind === "method"),
    "inferred",
  );
}

/** Step 3: for the languages that name no imports, a name defined once outside the test files. */
function uniqueDefinition(s: Statements, call: CallRow): Found | null {
  const grammar = GRAMMARS[path.extname(call.path).toLowerCase()];
  if (grammar === undefined || !UNIQUE_DEFINITION.has(grammar)) return null;
  let rows = s.named(call.callee).filter((row) => !TEST_PATH.test(row.path));
  if (grammar === "c-sharp") {
    const visible = new Set(s.sharingNamespace(call.path));
    rows = rows.filter((row) => visible.has(row.path));
  }
  return found(rows, "inferred");
}

/**
 * The one definition a call reaches. The first of its steps with any candidate decides: two or
 * more distinct `(path, qualified)` candidates there resolve nothing.
 */
function resolveCall(
  db: sqlite.DatabaseSync,
  call: CallRow,
): { target: SymbolRow; how: How } | null {
  const s = statements(db);
  const caller = call.callerId === null ? null : (s.byId(call.callerId)[0] ?? null);
  const decided = sameFile(s, call, caller) ?? viaImports(s, call) ?? uniqueDefinition(s, call);
  if (decided === null || decided.sets.length !== 1) return null;
  return { target: decided.sets[0]![0]!, how: decided.how };
}

function siteOf(
  db: sqlite.DatabaseSync,
  call: CallRow,
  resolution: { target: SymbolRow; how: How } | null,
): Site {
  const caller = call.callerId === null ? null : (statements(db).byId(call.callerId)[0] ?? null);
  return {
    path: call.path,
    line: call.line,
    caller,
    callee: call.callee,
    target: resolution?.target ?? null,
    how: resolution?.how ?? null,
  };
}

/** The sites that call the symbol set, and the sites named like it that reach no single definition. */
export function callersOf(db: sqlite.DatabaseSync, set: SymbolRow[]): Sites {
  const symbol = set[0]!;
  const calls = db
    .prepare(`SELECT ${CALL_COLUMNS} FROM calls WHERE callee_name = ? ORDER BY path, line`)
    .all(symbol.name) as unknown as CallRow[];
  const sites: Sites = { resolved: [], unresolved: [] };
  for (const call of calls) {
    const resolution = resolveCall(db, call);
    if (resolution === null) sites.unresolved.push(siteOf(db, call, null));
    else if (
      resolution.target.path === symbol.path &&
      resolution.target.qualified === symbol.qualified
    )
      sites.resolved.push(siteOf(db, call, resolution));
  }
  return sites;
}

/** The calls made inside the symbol set and its descendants, resolved or not. */
export function calleesOf(db: sqlite.DatabaseSync, set: SymbolRow[]): Sites {
  const marks = set.map(() => "?").join(", ");
  const calls = db
    .prepare(
      `WITH RECURSIVE inside(id) AS (
         SELECT id FROM symbols WHERE id IN (${marks})
         UNION SELECT s.id FROM symbols s JOIN inside ON s.parent_id = inside.id)
       SELECT ${CALL_COLUMNS} FROM calls
       WHERE caller_symbol_id IN (SELECT id FROM inside) ORDER BY line`,
    )
    .all(...set.map((row) => row.id)) as unknown as CallRow[];
  const sites: Sites = { resolved: [], unresolved: [] };
  for (const call of calls) {
    const resolution = resolveCall(db, call);
    (resolution === null ? sites.unresolved : sites.resolved).push(siteOf(db, call, resolution));
  }
  return sites;
}

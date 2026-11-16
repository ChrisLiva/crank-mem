import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { filesUnder, openCodeDb, pendingPaths, type FileRow } from "../hooks/lib/code-db.ts";
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
  const scope = anatomyScope(rest[0] ?? ".");
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
function anatomyScope(target: string): { root: string; prefix: string } | null {
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

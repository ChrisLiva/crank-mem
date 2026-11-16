import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import {
  deleteCodeDb,
  filesUnder,
  openCodeDb,
  pendingPaths,
  refreshFileFacts,
  type FileRow,
} from "../hooks/lib/code-db.ts";
import { CRANK_DIR, loadConfig } from "../hooks/lib/config.ts";
import { toPosix } from "../hooks/lib/indexable.ts";
import { ownerOf } from "../hooks/lib/owner.ts";
import { parseArgs, stringFlag } from "./args.ts";
import { CAP, checkedPath } from "./code.ts";
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
  const store = openStore(scope.root);
  if (store === null) return 1;
  try {
    if (store.writable) {
      refreshFileFacts(
        scope.root,
        loadConfig(path.join(scope.root, CRANK_DIR)),
        store.db,
        started + COMMAND_REFRESH_MS,
      );
    }
    const rows = filesUnder(store.db, scope.prefix, from);
    const pending = pendingPaths(store.db);
    process.stdout.write(anatomyPage(rows, pending, rest[0] ?? "", pending.size));
    return 0;
  } finally {
    store.db.close();
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
 * The store opened to write, rebuilt first when it is corrupt or another version. A store the
 * file system will not let this process write opens to read, so the command answers without
 * refreshing. Null, after printing why, when the store cannot be opened.
 */
function openStore(root: string): { db: sqlite.DatabaseSync; writable: boolean } | null {
  let opened = openCodeDb(root, "write", BUSY_MS);
  if (opened.status === "rebuild") {
    deleteCodeDb(root);
    opened = openCodeDb(root, "write", BUSY_MS);
  }
  let writable = opened.status === "open";
  if (opened.status === "readonly") {
    opened = openCodeDb(root, "read", BUSY_MS);
    writable = false;
  }
  if (opened.status === "open" && opened.db) return { db: opened.db, writable };
  console.error(
    `crank-mem: .crank/code.db is not readable (${opened.reason ?? opened.status}). Fix: crank-mem scan`,
  );
  return null;
}

/** One page of entries under CAP; `pending` marks the files the code reader has yet to parse. */
function anatomyPage(
  rows: FileRow[],
  pending: Set<string>,
  dir: string,
  pendingTotal: number,
): string {
  const entries = rows.map(
    (row) =>
      `- \`${row.path}\`${row.description ? ` — ${row.description}` : ""} (~${row.tokens} tok)${pending.has(row.path) ? " (symbols pending)" : ""}\n`,
  );
  const more = (i: number) =>
    `… ${rows.length - i} more files from ${rows[i]!.path}: crank-mem anatomy${dir ? ` ${dir}` : ""} --from ${rows[i]!.path}\n`;
  const pendingLine = pendingTotal > 0 ? `(${pendingTotal} file(s) still pending parse)\n` : "";
  let out = "";
  let shown = 0;
  while (shown < rows.length) {
    const footer = shown + 1 < rows.length ? more(shown + 1) : pendingLine;
    if (shown > 0 && out.length + entries[shown]!.length + footer.length > CAP) break;
    out += entries[shown++];
  }
  return out + (shown < rows.length ? more(shown) : pendingLine);
}

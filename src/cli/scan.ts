import { openProject } from "./project.ts";
import { busyReason, isBusy, openForRefresh, refreshGraph } from "./code-parse.ts";
import { errorMessage, type CrankConfig } from "../hooks/lib/config.ts";
import {
  deleteCodeDb,
  graphCounts,
  graphHealth,
  openCodeDb,
  refreshFileFacts,
} from "../hooks/lib/code-db.ts";
import { CLI_LOCK_BUDGET_MS } from "../hooks/lib/lock.ts";
import { ensureDaemon } from "../hooks/lib/spool.ts";
import { readStopState } from "../hooks/lib/user-state.ts";

/** How many parsed files pass between two progress lines. */
const PROGRESS_EVERY = 200;

export async function run(_args: string[]): Promise<number> {
  const project = openProject();
  if (!project) return 1;
  const { root, config } = project;
  try {
    // scan rebuilds whatever the store's state: corrupt, another version or unreadable.
    const probe = openCodeDb(root, "read");
    probe.db?.close();
    if (probe.status === "rebuild" || probe.status === "unreadable") deleteCodeDb(root);
    const refreshed = await refreshGraph(root, config, {
      deadlineMs: Infinity,
      busyMs: CLI_LOCK_BUDGET_MS,
      onProgress: (done, total) => {
        if (done % PROGRESS_EVERY === 0)
          console.error(`crank-mem: parsing ${done}/${total} files…`);
      },
    });
    if (refreshed.status === "unreadable" || refreshed.status === "readonly") {
      console.error(`crank-mem: .crank/code.db is not writable (${refreshed.reason})`);
      return 1;
    }
    if (refreshed.status === "no-parser") {
      // The file facts are recorded; like `outline`, only the parse needs the packages, so scan still succeeds.
      console.error(
        "crank-mem: the tree-sitter packages did not load, so symbols stay unparsed — run `crank-mem setup`.",
      );
    } else if (refreshed.pending > 0) {
      console.error(
        `crank-mem: code.db busy, ${refreshed.pending} files still unparsed — try again.`,
      );
      return 1;
    }
  } catch (err) {
    console.error(`crank-mem: ${errorMessage(err)}`);
    return 1;
  }
  console.log(scanCompleteLine(graphHealth(root).files));
  return 0;
}

/** The line a finished scan prints, from `scan` and from `upgrade`. */
export function scanCompleteLine(fileCount: number): string {
  return `crank-mem: full scan complete — ${fileCount} files indexed → .crank/code.db`;
}

export type FactsOutcome =
  | { status: "ok"; files: number; pending: number; changed: boolean }
  | { status: "busy" }
  | { status: "failed"; reason: string };

/**
 * Writes the project's file facts to `code.db` synchronously, with no deadline. A corrupt or
 * other-version store is rebuilt first. `changed` is true when the refresh added, changed or removed a file. Throws what the refresh throws, except a store busy past
 * its timeout. The caller starts the parse with `startParsing`.
 */
export function writeFileFacts(root: string, config: CrankConfig): FactsOutcome {
  const opened = openForRefresh(root, CLI_LOCK_BUDGET_MS);
  if (opened.status !== "open" || opened.db === undefined) {
    return busyReason(opened.reason)
      ? { status: "busy" }
      : { status: "failed", reason: opened.reason ?? opened.status };
  }
  try {
    const refresh = refreshFileFacts(root, config, opened.db, Infinity);
    const { files, pending } = graphCounts(opened.db);
    const changed = refresh.added + refresh.changed + refresh.removed > 0;
    return { status: "ok", files, pending, changed };
  } catch (err) {
    if (isBusy(err)) return { status: "busy" };
    throw err;
  } finally {
    opened.db.close();
  }
}

/** Starts the daemon that parses the files `pending` counts, unless none wait or a stop state is set. */
export function startParsing(config: CrankConfig, pending: number): void {
  if (pending > 0 && readStopState() === null) ensureDaemon(config);
}

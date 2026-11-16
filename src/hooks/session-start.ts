import * as fs from "node:fs";
import {
  readStdin,
  parsePayload,
  projectContext,
  emitAdditionalContext,
  runAdvisoryHook,
  isCodexPayload,
} from "./lib/hook-io.ts";
import { errorMessage, type CrankConfig } from "./lib/config.ts";
import { loadIndex, commitIndex } from "./lib/store.ts";
import { openCodeDb, pendingCount, refreshFileFacts } from "./lib/code-db.ts";
import { writeActivity } from "./lib/activity.ts";
import { ensureDaemon } from "./lib/spool.ts";
import { readStopState } from "./lib/user-state.ts";
import { refreshIndex } from "./lib/scanner.ts";
import { HOOK_LOCK_BUDGET_MS } from "./lib/lock.ts";
import { sessionStartInjection } from "./lib/injection.ts";
import { debugEvent } from "./lib/debug.ts";
import { hookActor, recordUsage } from "./lib/usage.ts";
import { registerProject } from "./lib/registry.ts";

// SessionStart hook (Claude Code and Codex). Every source re-injects, compaction
// included. Refreshes the index under lock, then emits the injection via
// hookSpecificOutput.additionalContext. sessionStartInjection applies the digest
// gate (ADR 0010).
// Advisory-only: every path exits 0.

const REFRESH_BUDGET_MS = 2_000;
// The code.db open leaves this much of the budget for the facts and activity writes.
const GRAPH_RESERVE_MS = 100;

/**
 * Brings code.db's file facts and activity current before `deadlineMs`, then starts the daemon
 * when files still await a parse and no stop state is set. A store that is corrupt, another
 * version, unreadable or read-only is left as it is. Never throws.
 */
function writeGraph(root: string, config: CrankConfig, deadlineMs: number): void {
  try {
    const opened = openCodeDb(
      root,
      "write",
      Math.max(0, deadlineMs - Date.now() - GRAPH_RESERVE_MS),
    );
    if (opened.status !== "open" || !opened.db) {
      debugEvent("graph-skip", { status: opened.status });
      return;
    }
    try {
      const refresh = refreshFileFacts(root, config, opened.db, deadlineMs);
      writeActivity(opened.db, root, config);
      debugEvent("graph-refresh", { ...refresh });
      if (pendingCount(opened.db) > 0 && readStopState() === null) ensureDaemon(config);
    } finally {
      opened.db.close();
    }
  } catch (err) {
    debugEvent("graph-failed", { error: errorMessage(err) });
  }
}

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const ctx = projectContext(payload);
  if (!ctx) return;
  const { root, crankDir, config } = ctx;
  try {
    // findProjectRoot keeps a symlinked cwd; the CLI registers the realpath.
    registerProject(fs.realpathSync(root));
  } catch {
    // A root that cannot be resolved stays unregistered until init or upgrade.
  }

  let stalenessNote: string | null = null;
  const refreshDeadline = Date.now() + REFRESH_BUDGET_MS;
  let index = commitIndex(crankDir, HOOK_LOCK_BUDGET_MS, (current) => {
    const startedRefresh = Date.now();
    const result = refreshIndex(root, config, current, REFRESH_BUDGET_MS);
    debugEvent("refresh", {
      ms: Date.now() - startedRefresh,
      changed: result.changed,
      added: result.added,
      removed: result.removed,
      partial: result.partial,
      fileCount: result.index.meta.fileCount,
    });
    return result.index;
  });

  if (index === null) {
    stalenessNote =
      "index refresh skipped (another writer holds the lock) — the file map may be slightly stale";
    index = loadIndex(crankDir);
  } else if (index.meta.partial) {
    stalenessNote =
      "index refresh ran out of time before covering every file — the file map may be slightly stale";
  }
  writeGraph(root, config, refreshDeadline);

  const result = sessionStartInjection(root, crankDir, config, index, {
    codex: isCodexPayload(payload),
    source: typeof payload.source === "string" ? payload.source : null,
    stalenessNote,
  });
  emitAdditionalContext("SessionStart", result.text);
  recordUsage(root, hookActor(payload), result.usage);
  console.error(`crank-mem: injected project memory (${index.meta.fileCount} files indexed)`);
}

await runAdvisoryHook("session-start", main);

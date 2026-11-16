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
import { openCodeDb, pendingCount, refreshFileFacts } from "./lib/code-db.ts";
import { writeActivity } from "./lib/activity.ts";
import { ensureDaemon } from "./lib/spool.ts";
import { readStopState } from "./lib/user-state.ts";
import { sessionStartInjection } from "./lib/injection.ts";
import { debugEvent } from "./lib/debug.ts";
import { hookActor, recordUsage } from "./lib/usage.ts";
import { registerProject } from "./lib/registry.ts";

// SessionStart hook (Claude Code and Codex). Every source re-injects, compaction
// included. Refreshes code.db's file facts, then emits the injection via
// hookSpecificOutput.additionalContext. sessionStartInjection applies the digest
// gate (ADR 0010).
// Advisory-only: every path exits 0.

const REFRESH_BUDGET_MS = 2_000;
// The code.db open leaves this much of the budget for the facts and activity writes.
const GRAPH_RESERVE_MS = 100;

const STALENESS_NOTE =
  "file refresh ran out of time before covering every file — the code graph may be slightly stale";

/**
 * Brings code.db's file facts and activity current before `deadlineMs`, then starts the daemon
 * when files still await a parse and no stop state is set. A store that is corrupt, another
 * version, unreadable or read-only is left as it is. Returns the staleness note for a refresh
 * that ran out of time. Never throws.
 */
function writeGraph(root: string, config: CrankConfig, deadlineMs: number): string | null {
  try {
    const opened = openCodeDb(
      root,
      "write",
      Math.max(0, deadlineMs - Date.now() - GRAPH_RESERVE_MS),
    );
    if (opened.status !== "open" || !opened.db) {
      debugEvent("graph-skip", { status: opened.status });
      return null;
    }
    try {
      const refresh = refreshFileFacts(root, config, opened.db, deadlineMs);
      writeActivity(opened.db, root, config);
      debugEvent("graph-refresh", { ...refresh });
      if (pendingCount(opened.db) > 0 && readStopState() === null) ensureDaemon(config);
      return refresh.partial ? STALENESS_NOTE : null;
    } finally {
      opened.db.close();
    }
  } catch (err) {
    debugEvent("graph-failed", { error: errorMessage(err) });
    return null;
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

  const stalenessNote = writeGraph(root, config, Date.now() + REFRESH_BUDGET_MS);

  const result = sessionStartInjection(root, crankDir, config, {
    codex: isCodexPayload(payload),
    source: typeof payload.source === "string" ? payload.source : null,
    stalenessNote,
  });
  emitAdditionalContext("SessionStart", result.text);
  recordUsage(root, hookActor(payload), result.usage);
  console.error("crank-mem: injected project memory");
}

await runAdvisoryHook("session-start", main);

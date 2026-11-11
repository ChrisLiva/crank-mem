import * as fs from "node:fs";
import * as path from "node:path";
import {
  readStdin,
  parsePayload,
  findProjectRoot,
  emitAdditionalContext,
  runAdvisoryHook,
  isCodexPayload,
} from "./lib/hook-io.ts";
import { loadConfig, CRANK_DIR } from "./lib/config.ts";
import { loadIndex, commitIndex } from "./lib/store.ts";
import { refreshIndex } from "./lib/scanner.ts";
import { HOOK_LOCK_BUDGET_MS } from "./lib/lock.ts";
import { sessionStartInjection } from "./lib/injection.ts";
import { enableDebug, debugEvent } from "./lib/debug.ts";
import { hookActor, recordUsage } from "./lib/usage.ts";
import { registerProject } from "./lib/registry.ts";

// SessionStart hook (Claude Code and Codex). Every source re-injects, compaction
// included. Refreshes the index under lock, then emits the injection via
// hookSpecificOutput.additionalContext. sessionStartInjection applies the digest
// gate (ADR 0010); no state carries an upkeep prompt, and journal.md is never read.
// Advisory-only: every path exits 0.

const REFRESH_BUDGET_MS = 2_000;

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const root = findProjectRoot(typeof payload.cwd === "string" ? payload.cwd : process.cwd());
  if (!root) return;
  try {
    // findProjectRoot keeps a symlinked cwd; the CLI registers the realpath.
    registerProject(fs.realpathSync(root));
  } catch {
    // A root that cannot be resolved stays unregistered until init or upgrade.
  }

  const crankDir = path.join(root, CRANK_DIR);
  const config = loadConfig(crankDir);
  enableDebug(crankDir, config.debug);

  let stalenessNote: string | null = null;
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

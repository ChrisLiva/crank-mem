import * as path from "node:path";
import {
  readStdin, parsePayload, findProjectRoot, emitAdditionalContext, runAdvisoryHook, isCodexPayload,
} from "./lib/hook-io.ts";
import { loadConfig, CRANK_DIR } from "./lib/config.ts";
import { loadIndex, commitIndex } from "./lib/store.ts";
import { refreshIndex } from "./lib/scanner.ts";
import { HOOK_LOCK_BUDGET_MS } from "./lib/lock.ts";
import { composeInjection, injectionSources } from "./lib/injection.ts";
import { driftNote } from "./lib/drift.ts";
import { trimJournal } from "./lib/journal.ts";
import { estimateProseTokens } from "./lib/tokens.ts";
import { enableDebug, debugEvent } from "./lib/debug.ts";

// SessionStart hook (Claude Code and Codex). Every source re-injects, compaction
// included; compact only skips the journal trim. Refreshes the index under
// lock, then emits the injection via hookSpecificOutput.additionalContext.
// Advisory-only: every path exits 0.

const REFRESH_BUDGET_MS = 2_000;

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const root = findProjectRoot(typeof payload.cwd === "string" ? payload.cwd : process.cwd());
  if (!root) return;

  const crankDir = path.join(root, CRANK_DIR);
  const config = loadConfig(crankDir);
  enableDebug(crankDir, config.debug);

  let stalenessNote: string | undefined;
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

  // `compact` fires mid-turn, while the agent may be appending an entry, and
  // the trim is an unlocked read-modify-write — so trim only on the sources
  // that start a turn. Reading for the injection is always safe.
  const source = typeof payload.source === "string" ? payload.source : null;
  if (source !== "compact") trimJournal(crankDir);
  const sources = injectionSources(root, crankDir, config, index);
  const drift = driftNote(config);
  const context = composeInjection(
    {
      ...sources,
      stalenessNote,
      driftNote: drift ?? undefined,
      codex: isCodexPayload(payload),
    },
    config.injection_budget_bytes
  ).text;

  emitAdditionalContext("SessionStart", context);
  debugEvent("injected", {
    source,
    fileCount: index.meta.fileCount,
    injectionTokens: estimateProseTokens(context),
    // Bytes bind, not tokens: see injection_budget_bytes in config.ts.
    injectionBytes: Buffer.byteLength(context, "utf-8"),
    budgetBytes: config.injection_budget_bytes,
    hasCerebrum: sources.cerebrumMd !== null,
    drift: drift !== null,
    journalBullets: sources.journalBullets.length,
    journalChanged: sources.journalChanged ?? null,
    adrCount: sources.adrFilenames.length,
    stale: stalenessNote !== undefined,
  });
  console.error(`crank-mem: injected project memory (${index.meta.fileCount} files indexed)`);
}

await runAdvisoryHook("session-start", main);

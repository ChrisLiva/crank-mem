import * as fs from "node:fs";
import * as path from "node:path";
import {
  readStdin, parsePayload, findProjectRoot, emitAdditionalContext, runAdvisoryHook,
} from "./lib/hook-io.ts";
import { loadConfig, CRANK_DIR } from "./lib/config.ts";
import { loadIndex, commitIndex } from "./lib/store.ts";
import { refreshIndex } from "./lib/scanner.ts";
import { HOOK_LOCK_BUDGET_MS } from "./lib/lock.ts";
import { buildInjection, listAdrFilenames } from "./lib/injection.ts";
import { estimateProseTokens } from "./lib/tokens.ts";
import { enableDebug, debugEvent } from "./lib/debug.ts";

// SessionStart hook (Claude Code + Codex; startup|resume|clear|compact all
// behave the same, so compaction re-injects). Refreshes the index under lock,
// then emits the injection via hookSpecificOutput.additionalContext.
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

  let cerebrumMd: string | null = null;
  try {
    cerebrumMd = fs.readFileSync(path.join(crankDir, "cerebrum.md"), "utf-8");
  } catch {}

  const adrFilenames = listAdrFilenames(root, config.adr_path);
  const context = buildInjection(
    {
      cerebrumMd,
      adrFilenames,
      index,
      stalenessNote,
      adrPath: config.adr_path,
    },
    config.injection_budget_bytes
  );

  emitAdditionalContext("SessionStart", context);
  debugEvent("injected", {
    source: typeof payload.source === "string" ? payload.source : null,
    fileCount: index.meta.fileCount,
    injectionTokens: estimateProseTokens(context),
    // Bytes, not tokens, are what Claude Code caps: past ~10KiB of hook stdout
    // it swaps the whole injection for a 2KB preview. Watch this, not tokens.
    injectionBytes: Buffer.byteLength(context, "utf-8"),
    budgetBytes: config.injection_budget_bytes,
    hasCerebrum: cerebrumMd !== null,
    adrCount: adrFilenames.length,
    stale: stalenessNote !== undefined,
  });
  console.error(`crank-mem: injected project memory (${index.meta.fileCount} files indexed)`);
}

await runAdvisoryHook("session-start", main);

import * as fs from "node:fs";
import * as path from "node:path";
import {
  readStdin, parsePayload, findProjectRoot, emitAdditionalContext, runAdvisoryHook,
} from "./lib/hook-io.ts";
import { loadConfig, CRANK_DIR } from "./lib/config.ts";
import { loadIndex, saveIndex, saveAnatomyMd } from "./lib/store.ts";
import { refreshIndex } from "./lib/scanner.ts";
import { withLock, HOOK_LOCK_BUDGET_MS } from "./lib/lock.ts";
import { buildInjection, listAdrFilenames } from "./lib/injection.ts";

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

  let stalenessNote: string | undefined;
  let index = loadIndex(crankDir);

  const refreshed = withLock(crankDir, HOOK_LOCK_BUDGET_MS, () => {
    const current = loadIndex(crankDir);
    const result = refreshIndex(root, config, current, REFRESH_BUDGET_MS);
    saveIndex(crankDir, result.index);
    saveAnatomyMd(crankDir, result.index);
    return result;
  });

  if (refreshed === null) {
    stalenessNote =
      "index refresh skipped (another writer holds the lock) — the file map may be slightly stale";
  } else {
    index = refreshed.index;
    if (refreshed.partial) {
      stalenessNote =
        "index refresh ran out of time before covering every file — the file map may be slightly stale";
    }
  }

  let cerebrumMd: string | null = null;
  try {
    cerebrumMd = fs.readFileSync(path.join(crankDir, "cerebrum.md"), "utf-8");
  } catch {}

  const context = buildInjection(
    {
      cerebrumMd,
      adrFilenames: listAdrFilenames(root, config.adr_path),
      index,
      stalenessNote,
      adrPath: config.adr_path,
    },
    config.injection_budget_tokens
  );

  emitAdditionalContext("SessionStart", context);
  console.error(`crank-mem: injected file map (${index.meta.fileCount} files)`);
}

await runAdvisoryHook("session-start", main);

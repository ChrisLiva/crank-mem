import * as path from "node:path";
import {
  readStdin, parsePayload, findProjectRoot, emitAdditionalContext, runAdvisoryHook, isCodexPayload,
} from "./lib/hook-io.ts";
import { CRANK_DIR, loadConfig } from "./lib/config.ts";
import { cerebrumNudge, cerebrumOverlaps } from "./lib/cerebrum-nudge.ts";
import { enableDebug } from "./lib/debug.ts";
import { signalDigest } from "./lib/spool.ts";
import { digestRunning } from "./lib/user-state.ts";

// Stop hook, Claude Code only. At turn end it emits cerebrumNudge and
// cerebrumOverlaps as additionalContext, which Claude wraps in a system
// reminder without forcing the agent to keep running, so the nudge stays
// advisory. With `digest` on it first writes the session's spool entry, the
// digest signal, before the stop_hook_active return, and starts the daemon
// unless digests are stopped. While digestRunning is true it emits nothing,
// since digests keep the memory (ADR 0010). Codex gets the nudge from
// post-write instead (ADR 0004). Every path exits 0.

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const root = findProjectRoot(typeof payload.cwd === "string" ? payload.cwd : process.cwd());
  if (!root) return;

  const crankDir = path.join(root, CRANK_DIR);
  const config = loadConfig(crankDir);
  enableDebug(crankDir, config.debug);
  // The signal comes first: the transcript grows during a continuation too.
  signalDigest(payload, root, config, false);
  // Already inside another Stop hook's continuation — don't stack reminders.
  if (payload.stop_hook_active === true) return;

  const codex = isCodexPayload(payload);
  const msg = digestRunning(config, codex)
    ? ""
    : [cerebrumNudge(crankDir, codex), cerebrumOverlaps(crankDir)].filter(Boolean).join("\n");
  if (!msg) return;
  emitAdditionalContext("Stop", msg);
  console.error("crank-mem: cerebrum nudge (stop)");
}

await runAdvisoryHook("stop", main);

import * as path from "node:path";
import {
  readStdin, parsePayload, findProjectRoot, emitAdditionalContext, runAdvisoryHook, isCodexPayload,
} from "./lib/hook-io.ts";
import { CRANK_DIR, loadConfig } from "./lib/config.ts";
import { cerebrumNudge, cerebrumOverlaps } from "./lib/cerebrum-nudge.ts";
import { enableDebug } from "./lib/debug.ts";

// Stop hook, Claude Code only. At turn end it emits cerebrumNudge and
// cerebrumOverlaps as additionalContext, which Claude wraps in a system
// reminder without forcing the agent to keep running, so the nudge stays
// advisory. Codex gets the nudge from post-write instead (ADR 0004). Every path
// exits 0.

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;
  // Already inside another Stop hook's continuation — don't stack reminders.
  if (payload.stop_hook_active === true) return;

  const root = findProjectRoot(typeof payload.cwd === "string" ? payload.cwd : process.cwd());
  if (!root) return;

  const crankDir = path.join(root, CRANK_DIR);
  enableDebug(crankDir, loadConfig(crankDir).debug);

  const msg = [cerebrumNudge(crankDir, isCodexPayload(payload)), cerebrumOverlaps(crankDir)].filter(Boolean).join("\n");
  if (!msg) return;
  emitAdditionalContext("Stop", msg);
  console.error("crank-mem: cerebrum nudge (stop)");
}

await runAdvisoryHook("stop", main);

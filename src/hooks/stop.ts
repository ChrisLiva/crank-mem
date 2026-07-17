import * as path from "node:path";
import {
  readStdin, parsePayload, findProjectRoot, emitAdditionalContext, runAdvisoryHook,
} from "./lib/hook-io.ts";
import { CRANK_DIR } from "./lib/config.ts";
import { cerebrumNudge } from "./lib/cerebrum-nudge.ts";

// Stop hook (Claude Code only). At turn end, if source files have changed since
// cerebrum.md was last touched, nudge the model to record what it learned. On
// Claude, additionalContext is wrapped in a system reminder at end of turn and
// the conversation continues WITHOUT forcing the agent to keep running — so the
// nudge stays advisory. Codex Stop has no such channel (probed 2026-07-17:
// systemMessage is inert; the only lever that reaches the model is a forced
// continuation, which the advisory-only invariant forbids), so Codex gets this
// nudge via post-write instead. See docs/adr/0004. Every path exits 0.

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;
  // Already inside another Stop hook's continuation — don't stack reminders.
  if (payload.stop_hook_active === true) return;

  const root = findProjectRoot(typeof payload.cwd === "string" ? payload.cwd : process.cwd());
  if (!root) return;

  const msg = cerebrumNudge(path.join(root, CRANK_DIR));
  if (!msg) return;
  emitAdditionalContext("Stop", msg);
  console.error("crank-mem: cerebrum nudge (stop)");
}

await runAdvisoryHook("stop", main);

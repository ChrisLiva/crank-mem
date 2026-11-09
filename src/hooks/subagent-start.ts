import * as path from "node:path";
import {
  readStdin,
  parsePayload,
  findProjectRoot,
  emitAdditionalContext,
  runAdvisoryHook,
} from "./lib/hook-io.ts";
import { loadConfig, CRANK_DIR } from "./lib/config.ts";
import { subagentInjection } from "./lib/injection.ts";
import { enableDebug } from "./lib/debug.ts";
import { hookActor, recordUsage } from "./lib/usage.ts";

// SubagentStart hook (Claude Code only). SessionStart never fires inside a
// subagent, and this channel reaches the subagent but not its parent (ADR
// 0007), so it is the only way memory reaches the agents doing most of the
// tool calls. The wiring's agent_type matcher picks which subagents get it.
// Every path exits 0.

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const root = findProjectRoot(typeof payload.cwd === "string" ? payload.cwd : process.cwd());
  if (!root) return;

  const crankDir = path.join(root, CRANK_DIR);
  const config = loadConfig(crankDir);
  enableDebug(crankDir, config.debug);

  const result = subagentInjection(root, crankDir, config, {
    agentType: typeof payload.agent_type === "string" ? payload.agent_type : null,
  });
  emitAdditionalContext("SubagentStart", result.text);
  recordUsage(root, hookActor(payload), result.usage);
  console.error("crank-mem: injected project memory (subagent)");
}

await runAdvisoryHook("subagent-start", main);

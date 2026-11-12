import {
  readStdin,
  parsePayload,
  projectContext,
  emitAdditionalContext,
  runAdvisoryHook,
} from "./lib/hook-io.ts";
import { subagentInjection } from "./lib/injection.ts";
import { hookActor, recordUsage } from "./lib/usage.ts";

// SubagentStart hook (Claude Code only). SessionStart never fires inside a
// subagent, and this channel reaches the subagent but not its parent (ADR
// 0007), so it is the only way memory reaches the agents doing most of the
// tool calls. The wiring's agent_type matcher picks which subagents get it.
// Every path exits 0.

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const ctx = projectContext(payload);
  if (!ctx) return;
  const { root, crankDir, config } = ctx;

  const result = subagentInjection(root, crankDir, config, {
    agentType: typeof payload.agent_type === "string" ? payload.agent_type : null,
  });
  emitAdditionalContext("SubagentStart", result.text);
  recordUsage(root, hookActor(payload), result.usage);
  console.error("crank-mem: injected project memory (subagent)");
}

await runAdvisoryHook("subagent-start", main);

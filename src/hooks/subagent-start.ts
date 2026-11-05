import * as fs from "node:fs";
import * as path from "node:path";
import {
  readStdin,
  parsePayload,
  findProjectRoot,
  emitAdditionalContext,
  runAdvisoryHook,
} from "./lib/hook-io.ts";
import { loadConfig, CRANK_DIR } from "./lib/config.ts";
import { loadIndex } from "./lib/store.ts";
import {
  CODE_BULLET,
  excerptOf,
  INJECTION_HEADING,
  RECALL_BULLET,
  recallApplies,
} from "./lib/injection.ts";
import { CEREBRUM_FILE } from "./lib/cerebrum-files.ts";
import { enableDebug } from "./lib/debug.ts";
import { digestGate } from "./lib/spool.ts";
import { memoryPath, memoryStatus } from "./lib/memory.ts";

// SubagentStart hook (Claude Code only). SessionStart never fires inside a
// subagent, and this channel reaches the subagent but not its parent (ADR
// 0007), so it is the only way memory reaches the agents doing most of the
// tool calls. Read-only, with no index refresh: a compact cerebrum excerpt
// labelled by section name, CODE_BULLET (the outline/unfold pointer) with no
// gate, so a project root always yields an injection, plus the recall pointer
// where recallApplies. The wiring's agent_type matcher picks which subagents
// get it. Every path exits 0.

/** Excerpt budget per spawn: a quarter of the session injection, paid per subagent. */
const SUBAGENT_EXCERPT_BYTES = 2048;

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const root = findProjectRoot(typeof payload.cwd === "string" ? payload.cwd : process.cwd());
  if (!root) return;

  const crankDir = path.join(root, CRANK_DIR);
  const config = loadConfig(crankDir);
  enableDebug(crankDir, config.debug);

  const running = digestGate(config, false, root).running;
  const recall = recallApplies(running, memoryStatus(memoryPath(root)));

  let md: string | null;
  try {
    md = fs.readFileSync(path.join(crankDir, CEREBRUM_FILE), "utf-8");
  } catch {
    md = null;
  }
  // Balanced: at this budget the session-start order leaves no room for memory.
  const excerpt = md
    ? excerptOf(md, SUBAGENT_EXCERPT_BYTES, { index: loadIndex(crankDir), root }, true).text
    : "";

  const lines = [INJECTION_HEADING];
  if (excerpt) {
    lines.push(
      `- Excerpt of \`.crank/cerebrum.md\`, this project's memory; grep it for more. Memory is not proof: verify a claim against the cited file before relying on it.`,
    );
  }
  lines.push(CODE_BULLET);
  if (recall) lines.push(RECALL_BULLET);
  if (excerpt) lines.push("", excerpt);
  emitAdditionalContext("SubagentStart", lines.join("\n"));
  console.error("crank-mem: injected project memory (subagent)");
}

await runAdvisoryHook("subagent-start", main);

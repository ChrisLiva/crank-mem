import * as fs from "node:fs";
import * as path from "node:path";
import { readStdin, parsePayload, findProjectRoot, emitAdditionalContext, runAdvisoryHook } from "./lib/hook-io.ts";
import { loadConfig, CRANK_DIR } from "./lib/config.ts";
import { loadIndex } from "./lib/store.ts";
import { cerebrumExcerpt, INJECTION_HEADING } from "./lib/injection.ts";
import { JOURNAL_FILE } from "./lib/journal.ts";
import { CEREBRUM_FILE } from "./lib/cerebrum-nudge.ts";
import { enableDebug } from "./lib/debug.ts";

// SubagentStart hook (Claude Code only). SessionStart never fires inside a
// subagent, and this channel reaches the subagent but not its parent (ADR
// 0007), so it is the only way memory reaches the agents doing most of the
// tool calls. Read-only: a compact cerebrum excerpt plus a pointer to the full
// files, with no index refresh. The wiring's agent_type matcher picks which
// subagents get it. Every path exits 0.

/** Excerpt budget per spawn: a quarter of the session injection, paid per subagent. */
const SUBAGENT_EXCERPT_BYTES = 2048;

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const root = findProjectRoot(typeof payload.cwd === "string" ? payload.cwd : process.cwd());
  if (!root) return;

  const crankDir = path.join(root, CRANK_DIR);
  enableDebug(crankDir, loadConfig(crankDir).debug);

  let md: string;
  try {
    md = fs.readFileSync(path.join(crankDir, CEREBRUM_FILE), "utf-8");
  } catch {
    return;
  }
  // Balanced: at this budget the session-start order leaves no room for memory.
  const excerpt = cerebrumExcerpt(md, SUBAGENT_EXCERPT_BYTES, { index: loadIndex(crankDir), root }, true);
  if (!excerpt) return;

  emitAdditionalContext(
    "SubagentStart",
    [
      INJECTION_HEADING,
      `- Excerpt of \`.crank/cerebrum.md\`, this project's agent-kept memory; grep it for more. Memory is not proof: verify a claim against the cited file before relying on it.`,
      `- Where the last session left off: \`.crank/${JOURNAL_FILE}\`.`,
      "",
      excerpt,
    ].join("\n"),
  );
  console.error("crank-mem: injected cerebrum excerpt (subagent)");
}

await runAdvisoryHook("subagent-start", main);

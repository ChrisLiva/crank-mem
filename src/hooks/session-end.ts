import * as path from "node:path";
import { readStdin, parsePayload, findProjectRoot, runAdvisoryHook } from "./lib/hook-io.ts";
import { CRANK_DIR, loadConfig } from "./lib/config.ts";
import { enableDebug } from "./lib/debug.ts";
import { signalDigest } from "./lib/spool.ts";

// SessionEnd hook, Claude Code only. Marks the session's spool entry ended so
// the digest job may take it. It prints nothing. Every path exits 0.

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const root = findProjectRoot(typeof payload.cwd === "string" ? payload.cwd : process.cwd());
  if (!root) return;

  const crankDir = path.join(root, CRANK_DIR);
  const config = loadConfig(crankDir);
  enableDebug(crankDir, config.debug);
  signalDigest(payload, root, config, true);
}

await runAdvisoryHook("session-end", main);

import { readStdin, parsePayload, projectContext, runAdvisoryHook } from "./lib/hook-io.ts";
import { signalDigest } from "./lib/spool.ts";

// SessionEnd hook, Claude Code only. Marks the session's spool entry ended so
// the digest job may take it. It prints nothing. Every path exits 0.

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const ctx = projectContext(payload);
  if (!ctx) return;
  signalDigest(payload, ctx.root, ctx.config, true);
}

await runAdvisoryHook("session-end", main);

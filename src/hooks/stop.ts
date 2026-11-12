import { readStdin, parsePayload, projectContext, runAdvisoryHook } from "./lib/hook-io.ts";
import { signalDigest } from "./lib/spool.ts";

// Stop hook, Claude Code only. With `digest` on it writes the session's spool
// entry, inside a Stop hook's continuation too, since the transcript grows
// there as well. It emits nothing to the model. Every path exits 0.

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const ctx = projectContext(payload);
  if (!ctx) return;
  signalDigest(payload, ctx.root, ctx.config, false);
}

await runAdvisoryHook("stop", main);

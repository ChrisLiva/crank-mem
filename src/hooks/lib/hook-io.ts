import * as fs from "node:fs";
import * as path from "node:path";
import { CRANK_DIR } from "./config.ts";

// Hook I/O helpers. Hooks are advisory-only: they must never fail the tool
// call, so payload parsing degrades to null and callers exit 0.

/** Read all of stdin (hooks receive one JSON payload then EOF). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

export interface HookPayload {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  source?: string;
  [key: string]: unknown;
}

export function parsePayload(raw: string): HookPayload | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as HookPayload) : null;
  } catch {
    return null;
  }
}

/**
 * Locate the project root (the dir containing `crank/`) by walking up from
 * `cwd`. Returns null when crank-mem isn't installed here.
 */
export function findProjectRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(dir, CRANK_DIR, "config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Emit model-visible context via hookSpecificOutput (both agents). */
export function emitAdditionalContext(hookEventName: string, context: string): void {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })
  );
}

/**
 * Run a hook's entry point under the advisory-only contract: errors are
 * reported to stderr (human/debug-only) and the process always exits 0.
 */
export async function runAdvisoryHook(name: string, main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (err) {
    console.error(`crank-mem ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}

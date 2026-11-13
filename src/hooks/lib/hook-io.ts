import * as fs from "node:fs";
import * as path from "node:path";
import {
  CRANK_DIR,
  errorMessage,
  isSensitiveFile,
  loadConfig,
  type CrankConfig,
} from "./config.ts";
import { enableDebug, flushDebug } from "./debug.ts";
import { toPosix } from "./indexable.ts";
import { ownerOf, type Owner } from "./owner.ts";

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
 * Codex tool payloads carry a turn_id, but its SessionStart does not (ADR 0007),
 * so also match the Codex transcript name, `rollout-<ts>-<uuid>.jsonl` (ADR 0006).
 * Claude carries neither.
 */
export function isCodexPayload(payload: HookPayload): boolean {
  if (typeof payload.turn_id === "string") return true;
  return (
    typeof payload.transcript_path === "string" &&
    path.basename(payload.transcript_path).startsWith("rollout-")
  );
}

/**
 * The installed project `cwd` belongs to by the ownership walk (`owner.ts`): its own root, or
 * a linked worktree's main checkout. Null when the walk reaches a repo that is not installed, or none.
 */
export function findProjectRoot(cwd: string): string | null {
  const owner = ownerOf(path.resolve(cwd));
  return owner.kind === "unowned" ? null : owner.root;
}

/**
 * The project a hook payload belongs to: its cwd (the payload's, else the process's),
 * root, `.crank/` dir and config, with debug logging enabled per that config.
 * Null when no root holds crank-mem.
 */
export function projectContext(
  payload: HookPayload,
): { cwd: string; root: string; crankDir: string; config: CrankConfig } | null {
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const root = findProjectRoot(cwd);
  if (!root) return null;
  const crankDir = path.join(root, CRANK_DIR);
  const config = loadConfig(crankDir);
  enableDebug(crankDir, config.debug);
  return { cwd, root, crankDir, config };
}

/** `p` (absolute, or relative to `cwd`) as a `/`-separated path under `root`; null for the root itself or outside it. */
export function repoRelative(root: string, cwd: string, p: string): string | null {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const r = path.relative(root, abs);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return null;
  return r.split(path.sep).join("/");
}

/**
 * The paths memory may record: those the ownership walk gives to `root` (not the root itself),
 * `/`-separated, never sensitive, deduped in input order.
 */
export function memoryPaths(root: string, cwd: string, paths: string[]): string[] {
  const kept = new Set<string>();
  for (const p of paths) {
    const owned = ownedPath(ownerOf(path.resolve(cwd, p)));
    if (owned !== null && owned.root === root) kept.add(owned.rel);
  }
  return [...kept];
}

/**
 * Where memory may record a path `owner` owns: the owning project's root (a worktree's main checkout) and the
 * `/`-separated path under it; null for an unowned path, the root itself or a sensitive basename.
 */
export function ownedPath(owner: Owner): { root: string; rel: string } | null {
  if (owner.kind === "unowned" || !owner.rel) return null;
  const rel = toPosix(owner.rel);
  return isSensitiveFile(path.posix.basename(rel)) ? null : { root: owner.root, rel };
}

/** Whether `rel` under `root` is a regular file now, following symlinks; false on any error. */
export function isProjectFile(root: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(root, rel), { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/** Emit model-visible context via hookSpecificOutput (both agents). */
export function emitAdditionalContext(hookEventName: string, context: string): void {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } }),
  );
}

/**
 * Run a hook's entry point under the advisory-only contract: errors are
 * reported to stderr (human/debug-only) and the process always exits 0.
 *
 * Also the single timing/outcome seam for every hook: one debug record per run,
 * carrying the full stack that the stderr line deliberately omits.
 */
export async function runAdvisoryHook(name: string, main: () => Promise<void>): Promise<void> {
  const started = Date.now();
  let error: unknown;
  try {
    await main();
  } catch (err) {
    error = err;
    console.error(`crank-mem ${name}: ${errorMessage(err)}`);
  }
  flushDebug({
    hook: name,
    ms: Date.now() - started,
    ok: error === undefined,
    ...(error !== undefined && {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }),
  });
  process.exit(0);
}

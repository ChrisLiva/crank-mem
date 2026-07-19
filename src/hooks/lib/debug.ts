import * as fs from "node:fs";
import * as path from "node:path";
import { isSensitiveFile } from "./config.ts";

// Opt-in observability for the hook paths.
//
// Hooks are advisory-only and silent by design: stderr is never model-visible
// (ADR 0001) and in practice nobody reads it, so a hook that has been throwing
// since install leaves no evidence anywhere. This writes one JSONL record per
// hook run to .crank/debug.log so that failure has a trace.
//
// Three rules this module must never break:
//  1. It never throws. A broken logger must not break an agent session — the
//     same invariant the hooks themselves hold, applied to the thing watching.
//  2. It never writes to stdout. That is the hookSpecificOutput protocol
//     channel and a stray byte corrupts the injection.
//  3. It never logs a sensitive path. The indexer refuses to read .env and
//     friends; the debug log must not leak by the back door what the index
//     deliberately excludes.

const LOG_FILE = "debug.log";
/** Past this, the log is discarded and restarted — a debug trace, not an audit log. */
const MAX_LOG_BYTES = 1024 * 1024;
/** Bounds memory if a caller logs in a loop. */
const MAX_EVENTS = 200;

interface DebugEvent {
  event: string;
  [key: string]: unknown;
}

let target: string | null = null;
const events: DebugEvent[] = [];

/**
 * Point the logger at a project. Called once per hook run, after the project
 * root and config are known. `CRANK_DEBUG=1` forces logging on for a single
 * session without editing config.json; `CRANK_DEBUG=0` forces it off.
 */
export function enableDebug(crankDir: string, configDebug: boolean): void {
  const env = process.env.CRANK_DEBUG;
  const on = env === "0" ? false : env ? true : configDebug;
  target = on ? path.join(crankDir, LOG_FILE) : null;
}

/**
 * Record an event. Always buffers, whether or not logging is on: call sites
 * run before `enableDebug` has located the project, and the flush decides.
 */
export function debugEvent(event: string, data?: Record<string, unknown>): void {
  if (events.length >= MAX_EVENTS) return;
  events.push({ event, ...data });
}

/** A path safe to record: sensitive basenames never reach the log. */
export function safePath(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return isSensitiveFile(base) ? "<redacted>" : relPath;
}

/**
 * Append this run's record and reset the buffer. Called once, from the hook
 * epilogue. Swallows every error — logging failure is never a session failure.
 */
export function flushDebug(record: Record<string, unknown>): void {
  const dest = target;
  const batch = events.slice();
  events.length = 0;
  if (!dest) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record, events: batch }) + "\n";
    try {
      if (fs.statSync(dest).size + line.length > MAX_LOG_BYTES) fs.unlinkSync(dest);
    } catch {
      // No log yet (or it vanished) — the append below creates it.
    }
    fs.appendFileSync(dest, line);
  } catch {
    // Read-only .crank/, disk full, permissions — stay silent and exit 0.
  }
}

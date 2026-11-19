import * as fs from "node:fs";
import * as path from "node:path";
import { isSensitiveFile } from "./config.ts";

// Opt-in trace of the hook paths: one JSONL record per hook run in
// .crank/debug.log. Hooks are silent by design, since stderr never reaches the
// model (ADR 0001), so a hook that throws leaves no other record.
//
// Three rules this module must never break:
//  1. It never throws.
//  2. It never writes to stdout, the hookSpecificOutput channel.
//  3. It never records a sensitive path.

export const LOG_FILE = "debug.log";
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
 * epilogue.
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

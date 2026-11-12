import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { debugEvent } from "./debug.ts";

// Cross-process mutual exclusion for anatomy writers.
//
// Mechanism: lockfile created with the "wx" flag (atomic O_EXCL on macOS,
// Linux and Windows, no native deps). The file body records the owner for
// staleness detection. A lock whose owner is on this host is stale when its
// pid is dead, or older than LIVE_OWNER_MAX_MS; any other lock is stale when
// older than STALE_MS. A stale lock is stolen via rename-then-unlink: rename
// is atomic, so of N competing stealers exactly one wins and the rest keep
// waiting. Release removes the lock only while it still holds our body.
//
// Callers NEVER block the agent: on budget exhaustion withLock returns null
// and the caller skips its update (the next writer converges the state).

export const LOCK_FILE = "anatomy-index.lock";
const STALE_MS = 10_000; // Matches the 10-second hook timeout that settings.ts sets.
/** Pid-reuse guard: a same-host lock this old is stale even when its pid is alive. */
const LIVE_OWNER_MAX_MS = 10 * 60_000;
/** Floor of the acquire poll backoff, and so the shortest wait that means real contention. */
const POLL_MIN_MS = 25;

export const HOOK_LOCK_BUDGET_MS = 2_000;
export const CLI_LOCK_BUDGET_MS = 5_000;

interface LockBody {
  pid: number;
  hostname: string;
  acquiredAt: number;
}

/** Dependency-free synchronous sleep. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True unless signalling `pid` reports no such process; EPERM means it lives under another user. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Creates the lock; returns the body written, or null when the lock exists. */
function tryAcquire(lockPath: string): string | null {
  try {
    const body: LockBody = { pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() };
    const text = JSON.stringify(body);
    fs.writeFileSync(lockPath, text, { flag: "wx" });
    return text;
  } catch {
    return null;
  }
}

function isStale(lockPath: string): boolean {
  try {
    const body = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockBody;
    if (typeof body.acquiredAt !== "number") return true;
    if (body.hostname === os.hostname() && typeof body.pid === "number") {
      if (!pidAlive(body.pid)) return true;
      return Date.now() - body.acquiredAt > LIVE_OWNER_MAX_MS;
    }
    return Date.now() - body.acquiredAt > STALE_MS;
  } catch {
    // Unreadable/corrupt lock body: only age can save us; treat unreadable
    // as stale so a garbage file cannot deadlock the system forever.
    try {
      const st = fs.statSync(lockPath);
      return Date.now() - st.mtimeMs > STALE_MS;
    } catch {
      return false; // vanished — next acquire attempt will settle it
    }
  }
}

function graveyardName(lockPath: string): string {
  return lockPath + "." + crypto.randomBytes(4).toString("hex") + ".stale";
}

/** Steal a stale lock: rename it to a random name and unlink that, so of N stealers one wins. */
export function trySteal(lockPath: string): void {
  const graveyard = graveyardName(lockPath);
  try {
    fs.renameSync(lockPath, graveyard);
    try {
      fs.unlinkSync(graveyard);
    } catch {}
  } catch {
    // Someone else won the steal or the owner released — keep waiting.
  }
}

/**
 * Run `fn` while holding the anatomy lock. Returns fn's result, or null if
 * the lock could not be acquired within `budgetMs` (caller must degrade
 * gracefully — skip the update, never block).
 */
export function withLock<T>(crankDir: string, budgetMs: number, fn: () => T): T | null {
  const lockPath = path.join(crankDir, LOCK_FILE);
  const started = Date.now();
  const deadline = started + budgetMs;
  let steals = 0;
  let ours: string | null;

  while (true) {
    ours = tryAcquire(lockPath);
    if (ours !== null) break;
    if (isStale(lockPath)) {
      trySteal(lockPath);
      steals++;
    }
    if (Date.now() >= deadline) {
      // The one place lock contention is unambiguous: commitIndex collapses
      // "lock lost" and "nothing to write" into the same null.
      debugEvent("lock-timeout", { waitedMs: Date.now() - started, budgetMs, steals });
      return null;
    }
    sleep(POLL_MIN_MS + Math.floor(Math.random() * POLL_MIN_MS));
  }
  // A wait shorter than one poll interval means the lock was free; below it,
  // only a steal is worth logging.
  const waitedMs = Date.now() - started;
  if (waitedMs >= POLL_MIN_MS || steals > 0) debugEvent("lock-waited", { waitedMs, steals });

  try {
    return fn();
  } finally {
    release(lockPath, ours);
  }
}

/** Removes the lock only while it holds `ours`; a lock another process took stays with it. */
function release(lockPath: string, ours: string): void {
  try {
    if (fs.readFileSync(lockPath, "utf-8") !== ours) return;
  } catch {
    return; // Gone: nothing of ours to remove.
  }
  const graveyard = graveyardName(lockPath);
  try {
    fs.renameSync(lockPath, graveyard);
  } catch {
    return;
  }
  let moved: string | null = null;
  try {
    moved = fs.readFileSync(graveyard, "utf-8");
  } catch {}
  if (moved !== ours) {
    // A steal landed between the read and the rename: put the new owner's lock back.
    try {
      fs.linkSync(graveyard, lockPath);
    } catch {
      // EEXIST: a newer lock already stands at lockPath.
    }
  }
  try {
    fs.unlinkSync(graveyard);
  } catch {}
}

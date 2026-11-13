import * as path from "node:path";
import { readJsonObject } from "./config.ts";
import { HOOK_LOCK_BUDGET_MS, withLock } from "./lock.ts";
import { isInstalled } from "./owner.ts";
import { crankHome, ensureCrankHome, writeJsonAtomic } from "./user-state.ts";
import type { UntouchedRepo } from "./wire.ts";

// The per-user list of git repos agents read or wrote that crank-mem is not installed in, kept at
// <crank home>/untouched.json. post-write and post-read add to it, once per run; stats and the dashboard read it.
// A list that cannot be read or written never changes a hook's outcome.

export const UNTOUCHED_FILE = "untouched.json";
const UNTOUCHED_LOCK_FILE = "untouched.lock";

const MAX_REPOS = 50;
const MAX_SESSIONS = 20;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function isRepo(r: unknown): r is UntouchedRepo {
  const e = r as UntouchedRepo;
  return (
    typeof e?.root === "string" &&
    typeof e.lastSeenMs === "number" &&
    Array.isArray(e.sessions) &&
    e.sessions.every((s) => typeof s === "string")
  );
}

/** The stored entries; a missing or malformed file reads as none. */
function readRepos(): UntouchedRepo[] {
  const repos = readJsonObject(path.join(crankHome(), UNTOUCHED_FILE))?.repos;
  return Array.isArray(repos) ? repos.filter(isRepo) : [];
}

const newestFirst = (a: UntouchedRepo, b: UntouchedRepo) => b.lastSeenMs - a.lastSeenMs;

/**
 * Note a read or write of each of `seen` now, from `session` when known, in one write under the list's lock;
 * keeps the MAX_REPOS newest repos and MAX_SESSIONS sessions each.
 */
export function recordUntouched(seen: Iterable<string>, session: string | null): void {
  const sighted = new Set(seen);
  if (sighted.size === 0) return;
  try {
    const home = ensureCrankHome();
    withLock(
      home,
      HOOK_LOCK_BUDGET_MS,
      () => {
        const now = Date.now();
        const repos = readRepos();
        const entries = [...sighted].map((repo) => {
          const sessions = repos.find((r) => r.root === repo)?.sessions ?? [];
          const next =
            session === null ? sessions : [...sessions.filter((s) => s !== session), session];
          return { root: repo, lastSeenMs: now, sessions: next.slice(-MAX_SESSIONS) };
        });
        const kept = [...entries, ...repos.filter((r) => !sighted.has(r.root))]
          .sort(newestFirst)
          .slice(0, MAX_REPOS);
        writeJsonAtomic(path.join(home, UNTOUCHED_FILE), { repos: kept });
      },
      UNTOUCHED_LOCK_FILE,
    );
  } catch {
    // An unwritable crank home loses the sightings, as a held lock (withLock's null) does; the next
    // read or write of the repo records it.
  }
}

/** The repos seen within MAX_AGE_MS that still have no install, newest first. */
export function readUntouched(): UntouchedRepo[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  return readRepos()
    .filter((r) => r.lastSeenMs >= cutoff && !isInstalled(r.root))
    .sort(newestFirst);
}

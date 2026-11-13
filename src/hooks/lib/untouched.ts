import * as path from "node:path";
import { readJsonObject } from "./config.ts";
import { isInstalled } from "./owner.ts";
import { crankHome, ensureCrankHome, writeJsonAtomic } from "./user-state.ts";
import type { UntouchedRepo } from "./wire.ts";

// The per-user list of git repos agents read or wrote that crank-mem is not installed in, kept at
// <crank home>/untouched.json. post-write and post-read add to it; stats and the dashboard read it.
// A list that cannot be read or written never changes a hook's outcome.

export const UNTOUCHED_FILE = "untouched.json";

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

/** Note a write to `repo` now, from `session` when known; keeps the 50 newest repos and 20 sessions each. */
export function recordUntouched(repo: string, session: string | null): void {
  try {
    const repos = readRepos();
    const sessions = repos.find((r) => r.root === repo)?.sessions ?? [];
    const next = session === null ? sessions : [...sessions.filter((s) => s !== session), session];
    const entry = { root: repo, lastSeenMs: Date.now(), sessions: next.slice(-MAX_SESSIONS) };
    const kept = [entry, ...repos.filter((r) => r.root !== repo)]
      .sort(newestFirst)
      .slice(0, MAX_REPOS);
    writeJsonAtomic(path.join(ensureCrankHome(), UNTOUCHED_FILE), { repos: kept });
  } catch {
    // An unwritable crank home loses the sighting; the next write to the repo records it.
  }
}

/** The repos seen in the last 30 days that still have no install, newest first. */
export function readUntouched(): UntouchedRepo[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  return readRepos()
    .filter((r) => r.lastSeenMs >= cutoff && !isInstalled(r.root))
    .sort(newestFirst);
}

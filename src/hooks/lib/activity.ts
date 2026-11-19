import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type * as sqlite from "node:sqlite";
import { transaction } from "./transaction.ts";
import type { CrankConfig } from "./config.ts";
import { debugEvent } from "./debug.ts";
import { byCodeUnit, isIndexableName } from "./indexable.ts";

// Git listing and churn-driven activity: the walk's git listing, the churn list and the write
// pins it settles in code.db.

interface Churn {
  /** HEAD sha the list was computed at; a moved HEAD recomputes it. */
  head: string;
  /** Indexable paths changed most often in recent commits, most first. */
  paths: string[];
}

// A large repo's ls-files listing can pass the 1 MiB default maxBuffer.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
// Churn's git calls get this budget, and the listing never gets less, so a hook's refresh
// keeps the listing even when its own deadline is shorter.
const GIT_TIMEOUT_MS = 500;
// The listing waits for the caller's deadline, at most this long; `Infinity` gets the cap.
const GIT_LISTING_CAP_MS = 30_000;

/** Run git in rootDir; on failure, the error code or exit status instead of stdout. Never throws. */
function runGit(
  rootDir: string,
  args: string[],
  timeoutMs: number,
): { stdout: string } | { error: string } {
  if (timeoutMs <= 0) return { error: "budget spent" };
  const res = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd: rootDir,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.error) return { error: (res.error as NodeJS.ErrnoException).code ?? res.error.message };
  if (res.status !== 0) return { error: `exit ${res.status}` };
  return { stdout: res.stdout };
}

/**
 * Tracked plus untracked-but-not-ignored paths; `timedOut` when git outlasts
 * max(GIT_TIMEOUT_MS, min(time left before `deadlineMs`, GIT_LISTING_CAP_MS));
 * null when root is not a git work tree root or git fails any other way.
 * Submodules list as one path (a directory, dropped by the isFile check), so
 * their contents are never indexed. An unmerged path lists once per conflict
 * stage, so the listing is deduplicated.
 */
export function gitListing(
  rootDir: string,
  deadlineMs: number,
): { files: string[] } | { timedOut: true } | null {
  if (!fs.existsSync(path.join(rootDir, ".git"))) return null;
  const timeoutMs = Math.max(GIT_TIMEOUT_MS, Math.min(deadlineMs - Date.now(), GIT_LISTING_CAP_MS));
  const r = runGit(rootDir, ["ls-files", "-co", "--exclude-standard", "-z"], timeoutMs);
  if ("error" in r) {
    if (r.error === "ETIMEDOUT") {
      debugEvent("walk-timeout", { timeoutMs });
      return { timedOut: true };
    }
    debugEvent("walk-fallback", { reason: r.error });
    return null;
  }
  return { files: [...new Set(r.stdout.split("\0").filter(Boolean))] };
}

const CHURN_COMMITS = 300;
// Bulk commits such as vendor syncs and mass renames say nothing about where
// work happens, and a few of them can make most of a repo's file touches.
const CHURN_BULK_FILES = 50;
const CHURN_KEEP = 100;
/** Written files kept pinned; the rest lose their write count. */
const MAX_PINS = 100;

/**
 * The indexable paths changed most often in the last CHURN_COMMITS commits,
 * skipping bulk commits. Reuses `cached` while HEAD has not moved; undefined
 * outside git, before the first commit, or when git fails.
 */
function churnFor(
  rootDir: string,
  config: CrankConfig,
  cached: Churn | undefined,
): Churn | undefined {
  if (!fs.existsSync(path.join(rootDir, ".git"))) return undefined;
  const rev = runGit(rootDir, ["rev-parse", "HEAD"], GIT_TIMEOUT_MS);
  if ("error" in rev) {
    debugEvent("churn-skipped", { reason: rev.error });
    return undefined;
  }
  const head = rev.stdout.trim();
  if (cached?.head === head) return cached;
  // One \x1e record per commit, then "\0\n" and NUL-separated paths.
  const log = runGit(
    rootDir,
    ["log", `-n${CHURN_COMMITS}`, "-z", "--name-only", "--format=%x1e"],
    GIT_TIMEOUT_MS,
  );
  if ("error" in log) {
    debugEvent("churn-skipped", { reason: log.error });
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const record of log.stdout.split("\x1e")) {
    const paths = record
      .split("\0")
      .map((p) => p.replace(/^\n/, ""))
      .filter(Boolean);
    if (paths.length > CHURN_BULK_FILES) continue;
    for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const paths = [...counts]
    .filter(([rel]) => isIndexableName(rel, config))
    .sort(([a, x], [b, y]) => y - x || byCodeUnit(a, b))
    .slice(0, CHURN_KEEP)
    .map(([rel]) => rel);
  return { head, paths };
}

const CHURN_META = "churn";

/** The churn list `writeActivity` last stored in `meta`; undefined when none is stored or it does not parse. */
export function readChurn(db: sqlite.DatabaseSync): Churn | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(CHURN_META) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  try {
    const churn = JSON.parse(row.value) as Partial<Churn> | null;
    if (typeof churn?.head === "string" && Array.isArray(churn.paths))
      return { head: churn.head, paths: churn.paths.filter((p) => typeof p === "string") };
  } catch {
    // An unreadable value is recomputed.
  }
  return undefined;
}

/**
 * The one writer of activity into code.db: the churn list (as `files.churn_rank` and the list
 * and its HEAD in `meta`), then the unpin rule: a file the
 * churn list carries, or one outside the MAX_PINS most recently modified written files, loses
 * its write count. Git runs before the write lock is taken.
 */
export function writeActivity(db: sqlite.DatabaseSync, rootDir: string, config: CrankConfig): void {
  const churn = churnFor(rootDir, config, readChurn(db));
  transaction(db, () => {
    db.exec("UPDATE files SET churn_rank = NULL WHERE churn_rank IS NOT NULL");
    if (churn) {
      const rank = db.prepare("UPDATE files SET churn_rank = ? WHERE path = ?");
      for (const [i, rel] of churn.paths.entries()) rank.run(i, rel);
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        CHURN_META,
        JSON.stringify(churn),
      );
    } else {
      db.prepare("DELETE FROM meta WHERE key = ?").run(CHURN_META);
    }
    db.exec("UPDATE files SET write_count = 0 WHERE write_count > 0 AND churn_rank IS NOT NULL");
    db.prepare(
      `UPDATE files SET write_count = 0 WHERE write_count > 0 AND path NOT IN
         (SELECT path FROM files WHERE write_count > 0 ORDER BY mtime_ms DESC, path LIMIT ?)`,
    ).run(MAX_PINS);
  });
}

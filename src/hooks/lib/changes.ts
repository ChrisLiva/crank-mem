import * as fs from "node:fs";
import * as path from "node:path";
import { isIndexableName, runGit } from "./scanner.ts";
import type { CrankConfig } from "./config.ts";
import type { AnatomyIndex } from "./store.ts";
import { debugEvent } from "./debug.ts";

// Changed-file detection from git. The index alone undercounts: agents change
// most files through Bash, which post-write never sees, and the index holds at
// most max_files entries, so writes past the cap vanish at the next refresh.

/** Wall time shared by both git calls; past it the caller falls back. */
export const GIT_CHANGES_BUDGET_MS = 500;

export interface ChangedFile {
  relPath: string;
  /** The file's mtime; for a deleted file, its nearest surviving ancestor directory's mtime. */
  changedMs: number;
}

/**
 * When the path last changed: its own mtime, or for a deleted path the mtime
 * of the nearest directory that still exists, which removing an entry bumps.
 */
function changeTime(rootDir: string, relPath: string): number | null {
  for (let p = relPath; ; p = path.posix.dirname(p)) {
    try {
      return fs.statSync(path.join(rootDir, p)).mtimeMs;
    } catch {}
    if (p === ".") return null;
  }
}

/**
 * Indexable files changed after sinceMs. Candidates are the uncommitted and
 * untracked paths from `git status` plus the paths touched by commits since
 * sinceMs from `git log`. A candidate counts only when its change time is
 * after sinceMs, so old untracked files and old edits committed later do not.
 *
 * Null when rootDir is not the root of a git work tree, when the branch has no
 * commits yet, or when git fails or overruns budgetMs; the caller then falls
 * back to the index. Never throws.
 */
export function gitChangedFiles(
  rootDir: string,
  config: CrankConfig,
  sinceMs: number,
  budgetMs = GIT_CHANGES_BUDGET_MS
): ChangedFile[] | null {
  if (!fs.existsSync(path.join(rootDir, ".git"))) return null;
  const deadline = Date.now() + budgetMs;
  const git = (args: string[]): string[] | null => {
    const r = runGit(rootDir, args, deadline - Date.now());
    if ("error" in r) {
      debugEvent("git-changes-failed", { command: args[0], error: r.error });
      return null;
    }
    return r.stdout.split("\0").filter(Boolean);
  };

  const status = git(["status", "--porcelain", "-z", "-uall"]);
  if (!status) return null;
  const log = git([
    "log", `--since=${new Date(sinceMs).toISOString()}`, "--name-only", "--no-renames", "--format=", "-z",
  ]);
  if (!log) return null;

  const candidates = new Set(log);
  for (let i = 0; i < status.length; i++) {
    const entry = status[i]!;
    candidates.add(entry.slice(3));
    // A rename or copy entry is followed by its source path as its own field.
    if (entry[0] === "R" || entry[0] === "C") candidates.add(status[++i] ?? "");
  }

  const out: ChangedFile[] = [];
  for (const relPath of candidates) {
    if (!relPath || !isIndexableName(relPath, config)) continue;
    const changedMs = changeTime(rootDir, relPath);
    if (changedMs !== null && changedMs > sinceMs) out.push({ relPath, changedMs });
  }
  return out;
}

/** Files changed after sinceMs, from git, else from the index's mtimes. Never throws. */
export function countChangedSince(rootDir: string, config: CrankConfig, index: AnatomyIndex, sinceMs: number): number {
  return (
    gitChangedFiles(rootDir, config, sinceMs)?.length ??
    Object.values(index.files).filter((e) => e.mtimeMs > sinceMs).length
  );
}

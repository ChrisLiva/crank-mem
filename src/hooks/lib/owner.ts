import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_FILE, CRANK_DIR, readJsonObject } from "./config.ts";

// Who owns a path: the nearest boundary above it, on path text alone (no symlinks, no git spawn).

export type Owner =
  | { kind: "project"; root: string; rel: string }
  | { kind: "worktree"; root: string; top: string; rel: string } // root = main checkout; top = worktree top
  | { kind: "unowned"; repo: string | null };

/** Where the walk stopped at a directory, independent of the path that reached it. */
type Stop =
  | { kind: "project"; root: string }
  | { kind: "worktree"; root: string; top: string }
  | { kind: "unowned"; repo: string };

const stops = new Map<string, Stop | null>();

export function isInstalled(dir: string): boolean {
  return fs.existsSync(path.join(dir, CRANK_DIR, CONFIG_FILE));
}

function gitEntry(dir: string): "dir" | { file: string } | null {
  const dotGit = path.join(dir, ".git");
  try {
    if (fs.statSync(dotGit).isDirectory()) return "dir";
    return { file: fs.readFileSync(dotGit, "utf-8") };
  } catch {
    return null;
  }
}

/** The main checkout a worktree `.git` file points into, or null when its `gitdir:` is not under `worktrees`. */
function mainOfGitFile(dir: string, text: string): string | null {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("gitdir:"));
  if (line === undefined) return null;
  const target = line.slice("gitdir:".length).trim();
  if (!target) return null;
  const gitdir = path.resolve(dir, target);
  if (path.basename(path.dirname(gitdir)) !== "worktrees") return null;
  return path.dirname(path.dirname(path.dirname(gitdir)));
}

function stopAt(dir: string): Stop | null {
  if (isInstalled(dir)) return { kind: "project", root: dir };
  const entry = gitEntry(dir);
  if (entry === null) return null;
  if (entry === "dir") return { kind: "unowned", repo: dir };
  const main = mainOfGitFile(dir, entry.file);
  if (main === null) return null;
  return isInstalled(main)
    ? { kind: "worktree", root: main, top: dir }
    : { kind: "unowned", repo: dir };
}

function memoStopAt(dir: string): Stop | null {
  if (stops.has(dir)) return stops.get(dir) ?? null;
  const stop = stopAt(dir);
  stops.set(dir, stop);
  return stop;
}

/** The owner of `absPath`: the first boundary on the walk up from the path itself. */
export function ownerOf(absPath: string): Owner {
  const abs = path.resolve(absPath);
  for (let dir = abs; ; dir = path.dirname(dir)) {
    const stop = memoStopAt(dir);
    if (stop?.kind === "project") return { ...stop, rel: path.relative(stop.root, abs) };
    if (stop?.kind === "worktree") return { ...stop, rel: path.relative(stop.top, abs) };
    if (stop) return stop;
    if (path.dirname(dir) === dir) return { kind: "unowned", repo: null };
  }
}

/**
 * A check of whether the walk up from a path reaches `root` before any other boundary. Each checker
 * reads each directory from disk once, so a fresh checker sees installs made since the last one.
 */
export function ownedBy(root: string): (absPath: string) => boolean {
  const top = path.resolve(root);
  const known = new Map<string, boolean>();
  const owned = (dir: string): boolean => {
    let answer = known.get(dir);
    if (answer !== undefined) return answer;
    if (dir === top) answer = true;
    else if (stopAt(dir) !== null || path.dirname(dir) === dir) answer = false;
    else answer = owned(path.dirname(dir));
    known.set(dir, answer);
    return answer;
  };
  return (absPath) => owned(path.resolve(absPath));
}

/** The installed main checkout of the linked worktree at `top`, read from disk on every call; else null. */
export function worktreeMain(top: string): string | null {
  const entry = gitEntry(top);
  if (entry === null || entry === "dir") return null;
  const main = mainOfGitFile(top, entry.file);
  return main !== null && isInstalled(main) ? main : null;
}

const NAME = /^[A-Za-z0-9._-]+$/;

/** The project's name: config.json → `name` when valid, else the root's basename with other characters as `-`. */
export function projectName(root: string): string {
  const name = readJsonObject(path.join(root, CRANK_DIR, CONFIG_FILE))?.name;
  if (typeof name === "string" && NAME.test(name)) return name;
  return path.basename(root).replace(/[^A-Za-z0-9._-]/g, "-");
}

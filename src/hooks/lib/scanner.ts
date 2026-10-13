import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describeFile, isGenerated } from "./describe.ts";
import { estimateTokens } from "./tokens.ts";
import { extractSymbols, symbolsSupported, SYMBOL_MIN_TOKENS } from "./symbols.ts";
import { isExcluded, type CrankConfig } from "./config.ts";
import { activePaths, emptyIndex, type AnatomyIndex, type Churn, type FileEntry } from "./store.ts";
import { debugEvent } from "./debug.ts";

// Project walk + full scan + incremental refresh. Reads the filesystem and,
// in a git repo, `git ls-files`; locking and persistence are the caller's job.

// Fast path ahead of the NUL sniff in indexFile, which catches the rest.
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".webp", ".avif", ".heic", ".heif",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".a", ".lib", ".o",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".avi", ".mov", ".webm", ".ogg",
  ".sqlite", ".db", ".wasm", ".npy", ".npz", ".lock",
]);

// Generated lockfiles the ".lock" extension misses (pnpm-lock.yaml, …).
const LOCKFILE = /(^|\/)(package-lock\.json|[^/]*-lock\.yaml)$/;

// git's binary heuristic: a NUL byte within the first 8,000 bytes.
const BINARY_SNIFF_BYTES = 8000;

// Test and spec files get no symbols: their names list cases, not an API.
const TEST_PATH = /(^|\/)(__tests__|tests?|specs?)\/|(^|\/)test_[^/]*$|[._-](test|spec)\.[^/]+$/;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Stat-free name gate: excluded, binary or lockfile paths are never indexable. */
export function isIndexableName(relPath: string, config: CrankConfig): boolean {
  if (isExcluded(relPath, config.excludes)) return false;
  if (BINARY_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return false;
  if (LOCKFILE.test(relPath)) return false;
  return true;
}

/**
 * The one gate for turning a path into a FileEntry: name checks, one stat,
 * size gate, read, NUL sniff, then analyze. Null on any rejection or I/O failure.
 */
export function indexFile(
  rootDir: string,
  relPath: string,
  config: CrankConfig
): FileEntry | null {
  if (!isIndexableName(relPath, config)) return null;
  const absPath = path.join(rootDir, relPath);
  let stat: fs.Stats;
  let buf: Buffer;
  try {
    stat = fs.statSync(absPath);
    if (stat.size > config.max_file_size_bytes) return null;
    buf = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  const content = buf.toString("utf-8");
  const ext = path.extname(absPath).toLowerCase();
  const tokens = estimateTokens(content, absPath);
  const symbols =
    tokens >= SYMBOL_MIN_TOKENS && symbolsSupported(ext) && !TEST_PATH.test(relPath) && !isGenerated(content)
      ? extractSymbols(content, ext)
      : undefined;
  const entry: FileEntry = {
    description: describeFile(absPath),
    tokens,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  if (symbols && symbols.length > 0) entry.symbols = symbols;
  return entry;
}

// Ranked last, never excluded: vendored code and asset trees. Config excludes
// cannot carry this, because each install keeps its own copy of them.
const DEMOTED_DIRS = new Set([
  "deps_src", "third_party", "vendor", "external", "node_modules",
  "resources", "assets", "static", "public",
]);

export const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".kt", ".scala", ".swift", ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp",
  ".m", ".mm", ".cs", ".rb", ".php", ".lua", ".dart", ".zig", ".sh", ".sql",
  ".css", ".scss", ".vue", ".svelte",
]);

/** 0 first-party code, 1 other first-party, 2 and 3 the same under a demoted dir. */
function rank(relPath: string): number {
  const dirs = relPath.split("/").slice(0, -1);
  const demoted = dirs.some((d) => DEMOTED_DIRS.has(d)) ? 2 : 0;
  return demoted + (SOURCE_EXTENSIONS.has(path.extname(relPath).toLowerCase()) ? 0 : 1);
}

// OrcaSlicer's listing is 1.37 MB, past spawnSync's 1 MiB default buffer.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
// walkProject runs before the refresh deadline is checked, so git gets its own.
const GIT_TIMEOUT_MS = 500;

export interface Walk {
  /** Indexable posix relpaths, at most config.max_files. */
  files: string[];
  /** True when at least one more indexable file lay past the cap. */
  truncated: boolean;
  /** Indexable-named candidates before the cap; null when the walk stopped uncounted. */
  candidateCount: number | null;
}

/** Run git in rootDir; on failure, the error code or exit status instead of stdout. Never throws. */
export function runGit(rootDir: string, args: string[], timeoutMs: number): { stdout: string } | { error: string } {
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
 * Tracked plus untracked-but-not-ignored paths, or null when root is not a
 * git work tree root or git fails. Submodules list as one path (a directory,
 * dropped by the isFile check), so their contents are never indexed. An
 * unmerged path lists once per conflict stage, so the listing is deduplicated.
 */
function gitListing(rootDir: string): string[] | null {
  if (!fs.existsSync(path.join(rootDir, ".git"))) return null;
  const r = runGit(rootDir, ["ls-files", "-co", "--exclude-standard", "-z"], GIT_TIMEOUT_MS);
  if ("error" in r) {
    debugEvent("walk-fallback", { reason: r.error });
    return null;
  }
  return [...new Set(r.stdout.split("\0").filter(Boolean))];
}

const CHURN_COMMITS = 300;
// Bulk commits (vendor syncs, mass renames) say nothing about where work
// happens: on OrcaSlicer 16 of the last 300 commits made 12,525 of its 13,932
// file touches.
const CHURN_BULK_FILES = 50;
const CHURN_KEEP = 100;

/**
 * The indexable paths changed most often in the last CHURN_COMMITS commits,
 * skipping bulk commits. Reuses `cached` while HEAD has not moved; undefined
 * outside git, before the first commit, or when git fails.
 */
function churnFor(rootDir: string, config: CrankConfig, cached: Churn | undefined): Churn | undefined {
  if (!fs.existsSync(path.join(rootDir, ".git"))) return undefined;
  const rev = runGit(rootDir, ["rev-parse", "HEAD"], GIT_TIMEOUT_MS);
  if ("error" in rev) {
    debugEvent("churn-skipped", { reason: rev.error });
    return undefined;
  }
  const head = rev.stdout.trim();
  if (cached?.head === head) return cached;
  // One \x1e record per commit, then "\0\n" and NUL-separated paths.
  const log = runGit(rootDir, ["log", `-n${CHURN_COMMITS}`, "-z", "--name-only", "--format=%x1e"], GIT_TIMEOUT_MS);
  if ("error" in log) {
    debugEvent("churn-skipped", { reason: log.error });
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const record of log.stdout.split("\x1e")) {
    const paths = record.split("\0").map((p) => p.replace(/^\n/, "")).filter(Boolean);
    if (paths.length > CHURN_BULK_FILES) continue;
    for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const paths = [...counts]
    .filter(([rel]) => isIndexableName(rel, config))
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, CHURN_KEEP)
    .map(([rel]) => rel);
  return { head, paths };
}

/**
 * Refresh the churn cache, unpin files the churn list now carries or that fall
 * past MAX_PINS, and return the paths the walk takes first.
 */
function updateActivity(rootDir: string, config: CrankConfig, index: AnatomyIndex): string[] {
  const churn = churnFor(rootDir, config, index.meta.churn);
  if (churn) index.meta.churn = churn;
  else delete index.meta.churn;
  const inChurn = new Set(churn?.paths);
  for (const [rel, entry] of Object.entries(index.files)) if (inChurn.has(rel)) delete entry.writeCount;
  const active = activePaths(index);
  const kept = new Set(active);
  for (const [rel, entry] of Object.entries(index.files)) if (!kept.has(rel)) delete entry.writeCount;
  return active;
}

/** A fresh entry keeps the write pin of the entry it replaces. */
function keepPin(entry: FileEntry, prior: FileEntry | undefined): FileEntry {
  if (prior?.writeCount) entry.writeCount = prior.writeCount;
  return entry;
}

// lstat, as the tree walk's Dirent does: symlinks, submodules and
// deleted-but-tracked paths are not files to index. An oversized file would
// take a max_files slot that indexFile then leaves empty: 15 of OrcaSlicer's 500.
function isWalkableFile(rootDir: string, rel: string, config: CrankConfig): boolean {
  try {
    const stat = fs.lstatSync(path.join(rootDir, rel));
    return stat.isFile() && stat.size <= config.max_file_size_bytes;
  } catch {
    return false;
  }
}

/**
 * List indexable files: `seeds` first, then in a git repo git's listing ranked
 * first-party code first, elsewhere a sorted directory walk. Both stop at
 * config.max_files and report whether they had to. In a git repo a seed must
 * be in git's listing, so writes that post-write indexes under a gitignored
 * path drop out again at the next refresh.
 */
export function walkProject(rootDir: string, config: CrankConfig, seeds: string[] = []): Walk {
  const listed = gitListing(rootDir);
  return listed ? walkListing(rootDir, listed, config, seeds) : walkTree(rootDir, config, seeds);
}

function walkListing(rootDir: string, listed: string[], config: CrankConfig, seeds: string[]): Walk {
  const candidates = listed.filter((rel) => isIndexableName(rel, config));
  const candidateSet = new Set(candidates);
  const first = seeds.filter((rel) => candidateSet.has(rel));
  const firstSet = new Set(first);
  const ranked = candidates
    .filter((rel) => !firstSet.has(rel))
    .map((rel) => ({ rel, rank: rank(rel) }))
    .sort((a, b) => a.rank - b.rank || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map(({ rel }) => rel);
  const files: string[] = [];
  for (const rel of [...first, ...ranked]) {
    if (!isWalkableFile(rootDir, rel, config)) continue;
    if (files.length === config.max_files) return { files, truncated: true, candidateCount: candidates.length };
    files.push(rel);
  }
  return { files, truncated: false, candidateCount: candidates.length };
}

function walkTree(rootDir: string, config: CrankConfig, seeds: string[]): Walk {
  // Collects one past the cap, the cheapest proof that the cap cut something.
  const limit = config.max_files + 1;
  const out = seeds.filter((rel) => isIndexableName(rel, config) && isWalkableFile(rootDir, rel, config)).slice(0, limit);
  const seeded = new Set(out);
  const walk = (dir: string): void => {
    if (out.length >= limit) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (out.length >= limit) return;
      const full = path.join(dir, item.name);
      const rel = toPosix(path.relative(rootDir, full));
      if (item.isDirectory()) {
        if (!isExcluded(rel, config.excludes)) walk(full);
      } else if (item.isFile()) {
        if (!seeded.has(rel) && isIndexableName(rel, config)) out.push(rel);
      }
    }
  };
  walk(rootDir);
  if (out.length < limit) return { files: out, truncated: false, candidateCount: out.length };
  return { files: out.slice(0, config.max_files), truncated: true, candidateCount: null };
}

function recordWalk(index: AnatomyIndex, walk: Walk): void {
  if (walk.truncated) index.meta.truncated = true;
  else delete index.meta.truncated;
  if (walk.candidateCount !== null) index.meta.candidateCount = walk.candidateCount;
  else delete index.meta.candidateCount;
}

/** Full scan: fresh index from a walk, keeping `previous`'s pins and churn cache. */
export function fullScan(rootDir: string, config: CrankConfig, previous: AnatomyIndex = emptyIndex()): AnatomyIndex {
  const seeds = updateActivity(rootDir, config, previous);
  const index = emptyIndex();
  const walk = walkProject(rootDir, config, seeds);
  for (const rel of walk.files) {
    const entry = indexFile(rootDir, rel, config);
    if (entry) index.files[rel] = keepPin(entry, previous.files[rel]);
  }
  if (previous.meta.churn) index.meta.churn = previous.meta.churn;
  index.meta.lastScanned = new Date().toISOString();
  index.meta.fileCount = Object.keys(index.files).length;
  recordWalk(index, walk);
  return index;
}

export interface RefreshResult {
  index: AnatomyIndex;
  changed: number;
  added: number;
  removed: number;
  /** True if the time budget expired before all diffs were processed. */
  partial: boolean;
}

/**
 * Incremental refresh: diff the walk against the index by size+mtime.
 * Re-extracts changed files, adds new, drops deleted. Time-boxed; on budget
 * exhaustion returns partial=true with whatever converged.
 */
export function refreshIndex(
  rootDir: string,
  config: CrankConfig,
  index: AnatomyIndex,
  budgetMs: number
): RefreshResult {
  const deadline = Date.now() + budgetMs;
  const walk = walkProject(rootDir, config, updateActivity(rootDir, config, index));
  const walked = walk.files;
  const walkedSet = new Set(walked);
  let changed = 0, added = 0, removed = 0, partial = false;

  // Deletions are cheap — always process them all.
  for (const rel of Object.keys(index.files)) {
    if (!walkedSet.has(rel)) {
      delete index.files[rel];
      removed++;
    }
  }

  for (const rel of walked) {
    if (Date.now() >= deadline) {
      partial = true;
      break;
    }
    const existing = index.files[rel];
    const abs = path.join(rootDir, rel);
    if (existing) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size === existing.size && stat.mtimeMs === existing.mtimeMs) continue;
      const entry = indexFile(rootDir, rel, config);
      if (entry) {
        index.files[rel] = keepPin(entry, existing);
        changed++;
      } else {
        // No longer indexable (grew past the size cap, became unreadable) —
        // drop the stale entry rather than carry it forever.
        delete index.files[rel];
        removed++;
      }
    } else {
      const entry = indexFile(rootDir, rel, config);
      if (entry) {
        index.files[rel] = entry;
        added++;
      }
    }
  }

  index.meta.lastScanned = new Date().toISOString();
  index.meta.fileCount = Object.keys(index.files).length;
  if (partial) index.meta.partial = true;
  else delete index.meta.partial;
  recordWalk(index, walk);
  return { index, changed, added, removed, partial };
}

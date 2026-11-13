import * as fs from "node:fs";
import * as path from "node:path";
import { describeFile, isGenerated } from "./describe.ts";
import { estimateTokens } from "./tokens.ts";
import { extractSymbols, symbolsSupported, SYMBOL_MIN_TOKENS } from "./symbols.ts";
import { isExcluded, type CrankConfig } from "./config.ts";
import { emptyIndex, type AnatomyIndex, type FileEntry } from "./store.ts";
import { BINARY_SNIFF_BYTES, isIndexableName, TEST_PATH, toPosix } from "./indexable.ts";
import { gitListing, keepPin, updateActivity } from "./activity.ts";
import { fileLinks } from "./imports.ts";
import { ownedBy } from "./owner.ts";

// Project walk + full scan + incremental refresh. Reads the filesystem and,
// in a git repo, `git ls-files`; locking and persistence are the caller's job.

/**
 * The one gate for turning a path into a FileEntry: name checks, one stat,
 * size gate, read, NUL sniff, then analyze. Null on any rejection or I/O failure.
 */
export function indexFile(rootDir: string, relPath: string, config: CrankConfig): FileEntry | null {
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
    tokens >= SYMBOL_MIN_TOKENS &&
    symbolsSupported(ext) &&
    !TEST_PATH.test(relPath) &&
    !isGenerated(content)
      ? extractSymbols(content, ext)
      : undefined;
  const entry: FileEntry = {
    description: describeFile(absPath),
    tokens,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  if (symbols && symbols.length > 0) entry.symbols = symbols;
  return { ...entry, ...fileLinks(rootDir, relPath, content, config) };
}

// Ranked last, never excluded: vendored code and asset trees. Config excludes
// cannot carry this, because each install keeps its own copy of them.
const DEMOTED_DIRS = new Set([
  "deps_src",
  "third_party",
  "vendor",
  "external",
  "node_modules",
  "resources",
  "assets",
  "static",
  "public",
]);

export const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".scala",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".m",
  ".mm",
  ".cs",
  ".rb",
  ".php",
  ".lua",
  ".dart",
  ".zig",
  ".sh",
  ".sql",
  ".css",
  ".scss",
  ".vue",
  ".svelte",
]);

/** 0 first-party code, 1 other first-party, 2 and 3 the same under a demoted dir. */
function rank(relPath: string): number {
  const dirs = relPath.split("/").slice(0, -1);
  const demoted = dirs.some((d) => DEMOTED_DIRS.has(d)) ? 2 : 0;
  return demoted + (SOURCE_EXTENSIONS.has(path.extname(relPath).toLowerCase()) ? 0 : 1);
}

export interface Walk {
  /** Indexable posix relpaths, at most config.max_files. */
  files: string[];
  /** True when at least one more indexable file lay past the cap. */
  truncated: boolean;
  /** Indexable-named candidates before the cap; null when the walk stopped uncounted. */
  candidateCount: number | null;
}

// lstat, as the tree walk's Dirent does: symlinks, submodules and
// deleted-but-tracked paths are not files to index. An oversized file would
// take a max_files slot that indexFile then leaves empty.
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
 * path drop out again at the next refresh. Only paths `rootDir` owns count: the
 * walk skips another project's or repo's files and never enters their directories.
 */
export function walkProject(rootDir: string, config: CrankConfig, seeds: string[] = []): Walk {
  const ownedPath = ownedBy(rootDir);
  const owned = (rel: string): boolean => ownedPath(path.join(rootDir, rel));
  const listed = gitListing(rootDir);
  const ownedSeeds = seeds.filter(owned);
  return listed
    ? walkListing(rootDir, listed.filter(owned), config, ownedSeeds)
    : walkTree(rootDir, config, ownedSeeds, owned);
}

function walkListing(
  rootDir: string,
  listed: string[],
  config: CrankConfig,
  seeds: string[],
): Walk {
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
    if (files.length === config.max_files)
      return { files, truncated: true, candidateCount: candidates.length };
    files.push(rel);
  }
  return { files, truncated: false, candidateCount: candidates.length };
}

function walkTree(
  rootDir: string,
  config: CrankConfig,
  seeds: string[],
  owned: (rel: string) => boolean,
): Walk {
  // Collects one past the cap, the cheapest proof that the cap cut something.
  const limit = config.max_files + 1;
  const out = seeds
    .filter((rel) => isIndexableName(rel, config) && isWalkableFile(rootDir, rel, config))
    .slice(0, limit);
  const seeded = new Set(out);
  const enters = (rel: string): boolean => !isExcluded(rel, config.excludes) && owned(rel);
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
        if (enters(rel)) walk(full);
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
export function fullScan(
  rootDir: string,
  config: CrankConfig,
  previous: AnatomyIndex = emptyIndex(),
): AnatomyIndex {
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
  budgetMs: number,
): RefreshResult {
  const deadline = Date.now() + budgetMs;
  const walk = walkProject(rootDir, config, updateActivity(rootDir, config, index));
  const walked = walk.files;
  let changed = 0,
    added = 0,
    partial = false;
  // Deletions are cheap — always process them all.
  let removed = dropMissing(index, new Set(walked));

  for (const rel of walked) {
    if (Date.now() >= deadline) {
      partial = true;
      break;
    }
    const outcome = refreshOne(rootDir, rel, config, index);
    if (outcome === "changed") changed++;
    else if (outcome === "added") added++;
    else if (outcome === "removed") removed++;
  }

  stampMeta(index, partial, walk);
  return { index, changed, added, removed, partial };
}

/** Drops every indexed file the walk no longer lists; returns how many. */
function dropMissing(index: AnatomyIndex, walkedSet: Set<string>): number {
  let removed = 0;
  for (const rel of Object.keys(index.files)) {
    if (!walkedSet.has(rel)) {
      delete index.files[rel];
      removed++;
    }
  }
  return removed;
}

/** Re-indexes one walked file when its size or mtime moved, or adds it when new. */
function refreshOne(
  rootDir: string,
  rel: string,
  config: CrankConfig,
  index: AnatomyIndex,
): "changed" | "added" | "removed" | null {
  const existing = index.files[rel];
  if (!existing) {
    const entry = indexFile(rootDir, rel, config);
    if (!entry) return null;
    index.files[rel] = entry;
    return "added";
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path.join(rootDir, rel));
  } catch {
    return null;
  }
  if (stat.size === existing.size && stat.mtimeMs === existing.mtimeMs) return null;
  const entry = indexFile(rootDir, rel, config);
  if (entry) {
    index.files[rel] = keepPin(entry, existing);
    return "changed";
  }
  // No longer indexable (grew past the size cap, became unreadable) —
  // drop the stale entry rather than carry it forever.
  delete index.files[rel];
  return "removed";
}

function stampMeta(index: AnatomyIndex, partial: boolean, walk: Walk): void {
  index.meta.lastScanned = new Date().toISOString();
  index.meta.fileCount = Object.keys(index.files).length;
  if (partial) index.meta.partial = true;
  else delete index.meta.partial;
  recordWalk(index, walk);
}

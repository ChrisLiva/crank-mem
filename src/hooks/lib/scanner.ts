import * as fs from "node:fs";
import * as path from "node:path";
import { describeFile, isGenerated } from "./describe.ts";
import { estimateTokens } from "./tokens.ts";
import { isExcluded, type CrankConfig } from "./config.ts";
import { BINARY_SNIFF_BYTES, isIndexableName, SOURCE_EXTENSIONS, toPosix } from "./indexable.ts";
import { gitListing } from "./activity.ts";
import { ownedBy } from "./owner.ts";

// Project walk and per-file facts. Reads the filesystem and, in a git repo, `git ls-files`;
// persistence is the caller's job.

/** What `code.db`'s `files` table holds for one file. */
export interface FileFacts {
  size: number;
  mtimeMs: number;
  tokens: number;
  description: string;
  generated: boolean;
}

/**
 * The one gate for a path's facts: name checks, one stat, size gate, read, NUL sniff, then the
 * facts `code.db` keeps. Null on any rejection or I/O failure.
 */
export function fileFacts(rootDir: string, relPath: string, config: CrankConfig): FileFacts | null {
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
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    tokens: estimateTokens(content, absPath),
    description: describeFile(absPath),
    generated: isGenerated(content),
  };
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

/** 0 first-party code, 1 other first-party, 2 and 3 the same under a demoted dir. */
export function rank(relPath: string): number {
  const dirs = relPath.split("/").slice(0, -1);
  const demoted = dirs.some((d) => DEMOTED_DIRS.has(d)) ? 2 : 0;
  return demoted + (SOURCE_EXTENSIONS.has(path.extname(relPath).toLowerCase()) ? 0 : 1);
}

// lstat, as the tree walk's Dirent does: symlinks, submodules and deleted-but-tracked paths are
// not files to index.
function isWalkableFile(rootDir: string, rel: string, config: CrankConfig): boolean {
  try {
    const stat = fs.lstatSync(path.join(rootDir, rel));
    return stat.isFile() && stat.size <= config.max_file_size_bytes;
  } catch {
    return false;
  }
}

/**
 * Every indexable file, no cap: in a git repo git's listing ranked first-party code first,
 * elsewhere a sorted directory walk. Only paths `rootDir` owns count: the walk skips another
 * project's or repo's files and never enters their directories. Null when git's listing outlasts
 * the budget `deadlineMs` gives it (`gitListing`), so the caller keeps what it has rather than
 * walking files git would ignore.
 */
export function walkProject(
  rootDir: string,
  config: CrankConfig,
  deadlineMs: number,
): string[] | null {
  const ownedPath = ownedBy(rootDir);
  const owned = (rel: string): boolean => ownedPath(path.join(rootDir, rel));
  const listed = gitListing(rootDir, deadlineMs);
  if (listed && "timedOut" in listed) return null;
  return listed
    ? walkListing(rootDir, listed.files.filter(owned), config)
    : walkTree(rootDir, config, owned);
}

function walkListing(rootDir: string, listed: string[], config: CrankConfig): string[] {
  return listed
    .filter((rel) => isIndexableName(rel, config))
    .map((rel) => ({ rel, rank: rank(rel) }))
    .sort((a, b) => a.rank - b.rank || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map(({ rel }) => rel)
    .filter((rel) => isWalkableFile(rootDir, rel, config));
}

function walkTree(rootDir: string, config: CrankConfig, owned: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const enters = (rel: string): boolean => !isExcluded(rel, config.excludes) && owned(rel);
  const walk = (dir: string): void => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const full = path.join(dir, item.name);
      const rel = toPosix(path.relative(rootDir, full));
      if (item.isDirectory()) {
        if (enters(rel)) walk(full);
      } else if (item.isFile() && isIndexableName(rel, config)) {
        out.push(rel);
      }
    }
  };
  walk(rootDir);
  return out;
}

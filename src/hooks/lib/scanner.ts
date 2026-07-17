import * as fs from "node:fs";
import * as path from "node:path";
import { describeFile } from "./describe.ts";
import { estimateTokens } from "./tokens.ts";
import { extractSymbols, symbolsSupported, SYMBOL_MIN_TOKENS } from "./symbols.ts";
import { isExcluded, type CrankConfig } from "./config.ts";
import { emptyIndex, type AnatomyIndex, type FileEntry } from "./store.ts";

// Project walk + full scan + incremental refresh. Pure over the filesystem;
// locking and persistence are the caller's job.

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".avi", ".mov", ".webm", ".ogg",
  ".sqlite", ".db", ".wasm", ".lock",
]);

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** True if this path should be indexed at all (not binary/excluded/oversized). */
export function isIndexable(relPath: string, sizeBytes: number, config: CrankConfig): boolean {
  if (isExcluded(relPath, config.excludes)) return false;
  if (BINARY_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return false;
  if (sizeBytes > config.max_file_size_bytes) return false;
  return true;
}

/** Build a FileEntry for one file. Returns null if unreadable. */
export function indexFile(absPath: string, source: FileEntry["source"]): FileEntry | null {
  let stat: fs.Stats;
  let content: string;
  try {
    stat = fs.statSync(absPath);
    content = fs.readFileSync(absPath, "utf-8");
  } catch {
    return null;
  }
  const ext = path.extname(absPath).toLowerCase();
  const tokens = estimateTokens(content, absPath);
  const symbols =
    tokens >= SYMBOL_MIN_TOKENS && symbolsSupported(ext) ? extractSymbols(content, ext) : undefined;
  const entry: FileEntry = {
    description: describeFile(absPath),
    tokens,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    updatedAt: new Date().toISOString(),
    source,
  };
  if (symbols && symbols.length > 0) entry.symbols = symbols;
  return entry;
}

/** Walk the project, listing indexable files (posix relpaths, sorted, capped). */
export function walkProject(rootDir: string, config: CrankConfig): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= config.max_files) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (out.length >= config.max_files) return;
      const full = path.join(dir, item.name);
      const rel = toPosix(path.relative(rootDir, full));
      if (item.isDirectory()) {
        if (!isExcluded(rel + "/", config.excludes) && !isExcluded(rel, config.excludes)) walk(full);
      } else if (item.isFile()) {
        let size: number;
        try {
          size = fs.statSync(full).size;
        } catch {
          continue;
        }
        if (isIndexable(rel, size, config)) out.push(rel);
      }
    }
  };
  walk(rootDir);
  return out;
}

/** Full scan: fresh index from a walk. */
export function fullScan(rootDir: string, config: CrankConfig): AnatomyIndex {
  const index = emptyIndex();
  for (const rel of walkProject(rootDir, config)) {
    const entry = indexFile(path.join(rootDir, rel), "scan");
    if (entry) index.files[rel] = entry;
  }
  index.meta.lastScanned = new Date().toISOString();
  index.meta.fileCount = Object.keys(index.files).length;
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
  const walked = walkProject(rootDir, config);
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
      const entry = indexFile(abs, "scan");
      if (entry) {
        index.files[rel] = entry;
        changed++;
      }
    } else {
      const entry = indexFile(abs, "scan");
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
  return { index, changed, added, removed, partial };
}

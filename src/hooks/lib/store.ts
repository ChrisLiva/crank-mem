import * as fs from "node:fs";
import * as path from "node:path";
import { withLock } from "./lock.ts";
import type { SymbolEntry } from "./symbols.ts";

// anatomy-index.json load/save. Corrupt or missing index degrades to empty —
// the next full scan reconverges; nothing here may throw out of load.

export const INDEX_VERSION = 1;
export const INDEX_FILE = "anatomy-index.json";
export const ANATOMY_FILE = "anatomy.md";

export interface FileEntry {
  description: string;
  tokens: number;
  size: number;
  mtimeMs: number;
  symbols?: SymbolEntry[];
  /** Agent writes since the file last showed up in the churn list; pins it past the cap. */
  writeCount?: number;
}

export interface Churn {
  /** HEAD sha the list was computed at; a moved HEAD recomputes it. */
  head: string;
  /** Indexable paths changed most often in recent commits, most first. */
  paths: string[];
}

export interface IndexMeta {
  lastScanned: string | null;
  fileCount: number;
  /** Set when a refresh ran out of time budget and skipped entries. */
  partial?: boolean;
  /** Set when the walk found more indexable files than config.max_files. */
  truncated?: boolean;
  /** Indexable-named files the walk saw before the cap; absent when it stopped uncounted. */
  candidateCount?: number;
  /** Absent outside git or when git failed. */
  churn?: Churn;
}

export interface AnatomyIndex {
  version: number;
  meta: IndexMeta;
  files: Record<string, FileEntry>;
}

export function emptyIndex(): AnatomyIndex {
  return { version: INDEX_VERSION, meta: { lastScanned: null, fileCount: 0 }, files: {} };
}

export function loadIndex(crankDir: string): AnatomyIndex {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(crankDir, INDEX_FILE), "utf-8"));
    if (
      typeof raw !== "object" || raw === null ||
      raw.version !== INDEX_VERSION ||
      typeof raw.files !== "object" || raw.files === null ||
      typeof raw.meta !== "object" || raw.meta === null
    ) {
      return emptyIndex();
    }
    return raw as AnatomyIndex;
  } catch {
    return emptyIndex();
  }
}

/** Atomic-ish save: write temp then rename (callers hold the lock). */
function saveIndex(crankDir: string, index: AnatomyIndex): void {
  index.meta.fileCount = Object.keys(index.files).length;
  const target = path.join(crankDir, INDEX_FILE);
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, target);
}

const MAX_PINS = 100;
const MOST_ACTIVE = 25;

/**
 * Written files (most recently modified first, at most MAX_PINS), then the
 * churn list. The walk takes these before anything else.
 */
export function activePaths(index: AnatomyIndex): string[] {
  const pins = Object.entries(index.files)
    .filter(([, e]) => (e.writeCount ?? 0) > 0)
    .sort(([, a], [, b]) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_PINS)
    .map(([rel]) => rel);
  return [...new Set([...pins, ...(index.meta.churn?.paths ?? [])])];
}

/**
 * Render anatomy.md: the most active files first, so a `head` of the file
 * shows them, then every file alphabetically with symbol sub-bullets.
 */
export function renderAnatomyMd(index: AnatomyIndex): string {
  const lines: string[] = [
    "# Project Anatomy",
    "",
    `_${index.meta.fileCount} files indexed, last scanned ${index.meta.lastScanned ?? "never"}._`,
    "",
  ];
  const fileLine = (rel: string, entry: FileEntry): string =>
    `- \`${rel}\`${entry.description ? ` — ${entry.description}` : ""} (~${entry.tokens} tok)`;
  const active = activePaths(index).filter((rel) => index.files[rel]).slice(0, MOST_ACTIVE);
  if (active.length > 0) {
    lines.push("## Most active files", "");
    for (const rel of active) lines.push(fileLine(rel, index.files[rel]!));
    lines.push("", "## All files", "");
  }
  for (const [rel, entry] of Object.entries(index.files).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(fileLine(rel, entry));
    for (const s of entry.symbols ?? []) {
      lines.push(`  - ${s.name} (${s.kind}, L${s.startLine}–L${s.endLine}, ~${s.tokens} tok)`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function saveAnatomyMd(crankDir: string, index: AnatomyIndex): void {
  fs.writeFileSync(path.join(crankDir, ANATOMY_FILE), renderAnatomyMd(index));
}

/**
 * The single chokepoint for index writes: under the lock, load the current
 * index, let `build` produce the next one, then persist index + anatomy.md.
 * `build` returning null skips the save (nothing to write). Returns the saved
 * index, or null when the lock could not be acquired or the save was skipped.
 */
export function commitIndex(
  crankDir: string,
  budgetMs: number,
  build: (current: AnatomyIndex) => AnatomyIndex | null
): AnatomyIndex | null {
  return withLock(crankDir, budgetMs, () => {
    const next = build(loadIndex(crankDir));
    if (next === null) return null;
    saveIndex(crankDir, next);
    saveAnatomyMd(crankDir, next);
    return next;
  });
}

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
  updatedAt: string;
  source: "scan" | "hook";
  symbols?: SymbolEntry[];
}

export interface IndexMeta {
  lastScanned: string | null;
  fileCount: number;
  /** Set when a refresh ran out of time budget and skipped entries. */
  partial?: boolean;
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

/** Render anatomy.md: file lines grouped in walk order, symbol sub-bullets. */
export function renderAnatomyMd(index: AnatomyIndex): string {
  const lines: string[] = [
    "# Project Anatomy",
    "",
    `_${index.meta.fileCount} files indexed, last scanned ${index.meta.lastScanned ?? "never"}._`,
    "",
  ];
  for (const [rel, entry] of Object.entries(index.files).sort(([a], [b]) => a.localeCompare(b))) {
    const desc = entry.description ? ` — ${entry.description}` : "";
    lines.push(`- \`${rel}\`${desc} (~${entry.tokens} tok)`);
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

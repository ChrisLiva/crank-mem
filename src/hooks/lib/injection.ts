import * as fs from "node:fs";
import * as path from "node:path";
import { estimateProseTokens } from "./tokens.ts";
import type { AnatomyIndex } from "./store.ts";

// Session-start injection: instructions → cerebrum excerpt → ADR filenames →
// anatomy file lines (dir-grouped) filling the remaining token budget.
// Symbols are never injected — they live in the index and anatomy.md for
// slice-reads on demand.

export const CEREBRUM_INJECT_TOKEN_CAP = 600;
export const ADR_RECENT_COUNT = 20;
export const DO_NOT_REPEAT_RECENT_COUNT = 10;

const INSTRUCTIONS = `## crank-mem (project memory)

This project keeps a token-annotated file index in \`crank/anatomy.md\` and an
agent-maintained memory in \`crank/cerebrum.md\`. A file map follows below.

- Before reading a large file, check its entry in \`crank/anatomy.md\`: symbol
  sub-bullets give line ranges, so slice-read just what you need (Read with
  offset/limit, or \`sed -n 'START,ENDp' file\`).
- Cerebrum protocol: when the user corrects you or states a preference, record
  it in \`crank/cerebrum.md\` immediately (low threshold — a one-line bullet in
  User Preferences, Key Learnings, or Do-Not-Repeat). Respect existing entries.
  If a section grows bloated or stale, consolidate and prune it.
- ADR protocol: decisions that are hard to reverse, surprising, AND carry a
  real trade-off get an ADR (\`NNNN-slug.md\`, Pocock style) in the ADR
  directory. Existing ADRs are settled — don't relitigate them.`;

export interface InjectionSources {
  cerebrumMd: string | null;
  adrFilenames: string[];
  index: AnatomyIndex;
  /** Appended verbatim near the top when a refresh was skipped/partial. */
  stalenessNote?: string;
  adrPath: string;
}

/** Extract a section's body lines from cerebrum.md (## headings). */
function sectionBody(md: string, heading: string): string[] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return [];
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) break;
    body.push(lines[i]!);
  }
  while (body.length && body[0]!.trim() === "") body.shift();
  while (body.length && body[body.length - 1]!.trim() === "") body.pop();
  return body;
}

/** Cerebrum excerpt: User Preferences in full + last N Do-Not-Repeat bullets. */
export function cerebrumExcerpt(md: string): string {
  const prefs = sectionBody(md, "User Preferences");
  const dnr = sectionBody(md, "Do-Not-Repeat").filter((l) => l.trim().startsWith("-"));
  const recentDnr = dnr.slice(-DO_NOT_REPEAT_RECENT_COUNT);
  const parts: string[] = [];
  if (prefs.some((l) => l.trim())) parts.push("### User Preferences", ...prefs);
  if (recentDnr.length) parts.push("### Do-Not-Repeat (recent)", ...recentDnr);
  if (!parts.length) return "";
  let text = ["## Cerebrum (crank/cerebrum.md — full file has more)", ...parts].join("\n");
  // Hard cap: trim whole lines from the end until under budget.
  while (estimateProseTokens(text) > CEREBRUM_INJECT_TOKEN_CAP && text.includes("\n")) {
    text = text.slice(0, text.lastIndexOf("\n"));
  }
  return text;
}

/** Anatomy lines, dir-grouped: "dir/: file (desc, ~N tok); file2 …". */
function anatomyLines(index: AnatomyIndex): string[] {
  const byDir = new Map<string, string[]>();
  for (const [rel, entry] of Object.entries(index.files).sort(([a], [b]) => a.localeCompare(b))) {
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) + "/" : "./";
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    const desc = entry.description ? ` — ${entry.description}` : "";
    const list = byDir.get(dir) ?? [];
    list.push(`  - \`${base}\`${desc} (~${entry.tokens} tok)`);
    byDir.set(dir, list);
  }
  const lines: string[] = [];
  for (const [dir, files] of byDir) {
    lines.push(`- ${dir}`);
    lines.push(...files);
  }
  return lines;
}

/**
 * Compose the full injection under `budgetTokens`. Instructions, cerebrum and
 * ADR list are budgeted in order; anatomy lines fill whatever remains and are
 * truncated with a pointer to the full anatomy.md.
 */
export function buildInjection(sources: InjectionSources, budgetTokens: number): string {
  const parts: string[] = [INSTRUCTIONS];
  if (sources.stalenessNote) parts.push(`_Note: ${sources.stalenessNote}_`);

  if (sources.cerebrumMd) {
    const excerpt = cerebrumExcerpt(sources.cerebrumMd);
    if (excerpt) parts.push(excerpt);
  }

  if (sources.adrFilenames.length) {
    const recent = [...sources.adrFilenames].sort().slice(-ADR_RECENT_COUNT);
    parts.push(
      [`## ADRs (${sources.adrPath}/ — settled decisions)`, ...recent.map((f) => `- ${f}`)].join("\n")
    );
  }

  const head = parts.join("\n\n");
  const headTokens = estimateProseTokens(head);
  const remaining = budgetTokens - headTokens;

  const allLines = anatomyLines(sources.index);
  if (allLines.length) {
    const kept: string[] = [];
    let used = estimateProseTokens("## File map (crank/anatomy.md)\n");
    let truncated = false;
    for (const line of allLines) {
      const cost = estimateProseTokens(line + "\n");
      if (used + cost > remaining) {
        truncated = true;
        break;
      }
      kept.push(line);
      used += cost;
    }
    if (kept.length) {
      const fileCount = sources.index.meta.fileCount;
      const keptFiles = kept.filter((l) => l.startsWith("  ")).length;
      const tail = truncated
        ? `\n…plus ${fileCount - keptFiles} more files — see crank/anatomy.md`
        : "";
      parts.push(["## File map (crank/anatomy.md)", ...kept].join("\n") + tail);
    } else {
      parts.push(`## File map\n${sources.index.meta.fileCount} files indexed — see crank/anatomy.md`);
    }
  }

  return parts.join("\n\n");
}

/** Load ADR filenames (NNNN-*.md) from the configured directory. */
export function listAdrFilenames(projectRoot: string, adrPath: string): string[] {
  try {
    return fs
      .readdirSync(path.join(projectRoot, adrPath))
      .filter((f) => /^\d{4}-.*\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

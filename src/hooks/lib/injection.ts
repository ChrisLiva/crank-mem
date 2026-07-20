import * as fs from "node:fs";
import * as path from "node:path";
import { estimateProseTokens } from "./tokens.ts";
import type { AnatomyIndex } from "./store.ts";

// Session-start injection: instructions (carrying a one-line pointer to the
// file map) → cerebrum excerpt → ADR filenames.
//
// The map itself is deliberately NOT injected. Measured over 67 sessions in a
// real project, inlining it cost 74% of the injection — enough to push the hook
// past Claude Code's stdout limit, which silently replaced the whole injection
// with a 2KB preview in 9 of 23 sessions — and produced no observed use: zero
// reads, zero navigational citations. The predecessor tool shipped a one-line
// pointer instead, for ~40 bytes, and got more consultation than the inlined
// version did. So: point at anatomy.md, don't recite it.

export const CEREBRUM_INJECT_TOKEN_CAP = 600;
export const ADR_RECENT_COUNT = 20;
export const DO_NOT_REPEAT_RECENT_COUNT = 10;

const instructions = (fileCount: number): string => `## crank-mem (project memory)

This project keeps a token-annotated file index in \`.crank/anatomy.md\` and an
agent-maintained memory in \`.crank/cerebrum.md\`.

- \`.crank/anatomy.md\` indexes ${fileCount} file(s) with descriptions, token sizes, and
  per-symbol line ranges — check it before reading any file. Symbol sub-bullets
  give line ranges, so slice-read just what you need (Read with offset/limit,
  or \`sed -n 'START,ENDp' file\`).
- Cerebrum protocol: keep \`.crank/cerebrum.md\` current as you work. The bar is
  low — a one-line bullet is enough, and a slightly redundant entry beats a
  lost one. Record it the moment you learn it, not at the end:
  - the user corrects you or states a preference → User Preferences, or
    Do-Not-Repeat if it's a mistake not to repeat;
  - you discover a non-obvious project convention, a framework/dependency
    quirk, or surprising API behavior → Key Learnings;
  - something bites you that would trip up a fresh session → Do-Not-Repeat.
  Respect existing entries; consolidate or prune a section when it grows
  bloated or stale.
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
  let text = ["## Cerebrum (.crank/cerebrum.md — full file has more)", ...parts].join("\n");
  // Hard cap: trim whole lines from the end until under budget.
  while (estimateProseTokens(text) > CEREBRUM_INJECT_TOKEN_CAP && text.includes("\n")) {
    text = text.slice(0, text.lastIndexOf("\n"));
  }
  return text;
}

const SEP = "\n\n";
const bytes = (s: string): number => Buffer.byteLength(s, "utf-8");

/**
 * Compose the injection under a hard byte cap.
 *
 * Sections are added in priority order and each must fit in what's left, so an
 * over-budget section is dropped rather than allowed to push the whole
 * injection past the cliff. The cerebrum excerpt, the only part that grows
 * without a natural bound, is trimmed line-by-line to fit rather than dropped
 * whole — its most valuable content (User Preferences) sits at the top.
 *
 * The instructions are exempt: they carry the cerebrum and ADR protocols, so a
 * budget too small to hold them is a misconfiguration, not a reason to inject a
 * headless fragment. Consequence: the result can exceed `budgetBytes`, but only
 * by the fixed size of the instructions.
 */
export function buildInjection(sources: InjectionSources, budgetBytes: number): string {
  const parts: string[] = [instructions(sources.index.meta.fileCount)];
  let used = bytes(parts[0]!);

  const fit = (section: string): boolean => {
    const cost = bytes(SEP + section);
    if (used + cost > budgetBytes) return false;
    parts.push(section);
    used += cost;
    return true;
  };

  if (sources.stalenessNote) fit(`_Note: ${sources.stalenessNote}_`);

  if (sources.cerebrumMd) {
    let excerpt = cerebrumExcerpt(sources.cerebrumMd);
    // Trim whole lines from the end until it fits — same shape as the token cap
    // inside cerebrumExcerpt, applied against the budget that actually binds.
    while (excerpt && used + bytes(SEP + excerpt) > budgetBytes && excerpt.includes("\n")) {
      excerpt = excerpt.slice(0, excerpt.lastIndexOf("\n"));
    }
    if (excerpt) fit(excerpt);
  }

  if (sources.adrFilenames.length) {
    const recent = [...sources.adrFilenames].sort().slice(-ADR_RECENT_COUNT);
    fit([`## ADRs (${sources.adrPath}/ — settled decisions)`, ...recent.map((f) => `- ${f}`)].join("\n"));
  }

  return parts.join(SEP);
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

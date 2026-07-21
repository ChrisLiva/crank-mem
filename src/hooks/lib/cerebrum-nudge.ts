import * as fs from "node:fs";
import * as path from "node:path";
import { loadIndex } from "./store.ts";
import { debugEvent } from "./debug.ts";

// Shared cerebrum-nudge logic: decide whether to remind the agent to record
// what it learned, and debounce so the reminder doesn't repeat every turn/write.
// Delivered at turn end on Claude (stop.ts) and after a write on Codex
// (post-write.ts), whichever channel reaches that agent's model.

// Re-nudge only after this many *more* files change since the last nudge, so a
// session that keeps working without updating cerebrum is reminded in batches
// rather than on every turn or write. Also the minimum to nudge at all.
export const NUDGE_STEP = 3;

// Above this many lines, cerebrum has likely accumulated stale or bloated
// entries and the agent is nudged to prune it. A soft guideline, not a cap —
// nothing truncates the file.
export const PRUNE_LINE_LIMIT = 200;

const MARKER_FILE = "cerebrum-nudge.json";

interface NudgeMarker {
  cerebrumMtimeMs: number;
  nudgedAtChanged: number;
  /** Cerebrum mtime at the last prune nudge — re-nudge only after it's edited again. */
  pruneNudgedMtimeMs?: number;
}

function readMarker(crankDir: string): NudgeMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(crankDir, MARKER_FILE), "utf-8"));
    if (typeof raw?.cerebrumMtimeMs === "number" && typeof raw?.nudgedAtChanged === "number") {
      return raw as NudgeMarker;
    }
  } catch {}
  return null;
}

function writeMarker(crankDir: string, marker: NudgeMarker): void {
  try {
    fs.writeFileSync(path.join(crankDir, MARKER_FILE), JSON.stringify(marker));
  } catch (err) {
    // Debounce is now broken — every turn will re-nudge. Silent by contract,
    // but the log should say why the model is being pestered.
    debugEvent("nudge-marker-write-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A reminder to record this session's learnings and/or prune an overgrown
 * cerebrum, or null when nothing is due.
 *
 * Record nudge: fires once per cerebrum version, then again only after
 * NUDGE_STEP more source files change. Updating cerebrum bumps its mtime —
 * resetting both the changed count (its mtime jumps ahead of the files) and the
 * debounce baseline — so a fresh recording quiets the nudge. cerebrum.md lives
 * under .crank/ and is never indexed, so editing it can't inflate the count.
 *
 * Prune nudge: fires when cerebrum exceeds PRUNE_LINE_LIMIT lines, once per
 * cerebrum version — silent until the file is edited again, and re-fires on the
 * next version only if it's still over the limit.
 *
 * Writes the marker as a side effect when it nudges; never throws.
 */
export function cerebrumNudge(crankDir: string): string | null {
  let cerebrumMtimeMs: number;
  let lineCount: number;
  try {
    const cerebrumPath = path.join(crankDir, "cerebrum.md");
    cerebrumMtimeMs = fs.statSync(cerebrumPath).mtimeMs;
    lineCount = fs.readFileSync(cerebrumPath, "utf-8").split("\n").length;
  } catch {
    debugEvent("nudge-skipped", { reason: "no-cerebrum" });
    return null; // no cerebrum — nothing to nudge about
  }

  const index = loadIndex(crankDir);
  const changed = Object.values(index.files).filter((e) => e.mtimeMs > cerebrumMtimeMs).length;

  const marker = readMarker(crankDir);
  const baseline = marker && marker.cerebrumMtimeMs === cerebrumMtimeMs ? marker.nudgedAtChanged : 0;
  const recordDue = changed >= NUDGE_STEP && changed >= baseline + NUDGE_STEP;
  const pruneDue = lineCount > PRUNE_LINE_LIMIT && marker?.pruneNudgedMtimeMs !== cerebrumMtimeMs;

  if (!recordDue && !pruneDue) {
    debugEvent("nudge-skipped", {
      reason: changed < NUDGE_STEP ? "below-threshold" : "debounced",
      changed,
      baseline,
      step: NUDGE_STEP,
      lineCount,
    });
    return null;
  }

  debugEvent("nudge-emitted", { changed, baseline, lineCount, recordDue, pruneDue });
  writeMarker(crankDir, {
    cerebrumMtimeMs,
    nudgedAtChanged: recordDue ? changed : baseline,
    // A stale value (from an older cerebrum version) is inert — the check is
    // equality with the current mtime — so carrying it forward is harmless.
    pruneNudgedMtimeMs: pruneDue ? cerebrumMtimeMs : marker?.pruneNudgedMtimeMs,
  });

  const parts: string[] = [];
  if (recordDue) {
    parts.push(
      `crank-mem: ${changed} file(s) have changed since .crank/cerebrum.md was last updated. ` +
        `If this session surfaced a user preference, a project convention, a dependency quirk, or a ` +
        `gotcha worth keeping, add a one-line bullet to the matching cerebrum section before moving ` +
        `on — a slightly redundant entry beats a lost one.`,
    );
  }
  if (pruneDue) {
    parts.push(
      `crank-mem: .crank/cerebrum.md has grown to ${lineCount} lines (guideline: ${PRUNE_LINE_LIMIT}). ` +
        `Prune it before moving on: delete entries that no longer apply, merge near-duplicates, and ` +
        `tighten verbose entries into single targeted bullets — keep only what a fresh session would ` +
        `actually need.`,
    );
  }
  return parts.join("\n");
}

import * as fs from "node:fs";
import * as path from "node:path";
import { loadIndex } from "./store.ts";

// Shared cerebrum-nudge logic: decide whether to remind the agent to record
// what it learned, and debounce so the reminder doesn't repeat every turn/write.
// Delivered at turn end on Claude (stop.ts) and after a write on Codex
// (post-write.ts), whichever channel reaches that agent's model.

// Re-nudge only after this many *more* files change since the last nudge, so a
// session that keeps working without updating cerebrum is reminded in batches
// rather than on every turn or write. Also the minimum to nudge at all.
export const NUDGE_STEP = 3;

const MARKER_FILE = "cerebrum-nudge.json";

interface NudgeMarker {
  cerebrumMtimeMs: number;
  nudgedAtChanged: number;
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
  } catch {}
}

/**
 * A reminder to record this session's learnings, or null when nothing is due.
 * Nudges once per cerebrum version, then again only after NUDGE_STEP more source
 * files change. Updating cerebrum bumps its mtime — resetting both the changed
 * count (its mtime jumps ahead of the files) and the debounce baseline — so a
 * fresh recording quiets the nudge. cerebrum.md lives under .crank/ and is never
 * indexed, so editing it can't inflate the count. Writes the marker as a side
 * effect when it nudges; never throws.
 */
export function cerebrumNudge(crankDir: string): string | null {
  let cerebrumMtimeMs: number;
  try {
    cerebrumMtimeMs = fs.statSync(path.join(crankDir, "cerebrum.md")).mtimeMs;
  } catch {
    return null; // no cerebrum — nothing to nudge about
  }

  const index = loadIndex(crankDir);
  const changed = Object.values(index.files).filter((e) => e.mtimeMs > cerebrumMtimeMs).length;
  if (changed < NUDGE_STEP) return null;

  const marker = readMarker(crankDir);
  const baseline = marker && marker.cerebrumMtimeMs === cerebrumMtimeMs ? marker.nudgedAtChanged : 0;
  if (changed < baseline + NUDGE_STEP) return null;

  writeMarker(crankDir, { cerebrumMtimeMs, nudgedAtChanged: changed });
  return (
    `crank-mem: ${changed} file(s) have changed since .crank/cerebrum.md was last updated. ` +
    `If this session surfaced a user preference, a project convention, a dependency quirk, or a ` +
    `gotcha worth keeping, add a one-line bullet to the matching cerebrum section before moving ` +
    `on — a slightly redundant entry beats a lost one.`
  );
}

import * as fs from "node:fs";
import * as path from "node:path";
import { loadIndex } from "./store.ts";
import { estimateProseTokens } from "./tokens.ts";
import { JOURNAL_FILE } from "./journal.ts";
import { debugEvent } from "./debug.ts";

// Shared memory-nudge logic: decide whether to remind the agent to record what
// it learned (cerebrum), prune an overgrown cerebrum, or log where it left off
// (journal), and debounce so the reminder doesn't repeat every turn/write.
// Delivered at turn end on Claude (stop.ts) and after a write on Codex
// (post-write.ts), whichever channel reaches that agent's model.

// Re-nudge only after this many *more* files change since the last nudge, so a
// session that keeps working without updating cerebrum is reminded in batches
// rather than on every turn or write. Also the minimum to nudge at all.
export const NUDGE_STEP = 20;

// Past either of these, cerebrum has likely accumulated stale or bloated
// entries and the agent is nudged to prune it. Soft guidelines, not caps —
// nothing truncates the file. The token limit catches the file that stays under
// the line count by packing paragraphs into a handful of very long bullets; it
// measures with the same prose estimate injection.ts uses on this file, and
// sits well above CEREBRUM_INJECT_TOKEN_CAP (only an excerpt is ever injected).
export const PRUNE_LINE_LIMIT = 150;
export const PRUNE_TOKEN_LIMIT = 3000;

// Prune targets sit well below the limits so a prune buys real headroom: an
// agent told only "get under 150" trims to 149 and re-triggers a session later.
// Naming a target under the trigger makes the deficit concrete and checkable.
export const PRUNE_TARGET_LINES = 105;
export const PRUNE_TARGET_TOKENS = 2100;

const MARKER_FILE = "cerebrum-nudge.json";

interface NudgeMarker {
  cerebrumMtimeMs: number;
  nudgedAtChanged: number;
  /** Cerebrum size when this marker was written — the prune nudge is silent only while it falls. */
  pruneNudgedLines?: number;
  pruneNudgedTokens?: number;
  /** Journal debounce, same shape as the record nudge but keyed on journal.md. */
  journalMtimeMs?: number;
  journalNudgedAtChanged?: number;
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

interface CerebrumStats {
  mtimeMs: number;
  lineCount: number;
  tokenCount: number;
}

function readCerebrum(crankDir: string): CerebrumStats | null {
  try {
    const file = path.join(crankDir, "cerebrum.md");
    const mtimeMs = fs.statSync(file).mtimeMs;
    const text = fs.readFileSync(file, "utf-8");
    return { mtimeMs, lineCount: text.split("\n").length, tokenCount: estimateProseTokens(text) };
  } catch {
    return null;
  }
}

function mtimeOf(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * A reminder to record this session's learnings, log where it left off, and/or
 * prune an overgrown cerebrum, or null when nothing is due.
 *
 * The three parts are independent: each is skipped when its file is absent
 * (a pre-journal install has no journal.md), and each has its own staleness
 * measure, so a session that keeps cerebrum current but never journals is
 * nudged about the journal alone.
 *
 * Record nudge: fires once per cerebrum version, then again only after
 * NUDGE_STEP more source files change. Updating cerebrum bumps its mtime —
 * resetting both the changed count (its mtime jumps ahead of the files) and the
 * debounce baseline — so a fresh recording quiets the nudge. cerebrum.md lives
 * under .crank/ and is never indexed, so editing it can't inflate the count.
 *
 * Journal nudge: the same rule keyed on journal.md's mtime — appending an entry
 * quiets it. The mechanical trim in journal.ts restores the mtime it found, so
 * only a real entry counts.
 *
 * Prune nudge: fires when cerebrum exceeds PRUNE_LINE_LIMIT lines or
 * PRUNE_TOKEN_LIMIT estimated tokens, and keeps firing until the file shrinks.
 * It is silent only when either measure has fallen below the size stamped on
 * the marker, so an agent partway through a prune isn't pestered on every turn,
 * while one that ignores the nudge hears it again — as the message promises.
 * Editing cerebrum without shrinking it (the mtime moves, the size doesn't)
 * does not buy silence.
 *
 * The stamped size is therefore a floor, not the size that last nudged: every
 * observation of a smaller-but-still-oversized file lowers it. An agent that
 * trims 160 -> 155 lines is silenced by the shrink and the floor drops to 155,
 * so a later stall at 155 re-arms the nudge. Keeping the 160 would silence it
 * forever — the message promises to repeat until the file is under the limit.
 *
 * Writes the marker as a side effect when it nudges, and — the one silent write
 * — when it observes a prune in progress. Never throws.
 */
export function cerebrumNudge(crankDir: string): string | null {
  const cerebrum = readCerebrum(crankDir);
  const journalMtimeMs = mtimeOf(path.join(crankDir, JOURNAL_FILE));
  if (!cerebrum && journalMtimeMs === null) {
    debugEvent("nudge-skipped", { reason: "no-memory-files" });
    return null; // neither memory file exists — nothing to nudge about
  }

  const index = loadIndex(crankDir);
  const changedSince = (mtimeMs: number): number =>
    Object.values(index.files).filter((e) => e.mtimeMs > mtimeMs).length;

  const marker = readMarker(crankDir);

  const changed = cerebrum ? changedSince(cerebrum.mtimeMs) : 0;
  const baseline =
    marker && cerebrum && marker.cerebrumMtimeMs === cerebrum.mtimeMs ? marker.nudgedAtChanged : 0;
  const recordDue = !!cerebrum && changed >= NUDGE_STEP && changed >= baseline + NUDGE_STEP;

  const oversized =
    !!cerebrum && (cerebrum.lineCount > PRUNE_LINE_LIMIT || cerebrum.tokenCount > PRUNE_TOKEN_LIMIT);
  // A missing marker field counts as "did not fall", so a first run — or an old
  // marker written before these fields existed — nudges.
  const shrank =
    !!cerebrum &&
    ((marker?.pruneNudgedLines !== undefined && cerebrum.lineCount < marker.pruneNudgedLines) ||
      (marker?.pruneNudgedTokens !== undefined && cerebrum.tokenCount < marker.pruneNudgedTokens));
  const pruneDue = oversized && !shrank;

  const journalChanged = journalMtimeMs === null ? 0 : changedSince(journalMtimeMs);
  const journalBaseline =
    marker && marker.journalMtimeMs === journalMtimeMs ? (marker.journalNudgedAtChanged ?? 0) : 0;
  const journalDue =
    journalMtimeMs !== null &&
    journalChanged >= NUDGE_STEP &&
    journalChanged >= journalBaseline + NUDGE_STEP;

  if (!recordDue && !pruneDue && !journalDue) {
    debugEvent("nudge-skipped", {
      // Per part: with one measure below the threshold and the other merely
      // debounced, a single verdict says nothing about which is which.
      reason: [
        cerebrum ? `cerebrum:${changed < NUDGE_STEP ? "below-threshold" : "debounced"}` : "cerebrum:absent",
        journalMtimeMs === null
          ? "journal:absent"
          : `journal:${journalChanged < NUDGE_STEP ? "below-threshold" : "debounced"}`,
      ].join(" "),
      changed,
      baseline,
      journalChanged,
      journalBaseline,
      step: NUDGE_STEP,
      lineCount: cerebrum?.lineCount ?? null,
      tokenCount: cerebrum?.tokenCount ?? null,
    });
    // Silence is not the end of it: a prune in progress must lower the floor,
    // or the next stall would never be noticed — nothing else rewrites the
    // marker until some other part happens to fire.
    if (cerebrum && marker && oversized && shrank) {
      writeMarker(crankDir, {
        ...marker,
        pruneNudgedLines: cerebrum.lineCount,
        pruneNudgedTokens: cerebrum.tokenCount,
      });
    }
    return null;
  }

  debugEvent("nudge-emitted", {
    changed,
    baseline,
    journalChanged,
    journalBaseline,
    lineCount: cerebrum?.lineCount ?? null,
    tokenCount: cerebrum?.tokenCount ?? null,
    recordDue,
    pruneDue,
    journalDue,
  });
  writeMarker(crankDir, {
    // Absent cerebrum: 0 keeps the marker well-formed (readMarker requires a
    // number) and never equals a real mtime, so nothing is wrongly debounced.
    cerebrumMtimeMs: cerebrum?.mtimeMs ?? 0,
    nudgedAtChanged: recordDue ? changed : baseline,
    // Always the size observed now, whether or not the prune part fired: that
    // is what lets a partial prune that then stalls re-arm the nudge.
    pruneNudgedLines: cerebrum?.lineCount ?? marker?.pruneNudgedLines,
    pruneNudgedTokens: cerebrum?.tokenCount ?? marker?.pruneNudgedTokens,
    journalMtimeMs: journalMtimeMs ?? marker?.journalMtimeMs,
    journalNudgedAtChanged: journalDue ? journalChanged : journalBaseline,
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
  if (journalDue) {
    parts.push(
      `crank-mem: ${journalChanged} file(s) changed since the last .crank/journal.md entry. ` +
        `Append one dated bullet — \`- YYYY-MM-DD: what you did; where you left off; NEXT: next step\` ` +
        `— telegram-style. The \`NEXT:\` clause is what the next session is shown, so put the handoff ` +
        `there, last: that is how it picks up mid-thread instead of re-deriving where it was.`,
    );
  }
  if (pruneDue && cerebrum) {
    // Name only the measure(s) actually over, so the nudge points at the shape
    // of the bloat: many bullets, a few sprawling ones, or both. Each names its
    // target and the concrete deficit — "prune it" with no success criterion
    // invites a two-line trim that leaves the file over the limit.
    const over: string[] = [];
    if (cerebrum.lineCount > PRUNE_LINE_LIMIT) {
      over.push(
        `${cerebrum.lineCount} lines (limit: ${PRUNE_LINE_LIMIT}) — ` +
          `cut at least ${cerebrum.lineCount - PRUNE_TARGET_LINES} to get under ~${PRUNE_TARGET_LINES}`,
      );
    }
    if (cerebrum.tokenCount > PRUNE_TOKEN_LIMIT) {
      over.push(
        `~${cerebrum.tokenCount} tokens (limit: ${PRUNE_TOKEN_LIMIT}) — get under ~${PRUNE_TARGET_TOKENS}`,
      );
    }
    parts.push(
      `crank-mem: .crank/cerebrum.md is at ${over.join(", and ")}. ` +
        `Prune it now, by deleting whole entries rather than tightening wording: delete anything ` +
        `that describes code or decisions that have since changed, restates what the codebase or ` +
        `CLAUDE.md already makes obvious, or records a one-time fix that is finished. When unsure ` +
        `whether an entry still earns its place, delete it — a fresh session can re-learn a cheap ` +
        `fact, but every session pays to read a stale one. A small trim is not enough; this ` +
        `reminder repeats until the file is back under the limit.`,
    );
  }
  return parts.join("\n");
}

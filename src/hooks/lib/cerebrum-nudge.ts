import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { loadIndex } from "./store.ts";
import { estimateProseTokens } from "./tokens.ts";
import { JOURNAL_FILE } from "./journal.ts";
import { parseBlocks } from "./bullets.ts";
import { debugEvent } from "./debug.ts";
import { loadConfig } from "./config.ts";
import { changeTimesSince } from "./changes.ts";
import { instructionFiles } from "./hook-io.ts";

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

// Before a prune nudge, cerebrum.md is copied here so a prune that cuts a
// load-bearing entry can be undone. No manifest.json, so `uninstall --restore`
// never mistakes this dir for an init/upgrade backup (cli/backups.ts);
// `uninstall --delete-crank` removes it by name.
export const BACKUP_DIR = path.join("backups", "cerebrum");
export const CEREBRUM_FILE = "cerebrum.md";
// Where the prune nudge sends superseded entries; never injected.
export const ARCHIVE_FILE = "cerebrum-archive.md";
export const BACKUP_KEEP = 5;
// Bullets the prune nudge names by line, longest first.
const LONGEST_NAMED = 3;
// A hex run with at least one digit: a commit sha, the mark of a one-off fix.
const COMMIT_SHA = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/;

export const MARKER_FILE = "cerebrum-nudge.json";

// The audit skill is user-invoked only (disable-model-invocation), so an
// unaudited project stays unaudited unless the user is told. OrcaSlicer never
// ran it, and 3 of 7 paths its cerebrum cites no longer exist.
export const AUDIT_SKILL = "crank-mem-audit";
export const AUDIT_INTERVAL_MS = 7 * 86_400_000;

interface NudgeMarker {
  cerebrumMtimeMs: number;
  nudgedAtChanged: number;
  /** Oversized cerebrum size when this marker was written — the prune nudge is silent only while it falls. Absent under both limits. */
  pruneNudgedLines?: number;
  pruneNudgedTokens?: number;
  /** Journal debounce, same shape as the record nudge but keyed on journal.md. */
  journalMtimeMs?: number;
  journalNudgedAtChanged?: number;
  /** When the audit suggestion last rode along on a nudge. */
  auditSuggestedAtMs?: number;
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
  text: string;
  mtimeMs: number;
  lineCount: number;
  tokenCount: number;
}

function readCerebrum(crankDir: string): CerebrumStats | null {
  try {
    const file = path.join(crankDir, CEREBRUM_FILE);
    const mtimeMs = fs.statSync(file).mtimeMs;
    const text = fs.readFileSync(file, "utf-8");
    return { text, mtimeMs, lineCount: text.split("\n").length, tokenCount: estimateProseTokens(text) };
  } catch {
    return null;
  }
}

/**
 * Copy cerebrum.md to backups/cerebrum/<timestamp>.md unless the newest copy
 * already matches, keeping the last BACKUP_KEEP. Returns the project-relative
 * path of the copy that matches the file now, or null when the copy failed.
 */
function backupCerebrum(crankDir: string, text: string): string | null {
  try {
    const dir = path.join(crankDir, BACKUP_DIR);
    fs.mkdirSync(dir, { recursive: true });
    // ISO stamps sort chronologically, so the last name is the newest copy.
    const copies = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    let name = copies[copies.length - 1];
    if (!name || fs.readFileSync(path.join(dir, name), "utf-8") !== text) {
      name = new Date().toISOString().replace(/[:.]/g, "-") + ".md";
      fs.writeFileSync(path.join(dir, name), text);
      copies.push(name);
    }
    for (const old of copies.slice(0, -BACKUP_KEEP)) fs.rmSync(path.join(dir, old), { force: true });
    return path.join(".crank", BACKUP_DIR, name);
  } catch (err) {
    debugEvent("cerebrum-backup-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Whole bullets with the 1-based line each starts on, in file order. */
function bulletsWithLines(text: string): Array<{ line: number; body: string }> {
  const bullets: Array<{ line: number; body: string }> = [];
  let line = 1;
  for (const block of parseBlocks(text.split("\n"))) {
    if (block.kind === "bullet") bullets.push({ line, body: block.lines.join("\n").trimEnd() });
    line += block.lines.length;
  }
  return bullets;
}

/** The LONGEST_NAMED longest whole bullets, as "line N (C chars)", longest first. */
function longestBullets(text: string): string[] {
  return bulletsWithLines(text)
    .sort((a, b) => b.body.length - a.body.length)
    .slice(0, LONGEST_NAMED)
    .map((b) => `line ${b.line} (${b.body.length} chars${COMMIT_SHA.test(b.body) ? ", cites a commit" : ""})`);
}

// What the audit skill's backup step copies (skills/crank-mem-audit/SKILL.md).
const AUDIT_BACKUP_FILES = new Set([CEREBRUM_FILE, JOURNAL_FILE, ARCHIVE_FILE]);

/**
 * True for a .crank/backups/ dir the audit skill wrote: it holds only copies of
 * the memory files, so no manifest.json (init and upgrade backups), no
 * timestamped copies (the prune nudge's backups/cerebrum/), and nothing another
 * tool sharing .crank/ wrote. Never throws.
 */
function isAuditBackup(dir: string): boolean {
  try {
    const names = fs.readdirSync(dir);
    return names.length > 0 && names.every((name) => AUDIT_BACKUP_FILES.has(name));
  } catch {
    return false;
  }
}

/** A backup dir is crank-mem's when it holds the manifest newBackupDir writes or is the audit skill's copy of the memory files. Never throws. */
export function isCrankBackup(dir: string): boolean {
  return fs.existsSync(path.join(dir, "manifest.json")) || isAuditBackup(dir);
}

/**
 * When the audit skill last ran: the mtime of the newest audit backup dir. Its
 * timestamp format varies by run, so the name is not parsed. Null when no
 * audit backup exists. Never throws.
 */
export function lastAuditMs(crankDir: string): number | null {
  const base = path.join(crankDir, "backups");
  let newest: number | null = null;
  try {
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      const dir = path.join(base, d.name);
      if (!d.isDirectory() || !isAuditBackup(dir)) continue;
      const ms = fs.statSync(dir).mtimeMs;
      if (newest === null || ms > newest) newest = ms;
    }
  } catch {}
  return newest;
}

/** Names of the .crank/backups/ dirs that hold the manifest init and upgrade write, oldest first. Empty on any error. Never throws. */
export function manifestDirs(crankDir: string): string[] {
  const base = path.join(crankDir, "backups");
  try {
    return fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, "manifest.json"))).sort();
  } catch {
    return [];
  }
}

/** Install time in ms: the stamp of the oldest backup dir with a manifest (init writes it), or null. Never throws. */
export function installedAtMs(crankDir: string): number | null {
  const first = manifestDirs(crankDir)[0];
  const ms = first ? Date.parse(first.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z")) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

/** Whether the audit skill is installed in the project for this agent: `.agents/skills/` on Codex, `.claude/skills/` on Claude. */
export function auditSkillInstalled(projectRoot: string, codex: boolean): boolean {
  return fs.existsSync(path.join(projectRoot, codex ? ".agents" : ".claude", "skills", AUDIT_SKILL, "SKILL.md"));
}

function mtimeOf(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The record and journal debounce: due at NUDGE_STEP changed files, then again
 * only NUDGE_STEP past the count that last nudged the same file version.
 */
function debounce(changed: number, sameFile: boolean, nudgedAt: number | undefined): { baseline: number; due: boolean } {
  const baseline = sameFile ? (nudgedAt ?? 0) : 0;
  return { baseline, due: changed >= NUDGE_STEP && changed >= baseline + NUDGE_STEP };
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
 * Changed files come from git (lib/changes.ts), which sees the writes made
 * through Bash and past the index cap. Outside a git work-tree root, or when
 * git fails or runs out of time, the count falls back to index entries.
 *
 * Record nudge: fires once per cerebrum version, then again only after
 * NUDGE_STEP more source files change. Updating cerebrum bumps its mtime —
 * resetting both the changed count (its mtime jumps ahead of the files) and the
 * debounce baseline — so a fresh recording quiets the nudge. cerebrum.md lives
 * under .crank/ and is never indexable, so editing it can't inflate the count.
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
 * Once the file is back under both limits the floor is cleared, so a later
 * regrowth past a limit nudges at once. A stale floor would count any edit that
 * happens to lower one measure (e.g. 157 lines but fewer tokens than at the old
 * nudge) as a prune in progress.
 *
 * Writes the marker as a side effect when it nudges, and silently in two cases:
 * when it observes a prune in progress, and when it clears the floor. A prune
 * nudge also copies cerebrum.md to .crank/backups/cerebrum/ first. `codex`
 * names AGENTS.md alone in the prune message. Never throws.
 *
 * Audit suggestion: rides along only when another part is due, so it never
 * adds a turn-end message of its own, and only when the audit skill is
 * installed for this agent. Silent for AUDIT_INTERVAL_MS after the last
 * suggestion or the last audit, whichever is later; a project never audited
 * counts from install, so a minutes-old cerebrum is not sent to an audit.
 */
export function cerebrumNudge(crankDir: string, codex = false): string | null {
  const cerebrum = readCerebrum(crankDir);
  const journalMtimeMs = mtimeOf(path.join(crankDir, JOURNAL_FILE));
  if (!cerebrum && journalMtimeMs === null) {
    debugEvent("nudge-skipped", { reason: "no-memory-files" });
    return null;
  }

  // One git run serves both measures: list from the older file, filter per file.
  const { times: changeTimes, source } = changeTimesSince(
    path.dirname(crankDir),
    loadConfig(crankDir),
    Math.min(cerebrum?.mtimeMs ?? Infinity, journalMtimeMs ?? Infinity),
    () => loadIndex(crankDir),
  );
  const changedSince = (mtimeMs: number): number => changeTimes.filter((t) => t > mtimeMs).length;

  const marker = readMarker(crankDir);

  const changed = cerebrum ? changedSince(cerebrum.mtimeMs) : 0;
  const record = debounce(
    changed,
    !!marker && !!cerebrum && marker.cerebrumMtimeMs === cerebrum.mtimeMs,
    marker?.nudgedAtChanged,
  );
  const baseline = record.baseline;
  const recordDue = !!cerebrum && record.due;

  const oversized =
    !!cerebrum && (cerebrum.lineCount > PRUNE_LINE_LIMIT || cerebrum.tokenCount > PRUNE_TOKEN_LIMIT);
  // A missing marker field counts as "did not fall", so a first run — or an old
  // marker written before these fields existed — nudges.
  const shrank =
    !!cerebrum &&
    ((marker?.pruneNudgedLines !== undefined && cerebrum.lineCount < marker.pruneNudgedLines) ||
      (marker?.pruneNudgedTokens !== undefined && cerebrum.tokenCount < marker.pruneNudgedTokens));
  const pruneDue = oversized && !shrank;
  const floor = !cerebrum
    ? { lines: marker?.pruneNudgedLines, tokens: marker?.pruneNudgedTokens }
    : oversized
      ? { lines: cerebrum.lineCount, tokens: cerebrum.tokenCount }
      : { lines: undefined, tokens: undefined };

  const journalChanged = journalMtimeMs === null ? 0 : changedSince(journalMtimeMs);
  const journal = debounce(
    journalChanged,
    !!marker && marker.journalMtimeMs === journalMtimeMs,
    marker?.journalNudgedAtChanged,
  );
  const journalBaseline = journal.baseline;
  const journalDue = journalMtimeMs !== null && journal.due;

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
      source,
      changed,
      baseline,
      journalChanged,
      journalBaseline,
      step: NUDGE_STEP,
      lineCount: cerebrum?.lineCount ?? null,
      tokenCount: cerebrum?.tokenCount ?? null,
    });
    // A prune in progress lowers the floor, and a file back under both limits clears it.
    if (marker && (floor.lines !== marker.pruneNudgedLines || floor.tokens !== marker.pruneNudgedTokens)) {
      writeMarker(crankDir, { ...marker, pruneNudgedLines: floor.lines, pruneNudgedTokens: floor.tokens });
    }
    return null;
  }

  const now = Date.now();
  const lastAudit = lastAuditMs(crankDir);
  const auditDue =
    now - Math.max(marker?.auditSuggestedAtMs ?? 0, lastAudit ?? installedAtMs(crankDir) ?? 0) >= AUDIT_INTERVAL_MS &&
    auditSkillInstalled(path.dirname(crankDir), codex);

  debugEvent("nudge-emitted", {
    source,
    changed,
    baseline,
    journalChanged,
    journalBaseline,
    lineCount: cerebrum?.lineCount ?? null,
    tokenCount: cerebrum?.tokenCount ?? null,
    recordDue,
    pruneDue,
    journalDue,
    auditDue,
  });
  writeMarker(crankDir, {
    // Absent cerebrum: 0 keeps the marker well-formed (readMarker requires a
    // number) and never equals a real mtime, so nothing is wrongly debounced.
    cerebrumMtimeMs: cerebrum?.mtimeMs ?? 0,
    nudgedAtChanged: recordDue ? changed : baseline,
    pruneNudgedLines: floor.lines,
    pruneNudgedTokens: floor.tokens,
    journalMtimeMs: journalMtimeMs ?? marker?.journalMtimeMs,
    journalNudgedAtChanged: journalDue ? journalChanged : journalBaseline,
    auditSuggestedAtMs: auditDue ? now : marker?.auditSuggestedAtMs,
  });

  const parts: string[] = [];
  if (recordDue) {
    parts.push(
      `crank-mem: ${changed} file(s) have changed since .crank/cerebrum.md was last updated. ` +
        `If this session surfaced a user preference, a project convention, a dependency quirk, or a ` +
        `gotcha worth keeping, add a one-line bullet to the matching cerebrum section before moving ` +
        `on. Check for an existing bullet first and update it rather than add a near-copy; when ` +
        `replacing, write (supersedes YYYY-MM-DD: old claim).`,
    );
  }
  if (journalDue) {
    parts.push(
      `crank-mem: ${journalChanged} file(s) changed since the last .crank/journal.md entry. ` +
        `Append one dated bullet — \`- YYYY-MM-DD: what you did; where you left off; NEXT: next step\` ` +
        `— telegram-style. The next session is shown what you did and the \`NEXT:\` clause, so put ` +
        `the handoff there, last: that is how it picks up mid-thread instead of re-deriving where it was.`,
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
    // Pruning by deletion lost a gotcha that a later session re-learned the
    // hard way, so the nudge backs the file up and asks to archive, not delete.
    const backup = backupCerebrum(crankDir, cerebrum.text);
    const longest = longestBullets(cerebrum.text);
    parts.push(
      `crank-mem: .crank/cerebrum.md is at ${over.join(", and ")}. ` +
        (backup ? `A copy of the current file is at ${backup}. ` : "") +
        (longest.length ? `Longest bullets: ${longest.join(", ")}. ` : "") +
        `Prune it now: shorten long bullets to one line of at most ~200 characters; move ` +
        `superseded or one-off entries (finished fixes, entries that cite a commit) to ` +
        `.crank/${ARCHIVE_FILE}, which is not injected but stays greppable; delete only what ` +
        `${instructionFiles(codex)} or the code already states; keep gotchas and do-not-repeat entries. A small ` +
        `trim is not enough; this reminder repeats until the file is back under the limit.`,
    );
  }
  if (auditDue) {
    const when =
      lastAudit === null
        ? "has never been audited"
        : `was last audited ${Math.floor((now - lastAudit) / 86_400_000)} day(s) ago`;
    parts.push(
      `crank-mem: this project's memory ${when}. Suggest the user run the ${AUDIT_SKILL} skill ` +
        `(\`${codex ? "$" : "/"}${AUDIT_SKILL}\`), which checks each cerebrum bullet against the code ` +
        `and prunes what no longer holds; only the user can start it.`,
    );
  }
  return parts.join("\n");
}

// Overlap check state: cerebrum's mtime and a hash per bullet at the last look.
// A file of its own, so it never disturbs the nudge marker's debounce.
export const DEDUP_FILE = "cerebrum-dedup.json";
// A new bullet sharing this many identifiers with an older one is flagged.
// Word overlap misses real duplicates (0.31 Jaccard on an OrcaSlicer pair that
// re-describes the same build failure); shared identifiers catch them.
export const OVERLAP_MIN_SHARED = 2;
const OVERLAP_MAX_PAIRS = 2;
const SHARED_NAMED = 3;

const BACKTICKED = /`([^`\n]+)`/g;
// A file name with a letter extension, with any directory prefix: stop.ts, OpenGL.framework.
const PATH = /(?<![\w./~-])(?:[\w.~-]*\/)*[\w.-]*\w\.[A-Za-z]\w+/g;
// -Werror=unguarded-availability-new, --force. Not "re-run": the dash must open the word.
const FLAG = /(?<![\w-])--?[A-Za-z][\w=.-]*\w/g;
const CAMEL_OR_SNAKE = /\b(?:\w*[a-z][A-Z]\w*|\w*[A-Za-z0-9]_[A-Za-z0-9]\w*)\b/g;
const MIN_WORD = 6;

interface DedupState {
  cerebrumMtimeMs: number;
  bulletHashes: string[];
}

function readDedupState(crankDir: string): DedupState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(crankDir, DEDUP_FILE), "utf-8"));
    if (typeof raw?.cerebrumMtimeMs === "number" && Array.isArray(raw?.bulletHashes)) return raw as DedupState;
  } catch {}
  return null;
}

function hashBullet(body: string): string {
  return createHash("sha1").update(body.trim()).digest("hex").slice(0, 16);
}

/** Backticked spans, paths, flags, and CamelCase or snake_case words, each counted once. */
function identifiers(body: string): Set<string> {
  const ids = new Set<string>();
  // Each kind is cut out before the next, so a path's snake_case stem does not
  // count a second time.
  const take = (text: string, re: RegExp, keep: (m: string) => boolean): string =>
    text.replace(re, (m: string, inner?: string) => {
      const id = typeof inner === "string" ? inner.trim() : m;
      if (keep(id)) ids.add(id);
      return " ";
    });
  let rest = take(body, BACKTICKED, (id) => id.length > 0);
  rest = take(rest, PATH, () => true);
  rest = take(rest, FLAG, () => true);
  take(rest, CAMEL_OR_SNAKE, (id) => id.length >= MIN_WORD);
  return ids;
}

/** Bullet pairs anywhere in `text` that share OVERLAP_MIN_SHARED or more identifiers. */
export function overlapPairCount(text: string): number {
  const ids = bulletsWithLines(text).map((b) => identifiers(b.body));
  let pairs = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < i; j++) {
      if ([...ids[i]!].filter((id) => ids[j]!.has(id)).length >= OVERLAP_MIN_SHARED) pairs++;
    }
  }
  return pairs;
}

/**
 * One line per new cerebrum bullet that shares OVERLAP_MIN_SHARED or more
 * identifiers with an older bullet, at most OVERLAP_MAX_PAIRS, or null.
 *
 * Runs only when cerebrum's mtime moved since the last look, so an unchanged
 * file is never reparsed. The first run records the bullet hashes and stays
 * silent. "New" means a bullet whose hash was not there last time; older
 * bullets are those still present, so an edited bullet is never paired with
 * the version it replaced. The audit's run of this rule found 5 pairs in 63
 * bullets, 2 of them true duplicates, so the message keeps "keep both" a no-op
 * answer. Never throws.
 */
export function cerebrumOverlaps(crankDir: string): string | null {
  try {
    const file = path.join(crankDir, CEREBRUM_FILE);
    const mtimeMs = mtimeOf(file);
    if (mtimeMs === null) return null;
    const state = readDedupState(crankDir);
    if (state && state.cerebrumMtimeMs === mtimeMs) return null;

    const bullets = bulletsWithLines(fs.readFileSync(file, "utf-8")).map((b) => ({
      ...b,
      hash: hashBullet(b.body),
    }));
    try {
      const next: DedupState = { cerebrumMtimeMs: mtimeMs, bulletHashes: bullets.map((b) => b.hash) };
      fs.writeFileSync(path.join(crankDir, DEDUP_FILE), JSON.stringify(next));
    } catch (err) {
      // Every later Stop reparses and may repeat a flag. Silent by contract.
      debugEvent("dedup-state-write-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!state) return null;

    // Counted, not a set: a second copy of an existing bullet is new.
    const remaining = new Map<string, number>();
    for (const h of state.bulletHashes) remaining.set(h, (remaining.get(h) ?? 0) + 1);
    const older: Array<{ line: number; ids: Set<string> }> = [];
    const added: Array<{ line: number; ids: Set<string> }> = [];
    for (const b of bullets) {
      const left = remaining.get(b.hash) ?? 0;
      if (left > 0) remaining.set(b.hash, left - 1);
      (left > 0 ? older : added).push({ line: b.line, ids: identifiers(b.body) });
    }

    const pairs: Array<{ line: number; olderLine: number; shared: string[] }> = [];
    for (const n of added) {
      let best: { olderLine: number; shared: string[] } | null = null;
      for (const o of older) {
        const shared = [...n.ids].filter((id) => o.ids.has(id));
        if (shared.length >= OVERLAP_MIN_SHARED && shared.length > (best?.shared.length ?? 0)) {
          best = { olderLine: o.line, shared };
        }
      }
      if (best) pairs.push({ line: n.line, ...best });
    }
    debugEvent("overlap-checked", { added: added.length, pairs: pairs.length });
    if (pairs.length === 0) return null;

    const lines = pairs
      .sort((a, b) => b.shared.length - a.shared.length)
      .slice(0, OVERLAP_MAX_PAIRS)
      .map(
        (p) =>
          `crank-mem: new .crank/cerebrum.md bullet at line ${p.line} overlaps line ${p.olderLine} ` +
          `(shared: ${p.shared.slice(0, SHARED_NAMED).map((id) => `\`${id}\``).join(", ")}): ` +
          `merge them, supersede the old one by deleting it and ending the new one with ` +
          `(supersedes YYYY-MM-DD: old claim), or keep both if they say different things, which needs no edit.`,
      );
    return lines.join("\n");
  } catch (err) {
    debugEvent("overlap-check-failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

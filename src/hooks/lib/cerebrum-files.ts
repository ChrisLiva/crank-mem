import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "./config.ts";
import { debugEvent } from "./debug.ts";

// The memory files under .crank/: their names, cerebrum's size limits, and the
// backup helpers that find crank-mem's own copies of them.

// Past either of these, cerebrum has likely accumulated stale or bloated
// entries. Consolidation skips an add that would cross either limit
// (cerebrum-edit.ts → applyEdits); removes and replaces are unbounded, and
// nothing truncates the file. The token limit catches the file that stays under the line count by packing paragraphs
// into a handful of very long bullets; it measures with the same prose estimate
// injection.ts uses on this file, and sits well above CEREBRUM_INJECT_TOKEN_CAP
// (only an excerpt is ever injected).
export const PRUNE_LINE_LIMIT = 150;
export const PRUNE_TOKEN_LIMIT = 3000;

// backupCerebrum copies cerebrum.md here so an edit that cuts a load-bearing
// entry can be undone. No manifest.json, so `uninstall --restore` never
// mistakes this dir for an init/upgrade backup (cli/backups.ts);
// `uninstall --delete-crank` removes it by name.
export const BACKUP_DIR = path.join("backups", "cerebrum");
export const CEREBRUM_FILE = "cerebrum.md";
// Where superseded entries go; never injected.
export const ARCHIVE_FILE = "cerebrum-archive.md";
const BACKUP_KEEP = 5;

// Episodic memory, `.crank/journal.md`. No hook reads or writes it.
export const JOURNAL_FILE = "journal.md";
// Upkeep state earlier releases wrote under .crank/. Nothing reads or writes
// either any more; `uninstall --delete-crank` removes them by name.
export const MARKER_FILE = "cerebrum-nudge.json";
export const DEDUP_FILE = "cerebrum-dedup.json";

// The audit skill sets disable-model-invocation, so only the user can start it.
const AUDIT_SKILL = "crank-mem-audit";

/**
 * The one file-name stamp: an ISO time with `:` and `.` made filename-safe.
 * `installedAtMs` and store-upkeep's `DAILY_SNAPSHOT` parse this format back.
 */
export function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Copy cerebrum.md, given as text or raw bytes, to
 * backups/cerebrum/<timestamp>.md unless the newest copy already matches,
 * keeping the last BACKUP_KEEP. Returns the project-relative
 * path of the copy that matches the file now, or null when the copy failed.
 */
export function backupCerebrum(crankDir: string, text: string | Buffer): string | null {
  try {
    const dir = path.join(crankDir, BACKUP_DIR);
    fs.mkdirSync(dir, { recursive: true });
    // ISO stamps sort chronologically, so the last name is the newest copy.
    const copies = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    let name = copies[copies.length - 1];
    if (!name || !fs.readFileSync(path.join(dir, name)).equals(Buffer.from(text))) {
      name = fileStamp() + ".md";
      fs.writeFileSync(path.join(dir, name), text);
      copies.push(name);
    }
    for (const old of copies.slice(0, -BACKUP_KEEP))
      fs.rmSync(path.join(dir, old), { force: true });
    return path.join(".crank", BACKUP_DIR, name);
  } catch (err) {
    debugEvent("cerebrum-backup-failed", {
      error: errorMessage(err),
    });
    return null;
  }
}

/**
 * Split a cerebrum at its first line starting `## `: `preamble` is every byte
 * before that line (the whole text when there is none), `body` the rest from it
 * on, or null when there is none.
 */
export function splitPreamble(md: string): { preamble: string; body: string | null } {
  const cut = md.startsWith("## ") ? 0 : md.indexOf("\n## ") + 1;
  if (cut === 0 && !md.startsWith("## ")) return { preamble: md, body: null };
  return { preamble: md.slice(0, cut), body: md.slice(cut) };
}

// What the audit skill's backup step copies (skills/crank-mem-audit/SKILL.md).
const AUDIT_BACKUP_FILES = new Set([CEREBRUM_FILE, JOURNAL_FILE, ARCHIVE_FILE]);

/**
 * True for a .crank/backups/ dir the audit skill wrote: it holds only copies of
 * the memory files, so no manifest.json (init and upgrade backups), no
 * timestamped copies (backupCerebrum's backups/cerebrum/), and nothing another
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
  } catch {
    // No backups/ dir or an unreadable entry: lastAuditMs never throws.
  }
  return newest;
}

/** Names of the .crank/backups/ dirs that hold the manifest init and upgrade write, oldest first. Empty on any error. Never throws. */
export function manifestDirs(crankDir: string): string[] {
  const base = path.join(crankDir, "backups");
  try {
    return fs
      .readdirSync(base)
      .filter((d) => fs.existsSync(path.join(base, d, "manifest.json")))
      .sort();
  } catch {
    return [];
  }
}

/** Install time in ms: the stamp of the oldest backup dir with a manifest (init writes it), or null. Never throws. */
export function installedAtMs(crankDir: string): number | null {
  const first = manifestDirs(crankDir)[0];
  const ms = first
    ? Date.parse(first.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z"))
    : NaN;
  return Number.isNaN(ms) ? null : ms;
}

/** Whether the audit skill is installed in the project for this agent: `.agents/skills/` on Codex, `.claude/skills/` on Claude. */
export function auditSkillInstalled(projectRoot: string, codex: boolean): boolean {
  return fs.existsSync(
    path.join(projectRoot, codex ? ".agents" : ".claude", "skills", AUDIT_SKILL, "SKILL.md"),
  );
}

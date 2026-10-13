import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "./args.ts";
import { choose } from "./prompt.ts";
import {
  removeCrankHooksFromFile, removeIgnoreLines, removeCodexFeatures,
  isLegacyHookCommand, LEGACY_IGNORE_BLOCK,
} from "./settings.ts";
import {
  crankTrust, removeTrustEntries, userCodexConfigPath,
} from "./codex-trust.ts";
import { CRANK_DIR, CONFIG_FILE } from "../hooks/lib/config.ts";
import { INDEX_FILE, ANATOMY_FILE } from "../hooks/lib/store.ts";
import { LOCK_FILE } from "../hooks/lib/lock.ts";
import { MARKER_FILE, DEDUP_FILE, CEREBRUM_FILE, ARCHIVE_FILE, BACKUP_DIR, isCrankBackup } from "../hooks/lib/cerebrum-nudge.ts";
import { JOURNAL_FILE } from "../hooks/lib/journal.ts";
import { LOG_FILE } from "../hooks/lib/debug.ts";
import { openProject } from "./project.ts";
import { latestBackupDir, restoreBackup, absentAtInit } from "./backups.ts";

// Remove all crank-mem wiring. Default is surgical: strip exactly the
// entries/lines we added (safe alongside post-init user edits). --restore
// instead restores the init-time backups byte-identically. Never touches the
// ADR directory.

export async function run(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, []);

  // A leftover pre-rename install (only crank/, no .crank/) can't be opened as
  // a project — sweep it and stop, so the new CLI can clean up after itself.
  const cwd = process.cwd();
  if (!fs.existsSync(path.join(cwd, CRANK_DIR, "config.json")) && legacyPresent(cwd)) {
    sweepLegacy(cwd);
    console.log("crank-mem: removed legacy crank/ install.");
    return 0;
  }

  const project = openProject();
  if (!project) return 1;
  const { root, crankDir, config } = project;

  const restore =
    flags.restore === true ||
    (!flags.yes &&
      (await choose("Restore modified files from the init-time backup?", ["restore", "surgical"], "surgical")) === "restore");

  const codexHooksJson = path.join(root, ".codex", "hooks.json");

  // Trust entries first: keys come from hooks.json as it stands, before we
  // strip our groups out of it. Both spellings go — older releases keyed on
  // the raw PascalCase event and left those entries orphaned.
  if (config.codex_trust_written) {
    removeTrustEntries(userCodexConfigPath(), crankTrust(codexHooksJson).keys);
    console.log(`  removed trusted_hash entries from ${userCodexConfigPath()}`);
  }

  if (restore) {
    const backupDir = latestBackupDir(crankDir);
    if (!backupDir) {
      console.error("crank-mem: no backups found — falling back to surgical removal.");
    } else {
      for (const restored of restoreBackup(backupDir)) console.log(`  restored ${restored}`);
    }
  }

  // Surgical removal is idempotent — run it even after a restore, in case the
  // backup predates some wiring. It only ever strips crank-mem's own entries.
  for (const f of [
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.local.json"),
    codexHooksJson,
  ]) {
    if (removeCrankHooksFromFile(f)) console.log(`  removed crank hooks from ${path.relative(root, f)}`);
    // Delete a now-empty object only when the manifest proves we created the
    // file — a user's own literal {} must survive.
    if (!absentAtInit(crankDir, f)) continue;
    try {
      if (fs.existsSync(f) && JSON.stringify(JSON.parse(fs.readFileSync(f, "utf-8"))) === "{}") {
        fs.unlinkSync(f);
        console.log(`  deleted now-empty ${path.relative(root, f)}`);
      }
    } catch {}
  }

  const gitignore = path.join(root, ".gitignore");
  removeIgnoreLines(gitignore);
  try {
    if (fs.existsSync(gitignore) && fs.readFileSync(gitignore, "utf-8").trim() === "") fs.unlinkSync(gitignore);
  } catch {}
  removeIgnoreLines(path.join(root, ".git", "info", "exclude"));
  removeCodexFeatures(path.join(root, ".codex", "config.toml"));

  // A migrated project that was re-init'd on top of an old checkout still
  // carries the pre-rename crank/ dir and its duplicate hook wiring — sweep it.
  sweepLegacy(root);

  removeEmptyDirs(root, [".codex", ".claude"]);

  const deleteCrank =
    flags["delete-crank"] === true ||
    (flags["keep-crank"] !== true && !flags.yes &&
      (await choose("Delete the .crank/ data directory?", ["delete", "keep"], "keep")) === "delete");

  if (deleteCrank) {
    const left = deleteOwnedFiles(crankDir);
    if (left.length === 0) console.log("  deleted .crank/");
    else console.log(`  deleted crank-mem's files from .crank/, kept what other tools wrote: ${left.join(", ")}`);
  } else {
    console.log("  kept .crank/ (delete it manually when ready)");
  }

  console.log("crank-mem: uninstalled.");
  return 0;
}

/**
 * True if this project carries a pre-rename crank/ install. Keyed on
 * crank/config.json (as project.ts's detection is) so a user's own directory
 * that merely happens to be named crank/ is never mistaken for ours.
 */
function legacyPresent(root: string): boolean {
  return fs.existsSync(path.join(root, "crank", "config.json"));
}

/**
 * Remove every artifact of a pre-rename (non-dotted crank/) install without
 * prompting: legacy hook entries, its Codex trust hashes, ignore lines, and
 * the directory itself. Idempotent — a no-op when there is nothing legacy.
 */
function sweepLegacy(root: string): void {
  const codexHooksJson = path.join(root, ".codex", "hooks.json");

  // Trust keys come from the legacy entries' positions in hooks.json, read
  // before we strip them. Removal is a safe no-op if trust was never written.
  const legacyKeys = crankTrust(codexHooksJson, isLegacyHookCommand).keys;
  if (legacyKeys.length) {
    removeTrustEntries(userCodexConfigPath(), legacyKeys);
    console.log(`  removed legacy trusted_hash entries from ${userCodexConfigPath()}`);
  }

  for (const f of [
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.local.json"),
    codexHooksJson,
  ]) {
    if (removeCrankHooksFromFile(f, isLegacyHookCommand))
      console.log(`  removed legacy crank hooks from ${path.relative(root, f)}`);
  }

  removeIgnoreLines(path.join(root, ".gitignore"), LEGACY_IGNORE_BLOCK);
  removeIgnoreLines(path.join(root, ".git", "info", "exclude"), LEGACY_IGNORE_BLOCK);

  // Delete the directory only when it's provably ours (see legacyPresent).
  if (legacyPresent(root)) {
    fs.rmSync(path.join(root, "crank"), { recursive: true, force: true });
    console.log("  deleted legacy crank/");
  }
}

/**
 * Delete only what crank-mem writes into .crank/, since another tool may share
 * the directory, and return the entries left behind. .gitignore goes only with
 * the directory, because it keeps a remaining tool's files out of git.
 */
function deleteOwnedFiles(crankDir: string): string[] {
  const owned = [
    CONFIG_FILE, INDEX_FILE, ANATOMY_FILE, LOCK_FILE, MARKER_FILE, DEDUP_FILE, JOURNAL_FILE, LOG_FILE,
    CEREBRUM_FILE, ARCHIVE_FILE, BACKUP_DIR, "hooks",
  ];
  for (const name of owned) fs.rmSync(path.join(crankDir, name), { recursive: true, force: true });
  for (const name of readdirOrEmpty(crankDir)) {
    if (name.endsWith(".tmp")) fs.rmSync(path.join(crankDir, name), { force: true });
  }
  const backups = path.join(crankDir, "backups");
  for (const name of readdirOrEmpty(backups)) {
    const dir = path.join(backups, name);
    if (isCrankBackup(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  removeEmptyDirs(crankDir, ["backups"]);
  const left = readdirOrEmpty(crankDir).filter((name) => name !== ".gitignore");
  if (left.length === 0) fs.rmSync(crankDir, { recursive: true, force: true });
  return left;
}

function readdirOrEmpty(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function removeEmptyDirs(root: string, names: string[]): void {
  for (const d of names) {
    const dir = path.join(root, d);
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {}
  }
}

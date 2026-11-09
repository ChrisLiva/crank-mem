import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "./args.ts";
import { COMMANDS } from "./commands.ts";
import { choose } from "./prompt.ts";
import {
  removeCrankHooksFromFile,
  removeIgnoreLines,
  isLegacyHookCommand,
  LEGACY_IGNORE_BLOCK,
} from "./settings.ts";
import { crankTrust, removeTrustEntries, userCodexConfigPath } from "./codex-trust.ts";
import { CRANK_DIR, CONFIG_FILE, LOCAL_CONFIG_FILE } from "../hooks/lib/config.ts";
import { INDEX_FILE, ANATOMY_FILE } from "../hooks/lib/store.ts";
import { LOCK_FILE } from "../hooks/lib/lock.ts";
import {
  MARKER_FILE,
  DEDUP_FILE,
  CEREBRUM_FILE,
  ARCHIVE_FILE,
  BACKUP_DIR,
  isCrankBackup,
  JOURNAL_FILE,
} from "../hooks/lib/cerebrum-files.ts";
import { LOG_FILE } from "../hooks/lib/debug.ts";
import { MEMORY_FILE } from "../hooks/lib/memory.ts";
import { SNAPSHOT_DIR } from "../hooks/lib/store-upkeep.ts";
import { USAGE_FILE, USAGE_ROTATED_FILE } from "../hooks/lib/usage.ts";
import { openProject } from "./project.ts";
import { restoreInstall } from "./backups.ts";
import { attemptRemoval, installPaths, removeInstall, type Report } from "./install.ts";

// Remove all crank-mem wiring. Default is surgical: strip exactly the
// entries/lines we added (safe alongside post-init user edits). --restore
// runs between two surgical passes: it puts back each project file as it was
// before crank-mem first changed it and leaves files outside the project, such
// as ~/.codex/config.toml, as is.
// Never touches the ADR directory.

export async function run(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, COMMANDS.uninstall.value);

  // Both removal passes and the legacy sweep can hit the same file, so each
  // distinct stderr line prints once per run, in first-seen order.
  const seen = new Set<string>();
  const warn = (line: string): void => {
    if (seen.has(line)) return;
    seen.add(line);
    console.error(line);
  };
  const print = (r: Report): Report => {
    for (const line of r.lines) console.log(line);
    for (const warning of r.warnings) warn(warning);
    return r;
  };

  // A leftover pre-rename install (only crank/, no .crank/) can't be opened as
  // a project — sweep it and stop, so the new CLI can clean up after itself.
  const cwd = process.cwd();
  if (!fs.existsSync(path.join(cwd, CRANK_DIR, "config.json")) && legacyPresent(cwd)) {
    const swept = print(sweepLegacy(cwd));
    console.log("crank-mem: removed legacy crank/ install.");
    return swept.failed ? 1 : 0;
  }

  const project = openProject();
  if (!project) return 1;
  const { root, crankDir } = project;

  const restore =
    flags.restore === true ||
    (!flags.yes &&
      (await choose(
        "Restore the files crank-mem changed, as they were before it first changed them?",
        ["restore", "surgical"],
        "surgical",
      )) === "restore");

  let status = print(removeInstall(project)).failed ? 1 : 0;
  if (restore) {
    const result = restoreInstall(crankDir);
    if (result.status === "no-backups") {
      warn("crank-mem: no backups found — falling back to surgical removal.");
    } else if (result.status === "unreadable") {
      warn(
        `crank-mem: could not read ${result.manifest} (${result.detail}) — falling back to surgical removal.`,
      );
      status = 1;
    } else {
      for (const p of result.paths) {
        if (p.outcome === "copied") console.log(`  restored ${p.path}`);
        else if (p.outcome === "removed") console.log(`  removed ${p.path} (crank-mem created it)`);
        else if (p.outcome === "outside")
          console.log(`  left ${p.path} as is (outside this project)`);
        else {
          warn(`crank-mem: could not restore ${p.path} (${p.code})`);
          status = 1;
        }
      }
    }
    // A second pass strips whatever the restored copies still carry, in
    // case a backup predates some wiring. It only strips crank-mem's entries.
    if (print(removeInstall(project)).failed) status = 1;
  }

  // A migrated project that was re-init'd on top of an old checkout still
  // carries the pre-rename crank/ dir and its duplicate hook wiring — sweep it.
  if (print(sweepLegacy(root)).failed) status = 1;

  removeEmptyDirs(root, [".codex", ".claude"]);

  const deleteCrank =
    flags["delete-crank"] === true ||
    (flags["keep-crank"] !== true &&
      !flags.yes &&
      (await choose("Delete the .crank/ data directory?", ["delete", "keep"], "keep")) ===
        "delete");

  if (deleteCrank) {
    const left = deleteOwnedFiles(crankDir);
    if (left.length === 0) console.log("  deleted .crank/");
    else
      console.log(
        `  deleted crank-mem's files from .crank/, kept what other tools wrote: ${left.join(", ")}`,
      );
  } else {
    console.log("  kept .crank/ (delete it manually when ready)");
  }

  console.log("crank-mem: uninstalled.");
  return status;
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
function sweepLegacy(root: string): Report {
  const { claudeShared, claudeLocal, codexHooks, gitignore, gitExclude } = installPaths(root);
  const r: Report = { lines: [], warnings: [], failed: false };

  // Trust keys come from the legacy entries' positions in hooks.json, read
  // before we strip them. Removal is a safe no-op if trust was never written.
  attemptRemoval(r, root, userCodexConfigPath(), () => {
    const legacyKeys = crankTrust(codexHooks, isLegacyHookCommand).keys;
    if (legacyKeys.length) {
      removeTrustEntries(userCodexConfigPath(), legacyKeys);
      r.lines.push(`  removed legacy trusted_hash entries from ${userCodexConfigPath()}`);
    }
  });

  for (const f of [claudeShared, claudeLocal, codexHooks]) {
    attemptRemoval(r, root, f, () => {
      if (removeCrankHooksFromFile(f, isLegacyHookCommand))
        r.lines.push(`  removed legacy crank hooks from ${path.relative(root, f)}`);
    });
  }

  attemptRemoval(r, root, gitignore, () => removeIgnoreLines(gitignore, LEGACY_IGNORE_BLOCK));
  attemptRemoval(r, root, gitExclude, () => removeIgnoreLines(gitExclude, LEGACY_IGNORE_BLOCK));

  // Delete the directory only when it's provably ours (see legacyPresent).
  const legacyDir = path.join(root, "crank");
  attemptRemoval(r, root, legacyDir, () => {
    if (legacyPresent(root)) {
      fs.rmSync(legacyDir, { recursive: true, force: true });
      r.lines.push("  deleted legacy crank/");
    }
  });
  return r;
}

/**
 * Delete only what crank-mem writes into .crank/, since another tool may share
 * the directory, and return the entries left behind. .gitignore goes only with
 * the directory, because it keeps a remaining tool's files out of git.
 */
function deleteOwnedFiles(crankDir: string): string[] {
  const owned = [
    CONFIG_FILE,
    LOCAL_CONFIG_FILE,
    INDEX_FILE,
    ANATOMY_FILE,
    LOCK_FILE,
    MARKER_FILE,
    DEDUP_FILE,
    JOURNAL_FILE,
    LOG_FILE,
    CEREBRUM_FILE,
    ARCHIVE_FILE,
    BACKUP_DIR,
    SNAPSHOT_DIR,
    "hooks",
    MEMORY_FILE,
    `${MEMORY_FILE}-wal`,
    `${MEMORY_FILE}-shm`,
    USAGE_FILE,
    USAGE_ROTATED_FILE,
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

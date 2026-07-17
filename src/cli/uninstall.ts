import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "./args.ts";
import { choose } from "./prompt.ts";
import {
  removeCrankHooksFromFile, removeIgnoreLines, removeCodexFeatures,
} from "./settings.ts";
import { trustEntriesFromFile, removeTrustEntries, userCodexConfigPath } from "./codex-trust.ts";
import { openProject } from "./project.ts";
import { latestBackupDir, restoreBackup, absentAtInit } from "./backups.ts";

// Remove all crank-mem wiring. Default is surgical: strip exactly the
// entries/lines we added (safe alongside post-init user edits). --restore
// instead restores the init-time backups byte-identically. Never touches the
// ADR directory.

export async function run(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, []);
  const project = openProject();
  if (!project) return 1;
  const { root, crankDir, config } = project;

  const restore =
    flags.restore === true ||
    (!flags.yes && process.stdin.isTTY &&
      (await choose("Restore modified files from the init-time backup?", ["restore", "surgical"], "surgical")) === "restore");

  const codexHooksJson = path.join(root, ".codex", "hooks.json");

  // Trust entries first: keys come from hooks.json as it stands, before we
  // strip our groups out of it.
  if (config.codex_trust_written) {
    const keys = trustEntriesFromFile(codexHooksJson).map((e) => e.key);
    removeTrustEntries(userCodexConfigPath(), keys);
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
  for (const d of [".codex", ".claude"]) {
    const dir = path.join(root, d);
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {}
  }

  const deleteCrank =
    flags["delete-crank"] === true ||
    (flags["keep-crank"] !== true && !flags.yes && process.stdin.isTTY &&
      (await choose("Delete the crank/ data directory?", ["delete", "keep"], "keep")) === "delete");

  if (deleteCrank) {
    fs.rmSync(crankDir, { recursive: true, force: true });
    console.log("  deleted crank/");
  } else {
    console.log("  kept crank/ (delete it manually when ready)");
  }

  console.log("crank-mem: uninstalled.");
  return 0;
}

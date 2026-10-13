import * as fs from "node:fs";
import * as path from "node:path";
import { cliVersion, REPO_ROOT } from "./version.ts";
import { vendorHooks, templatePath } from "./vendor.ts";
import { openProject } from "./project.ts";
import { newBackupDir, backupFile } from "./backups.ts";
import {
  trustEntriesFromFile, staleTrustKeysFromFile, writeTrustEntries, userCodexConfigPath, CODEX_REVIEW_HINT,
} from "./codex-trust.ts";
import {
  crankHooks, mergeHooksIntoFile, removeCrankHooksFromFile, hasCrankHooks, claudeSettingsFiles, unignoreCerebrum,
  ensureCrankGitignore,
} from "./settings.ts";
import { saveConfig } from "../hooks/lib/config.ts";

// Non-interactive: re-vendor hooks after a `git pull` in the clone and repair
// the hook wiring, the .crank/.gitignore allowlist and, in commit mode, a stale
// crank-mem ignore block. Never touches config.json values (beyond the version
// stamp), cerebrum, or the index. Recomputes Codex trusted hashes iff the user
// opted in at init.

export async function run(_args: string[]): Promise<number> {
  const project = openProject();
  if (!project) return 1;
  const { root, crankDir, config } = project;
  const current = cliVersion();

  // Ahead of the version check: installs predating the journal have no
  // journal.md, and neither does one whose journal was deleted at the current
  // version — both leave the trim, injection, and nudge with nothing to work
  // with, and only this reseeds them. Never clobbers: an existing journal is
  // the session log itself.
  // Seeding runs before the backups below, so a failure here must not abort an
  // upgrade that would otherwise succeed — an absent journal costs a nudge, not
  // an install.
  const journalPath = path.join(crankDir, "journal.md");
  if (!fs.existsSync(journalPath)) {
    try {
      fs.copyFileSync(templatePath("journal.md"), journalPath);
      console.log(`crank-mem: seeded .crank/journal.md`);
    } catch (err) {
      console.error(`crank-mem: could not seed .crank/journal.md (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // Ahead of the version check too: an install from before clone_root existed,
  // or one whose clone has moved, is at the current version but cannot report
  // drift — so a same-version upgrade repairs the field instead of waiting for
  // the next release to arm the check.
  if (config.clone_root !== REPO_ROOT) {
    config.clone_root = REPO_ROOT;
    saveConfig(crankDir, config);
  }

  // Created on first use, so an upgrade that changes nothing leaves no backup.
  let backupDir: string | null = null;
  const backup = (file: string) => backupFile((backupDir ??= newBackupDir(crankDir)), file);

  // Ahead of the version check too: a wiring change (a new event, a new
  // command form) must reach installs already at the current version, and
  // crank hooks left in the Claude settings file the git mode does not use
  // run every event twice. A corrupt settings file costs the re-wire, not the
  // upgrade.
  const codexHooksJson = path.join(root, ".codex", "hooks.json");
  let codexRewired = false;
  try {
    const { wired, other } = claudeSettingsFiles(root, config.git);
    if (hasCrankHooks(other)) {
      backup(other);
      removeCrankHooksFromFile(other);
      console.log(`  removed duplicate crank hooks from ${path.relative(root, other)}`);
    }
    if (mergeHooksIntoFile(wired, crankHooks(config.runtime, "claude"), () => backup(wired))) {
      console.log(`  re-wired Claude Code hooks in ${path.relative(root, wired)}`);
    }
    // Codex wiring was opt-in at init: leave a hooks.json without crank entries alone.
    if (hasCrankHooks(codexHooksJson)) {
      codexRewired = mergeHooksIntoFile(codexHooksJson, crankHooks(config.runtime, "codex"), () => backup(codexHooksJson));
      if (codexRewired) {
        console.log(`  re-wired Codex hooks in .codex/hooks.json`);
        if (!config.codex_trust_written) for (const line of CODEX_REVIEW_HINT) console.log(line);
      }
    }
  } catch (err) {
    console.error(`crank-mem: could not re-wire hooks (${err instanceof Error ? err.message : String(err)})`);
  }

  // Ahead of the version check too: an install from before the allowlist keeps
  // a denylist that misses state files added since, such as cerebrum-dedup.json,
  // and every file another tool sharing .crank/ writes.
  try {
    if (ensureCrankGitignore(crankDir, backup)) console.log(`  wrote the allowlist .crank/.gitignore`);
  } catch (err) {
    console.error(`crank-mem: could not write .crank/.gitignore (${err instanceof Error ? err.message : String(err)})`);
  }

  // An install switched to commit mode can still carry the ignore block its
  // earlier ignore or exclude-mode init wrote, which keeps cerebrum out of git.
  if (config.git === "commit") {
    try {
      const ignoredBy = unignoreCerebrum(root, (f) => {
        backup(f);
        console.log(`  removed the crank-mem .crank/ ignore block from ${path.relative(root, f)}`);
      });
      if (ignoredBy) console.error(`crank-mem: warning: git ignores .crank/cerebrum.md via ${ignoredBy}, so commit mode cannot track it.`);
    } catch (err) {
      console.error(`crank-mem: could not check .crank/cerebrum.md against git ignores (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const versionChanged = config.vendored_version !== current;
  if (config.codex_trust_written && (versionChanged || codexRewired)) {
    backup(userCodexConfigPath());
    writeTrustEntries(
      userCodexConfigPath(),
      trustEntriesFromFile(codexHooksJson),
      staleTrustKeysFromFile(codexHooksJson),
    );
    console.log(`  recomputed Codex trusted_hash entries`);
  }

  if (!versionChanged) {
    console.log(`crank-mem: already at ${current} — nothing else to do.`);
    return 0;
  }

  // Backup the vendored hooks (as files under a timestamped backup dir).
  const hooksDir = path.join(crankDir, "hooks");
  if (fs.existsSync(hooksDir)) {
    fs.cpSync(hooksDir, path.join((backupDir ??= newBackupDir(crankDir)), "hooks"), { recursive: true });
  }

  vendorHooks(crankDir);
  const prev = config.vendored_version;
  config.vendored_version = current;
  saveConfig(crankDir, config);

  console.log(`crank-mem: upgraded vendored hooks ${prev} → ${current}`);
  return 0;
}

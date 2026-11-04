import * as fs from "node:fs";
import * as path from "node:path";
import { cliVersion, REPO_ROOT } from "./version.ts";
import { installPackages } from "./setup.ts";
import { vendorHooks, templatePath } from "./vendor.ts";
import { openProject } from "./project.ts";
import { newBackupDir, backupFile } from "./backups.ts";
import {
  crankTrust, writeTrustEntries, userCodexConfigPath, CODEX_REVIEW_HINT,
} from "./codex-trust.ts";
import {
  crankHooks, mergeHooksIntoFile, removeCrankHooksFromFile, hasCrankHooks, claudeSettingsFiles, unignoreCerebrum,
  ensureCrankGitignore, isCrankHookCommand, addIgnoreLines, modeIgnoreFile, addAllowRule,
} from "./settings.ts";
import { saveConfig } from "../hooks/lib/config.ts";
import { CEREBRUM_FILE, splitPreamble } from "../hooks/lib/cerebrum-files.ts";
import { memoryPath, openMemory } from "../hooks/lib/memory.ts";

// Non-interactive: re-vendor hooks after a `git pull` in the clone and repair
// the hook wiring, the .crank/.gitignore allowlist, and the git mode's ignore
// state: commit mode loses a stale crank-mem ignore block, ignore and exclude
// mode regain a missing one. It puts CRANK_ALLOW_RULES in the wired Claude
// settings file in place of LEGACY_ALLOW_RULE, and installs the clone's
// packages. Of config.json it updates only vendored_version and
// clone_root. Of cerebrum it replaces only an unedited 0.8.1 template preamble,
// after backing the file up; it never touches the index. Recomputes Codex
// trusted hashes iff the user opted in at init.

export async function run(_args: string[]): Promise<number> {
  const project = openProject();
  if (!project) return 1;
  const { root, crankDir, config } = project;
  const current = cliVersion();

  // Every repair from here to the version check runs at any version, so an
  // install already at the current version still converges.

  // An install from before clone_root existed, or one whose clone has moved, is
  // at the current version but cannot report drift — so a same-version upgrade
  // repairs the field instead of waiting for the next release to arm the check.
  if (config.clone_root !== REPO_ROOT) {
    config.clone_root = REPO_ROOT;
    saveConfig(crankDir, config);
  }

  // Created on first use, so an upgrade that changes nothing leaves no backup.
  let backupDir: string | null = null;
  const backup = (file: string) => backupFile((backupDir ??= newBackupDir(crankDir)), file);

  // A wiring change (a new event, a new command form) must reach installs
  // already at the current version, and crank hooks left in the Claude settings
  // file the git mode does not use run every event twice. A corrupt settings
  // file costs the re-wire, not the upgrade.
  const codexHooksJson = path.join(root, ".codex", "hooks.json");
  let codexRewired = false;
  try {
    const { wired, other } = claudeSettingsFiles(root, config.git);
    if (hasCrankHooks(other)) {
      removeCrankHooksFromFile(other, isCrankHookCommand, backup);
      console.log(`  removed duplicate crank hooks from ${path.relative(root, other)}`);
    }
    if (mergeHooksIntoFile(wired, crankHooks(config.runtime, "claude"), backup)) {
      console.log(`  re-wired Claude Code hooks in ${path.relative(root, wired)}`);
    }
    if (addAllowRule(wired, backup)) console.log("  added the crank-mem recall rules to permissions.allow");
    // Codex wiring was opt-in at init: leave a hooks.json without crank entries alone.
    if (hasCrankHooks(codexHooksJson)) {
      codexRewired = mergeHooksIntoFile(codexHooksJson, crankHooks(config.runtime, "codex"), backup);
      if (codexRewired) {
        console.log(`  re-wired Codex hooks in .codex/hooks.json`);
        if (!config.codex_trust_written) for (const line of CODEX_REVIEW_HINT) console.log(line);
      }
    }
  } catch (err) {
    console.error(`crank-mem: could not re-wire hooks (${err instanceof Error ? err.message : String(err)})`);
  }

  // An install from before the allowlist keeps a denylist that misses state
  // files added since, such as cerebrum-dedup.json, and every file another tool
  // sharing .crank/ writes.
  try {
    if (ensureCrankGitignore(crankDir, backup)) console.log(`  wrote the allowlist .crank/.gitignore`);
  } catch (err) {
    console.error(`crank-mem: could not write .crank/.gitignore (${err instanceof Error ? err.message : String(err)})`);
  }

  // 0.8.1 and earlier seeded the cerebrum with a protocol preamble telling
  // agents how to keep it; consolidation keeps it now, so an unedited copy of
  // that preamble gives way to the current template's. An edited one is the
  // user's and stays. latin1 maps each byte to one char, so the body's bytes
  // survive the rewrite even when they are not valid UTF-8.
  try {
    const cerebrumPath = path.join(crankDir, CEREBRUM_FILE);
    if (fs.existsSync(cerebrumPath)) {
      const { preamble, body } = splitPreamble(fs.readFileSync(cerebrumPath, "latin1"));
      if (preamble === fs.readFileSync(templatePath("cerebrum-preamble-0.8.1.md"), "latin1")) {
        const fresh = splitPreamble(fs.readFileSync(templatePath(CEREBRUM_FILE), "latin1")).preamble;
        backup(cerebrumPath);
        fs.writeFileSync(cerebrumPath, fresh + (body ?? ""), "latin1");
        console.log(`  replaced the template preamble of .crank/${CEREBRUM_FILE}`);
      }
    }
  } catch (err) {
    console.error(`crank-mem: could not replace the template preamble of .crank/${CEREBRUM_FILE} (${err instanceof Error ? err.message : String(err)})`);
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

  // An ignore or exclude-mode install without its ignore block, such as one an
  // earlier upgrade under a commit-mode config stripped, exposes .crank/ to git.
  const ignoreFile = modeIgnoreFile(root, config.git);
  if (ignoreFile) {
    try {
      if (addIgnoreLines(ignoreFile, backup)) console.log(`  added the crank-mem .crank/ ignore block to ${path.relative(root, ignoreFile)}`);
    } catch (err) {
      console.error(`crank-mem: could not write ${path.relative(root, ignoreFile)} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // A pull can change package.json at the same version; an install failure
  // costs search by meaning, not the upgrade.
  const installed = installPackages();
  if (!installed.ok) console.error(`crank-mem: could not install packages (${installed.detail})`);

  migrateStore(memoryPath(root));

  const versionChanged = config.vendored_version !== current;
  if (config.codex_trust_written && (versionChanged || codexRewired)) {
    const t = crankTrust(codexHooksJson);
    writeTrustEntries(userCodexConfigPath(), t.entries, t.staleKeys, backup);
    console.log(`  recomputed Codex trusted_hash entries`);
  }

  if (!versionChanged) {
    console.log(`crank-mem: already at ${current} — nothing else to do.`);
    return 0;
  }

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

/**
 * Brings an existing store to the current schema, snapshotting a version-1 store
 * first. It never creates a store, and a store it cannot migrate stays as it was.
 */
export function migrateStore(storeFile: string): void {
  if (!fs.existsSync(storeFile)) return;
  const opened = openMemory(storeFile, "write");
  if (opened.status === "open") {
    if (opened.migratedFrom === 1) console.log("  migrated memory.db v1 → v2");
    opened.memory.close();
  } else if (opened.status === "unmigrated") {
    console.error(`crank-mem: could not migrate memory.db (${opened.detail})`);
  } else if (opened.status === "unreadable") {
    console.error("crank-mem: could not migrate memory.db (unreadable)");
  }
}

import * as fs from "node:fs";
import * as path from "node:path";
import { cliVersion, REPO_ROOT } from "./version.ts";
import { buildDashboard, dashboardCurrent, dashboardDir, installPackages } from "./setup.ts";
import { vendorHooks } from "./vendor.ts";
import { openProject } from "./project.ts";
import { newBackupDir } from "./backups.ts";
import { printReport, repairInstall, resolveCodex } from "./install.ts";
import { CONFIG_FILE, saveConfig } from "../hooks/lib/config.ts";
import { memoryPath, openMemory } from "../hooks/lib/memory.ts";

// Non-interactive: re-vendor hooks after a `git pull` in the clone and repair
// every install item (src/cli/install.ts) to the recorded install: the hook
// wiring, the .crank/.gitignore allowlist, the git mode's ignore state, a
// missing cerebrum and the project registry. It installs the clone's packages,
// rebuilding the dashboard when its build is not for this version.
// Of config.json it updates only vendored_version, clone_root and a missing codex.
// Of cerebrum it seeds a missing one from the template and replaces only an
// unedited 0.8.1 template preamble, after backing the file up; it never touches
// the index. Recomputes Codex trusted hashes only when the config records trust
// and an entry is missing, stale or a PascalCase orphan.
// Exits 1 when any repair failed, after every step has run.

export async function run(_args: string[]): Promise<number> {
  const project = openProject();
  if (!project) return 1;
  const { root, crankDir, config } = project;
  const current = cliVersion();

  // Every repair from here to the version check runs at any version, so an
  // install already at the current version still converges.

  const hadCodexKey = rawHasCodexKey(path.join(crankDir, CONFIG_FILE));

  // An install from before clone_root existed, or one whose clone has moved, is
  // at the current version but cannot report drift — so a same-version upgrade
  // repairs the field instead of waiting for the next release to arm the check.
  if (config.clone_root !== REPO_ROOT) {
    config.clone_root = REPO_ROOT;
    saveConfig(crankDir, config);
  }

  // A config from before `codex` existed records the choice its wiring implies.
  const stamped = { ...config, codex: resolveCodex(root, config) };
  if (!hadCodexKey) saveConfig(crankDir, stamped);

  // Created on first use, so an upgrade that changes nothing leaves no backup.
  let backupDir: string | null = null;
  const ensureBackupDir = () => (backupDir ??= newBackupDir(crankDir));

  const repaired = repairInstall({ root, crankDir, config: stamped, backupDir: ensureBackupDir });
  printReport(repaired);

  // A pull can change package.json at the same version; an install failure
  // costs search by meaning, not the upgrade.
  const installed = installPackages(REPO_ROOT);
  if (!installed.ok) console.error(`crank-mem: could not install packages (${installed.detail})`);
  // A build for another clone version, or none, is rebuilt; a failed build
  // costs the dashboard, not the upgrade.
  if (!dashboardCurrent(path.join(dashboardDir(), "dist"))) {
    const dashInstalled = installPackages(dashboardDir());
    if (!dashInstalled.ok) {
      console.error(`crank-mem: could not install dashboard packages (${dashInstalled.detail})`);
    } else {
      const built = buildDashboard();
      if (!built.ok) console.error(`crank-mem: could not build the dashboard (${built.detail})`);
    }
  }

  migrateStore(memoryPath(root));

  const status = repaired.failed ? 1 : 0;
  const versionChanged = stamped.vendored_version !== current;

  if (!versionChanged) {
    console.log(`crank-mem: already at ${current} — nothing else to do.`);
    return status;
  }

  const hooksDir = path.join(crankDir, "hooks");
  if (fs.existsSync(hooksDir)) {
    fs.cpSync(hooksDir, path.join(ensureBackupDir(), "hooks"), {
      recursive: true,
    });
  }

  vendorHooks(crankDir);
  const prev = stamped.vendored_version;
  stamped.vendored_version = current;
  saveConfig(crankDir, stamped);

  console.log(`crank-mem: upgraded vendored hooks ${prev} → ${current}`);
  return status;
}

/** Whether config.json as written holds a `codex` key; a read or parse failure counts as none. */
function rawHasCodexKey(file: string): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    return typeof parsed === "object" && parsed !== null && "codex" in parsed;
  } catch {
    return false;
  }
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

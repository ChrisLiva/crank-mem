import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "./args.ts";
import { COMMANDS } from "./commands.ts";
import { cliVersion, installedCopy, REPO_ROOT, toolRoot } from "./version.ts";
import { printUpdateNotice } from "./updates.ts";
import { dashboardCurrent, dashboardDir, installPackages, setUpDashboard } from "./setup.ts";
import { openProject, reportMigration } from "./project.ts";
import { newBackupDir } from "./backups.ts";
import { printReport, repairInstall, resolveCodex } from "./install.ts";
import {
  CONFIG_FILE,
  CRANK_DIR,
  errorMessage,
  loadConfig,
  readJsonObject,
  saveConfig,
} from "../hooks/lib/config.ts";
import { CLI_LOCK_BUDGET_MS, withLock } from "../hooks/lib/lock.ts";
import { memoryPath, migrateStore } from "../hooks/lib/memory.ts";
import { projectName } from "../hooks/lib/owner.ts";
import { registeredRoots } from "../hooks/lib/registry.ts";
import { fullScan } from "../hooks/lib/scanner.ts";
import { commitIndex, INDEX_FILE, INDEX_VERSION } from "../hooks/lib/store.ts";
import { scanCompleteLine } from "./scan.ts";

// Non-interactive. Once per run it installs the tool's packages and, in a
// clone, rebuilds a dashboard not built for this version. `--all` repairs every
// registered project, each under its anatomy lock. Of config.json it updates
// only vendored_version, clone_root, a missing codex and a missing name; it
// scans an index that is missing or not at INDEX_VERSION. Exits 1 when any
// repair failed, after every step has run. src/cli/install.ts → ITEMS holds
// the per-item repair rules.

export async function run(args: string[]): Promise<number> {
  printUpdateNotice();
  const { flags } = parseArgs(args, COMMANDS.upgrade.value);
  if (flags.all === true) {
    upgradeTool();
    return repairAll();
  }
  const project = openProject();
  if (!project) return 1;
  upgradeTool();
  return (await repairProject(project.root, { lock: false })) === "failed" ? 1 : 0;
}

/**
 * Installs the tool's packages (production only for an installed copy) and, in
 * a clone, rebuilds a dashboard not built for this version. Writes only stderr;
 * a failure costs search by meaning or the dashboard, not the upgrade.
 */
export function upgradeTool(): void {
  const fromInstalledCopy = installedCopy();
  // A pull can change package.json at the same version.
  const installed = installPackages(REPO_ROOT, { production: fromInstalledCopy });
  if (!installed.ok) console.error(`crank-mem: could not install packages (${installed.detail})`);
  // An installed copy ships its dashboard build.
  if (fromInstalledCopy) return;
  if (!dashboardCurrent(path.join(dashboardDir(), "dist"), cliVersion())) {
    const { error } = setUpDashboard();
    if (error) console.error(error);
  }
}

/**
 * Repairs the project at `root`; `"missing"` when it has no config. With
 * `lock`, the repair runs under its anatomy lock, headed by the root it
 * repairs, and a lock not won within the CLI budget is `"busy"`.
 */
export async function repairProject(
  root: string,
  opts: { lock: boolean },
): Promise<"ok" | "failed" | "busy" | "missing"> {
  const crankDir = path.join(root, CRANK_DIR);
  if (!fs.existsSync(path.join(crankDir, CONFIG_FILE))) return "missing";
  const repair = () => (repairSync(root, crankDir) ? "failed" : "ok");
  // withLock's callback is synchronous, so the whole repair stays inside it.
  const result = opts.lock
    ? withLock(crankDir, CLI_LOCK_BUDGET_MS, () => {
        console.log(`crank-mem: repairing ${root}`);
        return repair();
      })
    : repair();
  if (result === null) return "busy";
  // withLock is not reentrant, so the scan takes the lock after the repair releases it.
  scanLagging(root, crankDir);
  return result;
}

/**
 * Rebuilds the anatomy index when the file on disk is not at INDEX_VERSION. A
 * scan that fails or finds the lock held costs only the scan, never the
 * repair's result or a later project of `--all`.
 */
function scanLagging(root: string, crankDir: string): void {
  if (indexVersion(crankDir) === INDEX_VERSION) return;
  try {
    const config = loadConfig(crankDir);
    const index = commitIndex(crankDir, CLI_LOCK_BUDGET_MS, (current) =>
      fullScan(root, config, current),
    );
    if (index === null) console.error("crank-mem: anatomy busy, scan skipped");
    else console.log(scanCompleteLine(index.meta.fileCount));
  } catch (err) {
    console.error(`crank-mem: could not scan (${errorMessage(err)})`);
  }
}

/**
 * The `version` the index file records; undefined when it is missing or
 * unparsable. Reads the raw file because loadIndex stamps every mismatch with
 * INDEX_VERSION.
 */
function indexVersion(crankDir: string): unknown {
  return readJsonObject(path.join(crankDir, INDEX_FILE))?.version;
}

/** Repairs every registered project in registry order; 1 when any repair failed. */
export async function repairAll(): Promise<number> {
  let status = 0;
  for (const root of registeredRoots()) {
    const result = await repairProject(root, { lock: true });
    if (result === "missing") console.log(`${root}: missing, skipped`);
    else if (result === "busy") console.log(`${root}: busy, skipped`);
    else if (result === "failed") status = 1;
  }
  return status;
}

/** The repair of one opened project, printing its report; true when any repair failed. */
function repairSync(root: string, crankDir: string): boolean {
  const config = loadConfig(crankDir);
  const current = cliVersion();

  // Every repair runs at any version, so an install already at the current
  // version still converges.

  // Keys config.json holds as written; a read or parse failure counts as none.
  const raw = readJsonObject(path.join(crankDir, CONFIG_FILE)) ?? {};

  // An install from before clone_root existed, or one whose clone has moved, is
  // at the current version but cannot report drift — so a same-version upgrade
  // repairs the field instead of waiting for the next release to arm the check.
  const tool = toolRoot();
  if (config.clone_root !== tool) {
    config.clone_root = tool;
    saveConfig(crankDir, config);
  }

  // A config from before `codex` and `name` existed records the choice its wiring
  // implies and the default name; a name already written stays, valid or not.
  if (!("name" in raw)) config.name = projectName(root);
  const stamped = { ...config, codex: resolveCodex(root, config) };
  if (!("codex" in raw && "name" in raw)) saveConfig(crankDir, stamped);

  // Created on first use, so an upgrade that changes nothing leaves no backup.
  let backupDir: string | null = null;
  const ensureBackupDir = () => (backupDir ??= newBackupDir(crankDir));

  const prev = stamped.vendored_version;
  const repaired = repairInstall({ root, crankDir, config: stamped, backupDir: ensureBackupDir });
  printReport(repaired);

  reportMigration(migrateStore(memoryPath(root)));

  if (prev === current) console.log(`crank-mem: already at ${current} — nothing else to do.`);
  else if (stamped.vendored_version === current)
    console.log(`crank-mem: upgraded vendored hooks ${prev} → ${current}`);
  return repaired.failed;
}

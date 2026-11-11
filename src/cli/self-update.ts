import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import type * as sqlite from "node:sqlite";
import * as path from "node:path";
import { errorMessage } from "../hooks/lib/config.ts";
import { memoryPath } from "../hooks/lib/memory.ts";
import { registeredRoots } from "../hooks/lib/registry.ts";
import { crankHome } from "../hooks/lib/user-state.ts";
import { parseArgs, stringFlag } from "./args.ts";
import { COMMANDS } from "./commands.ts";
import {
  activate,
  fetchRelease,
  prepareVersion,
  pruneVersions,
  TOOL_BUSY,
  withToolLock,
} from "./tool-install.ts";
import { checkNow, writeUpdateState } from "./updates.ts";
import { cliVersion, CURRENT_LINK, newer, versionsDir } from "./version.ts";

// `crank-mem self-update`: downloads the latest release (or `--to <tag>`),
// makes it `current`, prunes versions neither it nor this process nor a live
// daemon runs, then repairs every registered project from the new version.
// `--check` checks for a release now; `--auto` and `--check-daily` only
// record their settings in update.json.
// `crank-mem rollback`: makes the previous installed version `current` and
// repairs every project from it. Going back to an older version, by either
// command, first checks that no registered store's schema is newer than it.

/** Runs `upgrade --all` through the `current` link, so the repair runs the version just activated. */
function repairFromCurrent(): number {
  const result = spawnSync(
    path.join(crankHome(), CURRENT_LINK, "bin", "crank-mem"),
    ["upgrade", "--all"],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  return result.status ?? 1;
}

type Blockers = { ok: true } | { ok: false; roots: string[] } | { ok: false; unreadable: true };

/** The registered roots whose memory.db schema is newer than the copy at `targetDir` reads. */
function schemaBlockers(targetDir: string): Blockers {
  let target: number;
  try {
    const text = fs.readFileSync(path.join(targetDir, "src/hooks/lib/memory-schema.ts"), "utf-8");
    const match = /export const SCHEMA_VERSION = (\d+);/.exec(text);
    if (!match) return { ok: false, unreadable: true };
    target = Number(match[1]);
  } catch {
    return { ok: false, unreadable: true };
  }
  const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite | undefined;
  if (!mod) return { ok: true };
  const roots = registeredRoots().filter((root) => {
    let db: sqlite.DatabaseSync | undefined;
    try {
      db = new mod.DatabaseSync(memoryPath(root), { readOnly: true });
      const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
      return Number(row.user_version) > target;
    } catch {
      // A missing store, or one that is not a database, the older version reports itself.
      return false;
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }
  });
  return roots.length === 0 ? { ok: true } : { ok: false, roots };
}

/** Prints why going back to `version` at `dir` is refused; true when it is. */
function refuseOlder(version: string, dir: string): boolean {
  const blockers = schemaBlockers(dir);
  if (blockers.ok) return false;
  if ("unreadable" in blockers) {
    console.error(
      `crank-mem: cannot read the schema version of ${version}; staying on ${cliVersion()}`,
    );
    return true;
  }
  console.error(
    [
      `crank-mem: cannot go back to ${version}: the memory store of these projects is newer than ${version} reads:`,
      ...blockers.roots.map((root) => `  ${root}`),
      `Restore an older snapshot in each with crank-mem restore-memory, or stay on ${cliVersion()}.`,
    ].join("\n"),
  );
  return true;
}

/** The highest installed version below the running one, null when there is none. */
function previousVersion(): string | null {
  let best: string | null = null;
  for (const entry of fs.readdirSync(versionsDir())) {
    if (entry.startsWith(".") || !newer(cliVersion(), entry)) continue;
    if (best === null || newer(entry, best)) best = entry;
  }
  return best;
}

/** Points `current` at `version` and says so; false, after printing why, when it cannot. */
function makeCurrent(version: string): boolean {
  try {
    activate(version);
  } catch (err) {
    console.error(
      `crank-mem: could not make ${version} the current version (${errorMessage(err)})`,
    );
    return false;
  }
  console.log(`crank-mem: ${version} is the current version (was ${cliVersion()})`);
  return true;
}

async function update(tag: string | null): Promise<number> {
  const fetched = await fetchRelease(tag);
  if (!fetched.ok) {
    console.error(`crank-mem: could not update (${fetched.detail})`);
    return 1;
  }
  const { version, dir } = fetched;
  if (version === cliVersion()) {
    console.log(`crank-mem: already at ${version}`);
    return 0;
  }
  if (newer(cliVersion(), version) && refuseOlder(version, dir)) return 1;
  const prepared = prepareVersion(dir);
  if (!prepared.ok) {
    console.error(`crank-mem: could not install ${version} (${prepared.detail})`);
    return 1;
  }
  if (!makeCurrent(version)) return 1;
  try {
    for (const removed of pruneVersions([version, cliVersion()])) {
      console.log(`crank-mem: removed ${removed}`);
    }
  } catch (err) {
    console.error(`crank-mem: could not remove old versions (${errorMessage(err)})`);
  }
  return repairFromCurrent();
}

async function rollback(): Promise<number> {
  const version = previousVersion();
  if (version === null) {
    console.error("crank-mem: no previous version to roll back to");
    return 1;
  }
  if (refuseOlder(version, path.join(versionsDir(), version))) return 1;
  if (!makeCurrent(version)) return 1;
  return repairFromCurrent();
}

/** `--check`: fetches the latest release now and reports it against the running version. */
async function check(): Promise<number> {
  const state = await checkNow();
  if (state.error !== null || state.latest === null) {
    console.error(`crank-mem: could not check for a release (${state.error})`);
    return 1;
  }
  console.log(`crank-mem: installed ${cliVersion()}, latest ${state.latest.version}`);
  return 0;
}

/** `on` → true, `off` → false, absent → undefined, anything else → null. */
function onOff(value: string | boolean | undefined): boolean | undefined | null {
  if (value === undefined) return undefined;
  return value === "on" ? true : value === "off" ? false : null;
}

/** `--auto` / `--check-daily`: records the settings in update.json and nothing else. */
function saveSettings(
  autoFlag: string | boolean | undefined,
  dailyFlag: string | boolean | undefined,
): number {
  const auto = onOff(autoFlag);
  const checkDaily = onOff(dailyFlag);
  if (auto === null || checkDaily === null) {
    console.error(
      `crank-mem: --auto and --check-daily take on or off\n${COMMANDS["self-update"].usage}`,
    );
    return 1;
  }
  const state = writeUpdateState({
    ...(auto === undefined ? {} : { auto }),
    ...(checkDaily === undefined ? {} : { checkDaily }),
  });
  console.log(
    `crank-mem: auto update ${state.auto ? "on" : "off"}, daily check ${state.checkDaily ? "on" : "off"}`,
  );
  return 0;
}

/** Runs `fn` under the tool lock, reporting a held lock or a throw as `what` failing. */
async function locked(what: string, fn: () => Promise<number>): Promise<number> {
  let result: number | "locked";
  try {
    result = await withToolLock(fn);
  } catch (err) {
    console.error(`crank-mem: could not ${what} (${errorMessage(err)})`);
    return 1;
  }
  if (result === "locked") {
    console.error(TOOL_BUSY);
    return 1;
  }
  return result;
}

export async function runRollback(_args: string[]): Promise<number> {
  return locked("roll back", rollback);
}

export async function runSelfUpdate(args: string[]): Promise<number> {
  const { usage, value } = COMMANDS["self-update"];
  const { flags } = parseArgs(args, value);
  const settings = flags.auto !== undefined || flags["check-daily"] !== undefined;
  const modes = [flags.to !== undefined, flags.check === true, settings].filter(Boolean).length;
  if (modes > 1) {
    console.error(`crank-mem: --to, --check and the settings flags run alone\n${usage}`);
    return 1;
  }
  if (flags.check) return check();
  if (settings) return saveSettings(flags.auto, flags["check-daily"]);
  const tag = stringFlag(flags.to);
  if (tag === null) {
    console.error(`crank-mem: --to needs a release tag, such as v1.2.3\n${usage}`);
    return 1;
  }
  return locked("update", () => update(tag ?? null));
}

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_FILE, CRANK_DIR, errorMessage } from "../hooks/lib/config.ts";
import { REGISTRY_FILE, registeredRoots } from "../hooks/lib/registry.ts";
import { DAEMON_FILE, daemonAlive, readDaemonState, spoolDir } from "../hooks/lib/spool.ts";
import { crankHome, SEEN_DIR, STOP_FILE } from "../hooks/lib/user-state.ts";
import { modelsDir } from "../daemon/embedder.ts";
import { RUN_DIR } from "../daemon/gateway.ts";
import { parseArgs, stringFlag } from "./args.ts";
import { COMMANDS } from "./commands.ts";
import { TOKEN_FILE } from "./dashboard.ts";
import { choose } from "./prompt.ts";
import { removePathBlocks } from "./shell-rc.ts";
import { TOOL_BUSY, TOOL_LOCK, withToolLock } from "./tool-install.ts";
import { CURRENT_LINK, REPO_ROOT, versionsDir } from "./version.ts";

// `crank-mem self-uninstall`: removes the installed copy (`versions/`, the
// `current` link, the bin link and the PATH block), optionally after
// uninstalling crank-mem from every registered project. This process runs
// from inside `versions/`, so every spawn happens before it goes.

type Options = { binDir: string; yes: boolean; purge: boolean };

/** What `--purge` removes: only the entries crank-mem writes, since another tool may share the crank home. */
function ownedEntries(): string[] {
  const home = crankHome();
  return [
    versionsDir(),
    ...[CURRENT_LINK, TOOL_LOCK, "update.json", REGISTRY_FILE, TOKEN_FILE, RUN_DIR].map((name) =>
      path.join(home, name),
    ),
    spoolDir(),
    path.join(home, SEEN_DIR),
    modelsDir(),
    ...[DAEMON_FILE, STOP_FILE].map((name) => path.join(home, name)),
  ];
}

/**
 * Signals the live daemon's process group: `ensureDaemon` starts it detached as its own group
 * leader and it has no SIGTERM handler, so the job it is running dies with it.
 */
function stopDaemon(): void {
  if (!daemonAlive()) return;
  const pid = readDaemonState()?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, "SIGTERM");
    console.log("crank-mem: stopped the daemon");
  } catch (err) {
    // ESRCH: it exited since its last heartbeat. Anything else (EPERM) must not stop the removal.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      console.error(`crank-mem: could not stop the daemon (pid ${pid}: ${errorMessage(err)})`);
    }
  }
}

/** Registered roots that still hold a crank-mem install. */
function wiredRoots(): string[] {
  return registeredRoots().filter((root) => fs.existsSync(path.join(root, CRANK_DIR, CONFIG_FILE)));
}

/** Uninstalls crank-mem from each wired project, or lists them; returns 1 when any uninstall failed. */
async function unwireProjects(yes: boolean): Promise<number> {
  const roots = wiredRoots();
  if (roots.length === 0) return 0;
  const answer = yes
    ? "yes"
    : await choose(
        "Uninstall crank-mem from every registered project too?",
        ["yes", "no"] as const,
        "no",
      );
  if (answer === "no") {
    console.log("crank-mem: these projects still run crank-mem's hooks:");
    for (const root of roots) console.log(`  ${root}`);
    return 0;
  }
  let status = 0;
  for (const root of roots) {
    console.log(`crank-mem: uninstalling from ${root}`);
    const result = spawnSync(path.join(REPO_ROOT, "bin/crank-mem"), ["uninstall", "--yes"], {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (result.status !== 0) {
      console.error(`crank-mem: could not uninstall from ${root}`);
      status = 1;
    }
  }
  return status;
}

/** Removes `<binDir>/crank-mem` when it is the link to `current`'s launcher. */
function unlinkBin(binDir: string): void {
  const link = path.join(binDir, "crank-mem");
  const target = path.join(crankHome(), CURRENT_LINK, "bin/crank-mem");
  let isOurs: boolean;
  try {
    isOurs = fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === target;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw err;
  }
  if (!isOurs) {
    console.log(`crank-mem: left ${link} (not crank-mem's link)`);
    return;
  }
  fs.rmSync(link);
  console.log(`crank-mem: removed ${link}`);
}

async function uninstall(opts: Options): Promise<number> {
  stopDaemon();
  const status = await unwireProjects(opts.yes);
  unlinkBin(opts.binDir);
  for (const file of removePathBlocks(os.homedir())) {
    console.log(`crank-mem: removed the PATH line from ${file}`);
  }
  fs.rmSync(path.join(crankHome(), CURRENT_LINK), { force: true });
  fs.rmSync(versionsDir(), { recursive: true, force: true });
  console.log("crank-mem: removed the installed crank-mem");
  if (opts.purge) {
    for (const entry of ownedEntries()) fs.rmSync(entry, { recursive: true, force: true });
    console.log(`crank-mem: removed crank-mem's state from ${crankHome()}`);
  }
  return status;
}

export async function run(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, COMMANDS["self-uninstall"].value);
  const binDir = stringFlag(flags["bin-dir"]);
  if (binDir === null) {
    console.error(`crank-mem: --bin-dir needs a directory\n${COMMANDS["self-uninstall"].usage}`);
    return 1;
  }
  let result: number | "locked";
  try {
    result = await withToolLock(() =>
      uninstall({
        binDir: path.resolve(binDir ?? path.join(os.homedir(), ".local/bin")),
        yes: flags.yes === true,
        purge: flags.purge === true,
      }),
    );
  } catch (err) {
    console.error(`crank-mem: could not remove crank-mem (${errorMessage(err)})`);
    return 1;
  }
  if (result === "locked") {
    console.error(TOOL_BUSY);
    return 1;
  }
  return result;
}

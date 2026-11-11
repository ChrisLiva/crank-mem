import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_FILE, CRANK_DIR, errorMessage, loadConfig } from "../hooks/lib/config.ts";
import { registeredRoots } from "../hooks/lib/registry.ts";
import { crankHome } from "../hooks/lib/user-state.ts";
import { parseArgs, positive, stringFlag } from "./args.ts";
import { COMMANDS } from "./commands.ts";
import { choose } from "./prompt.ts";
import { addPathBlock, rcTarget } from "./shell-rc.ts";
import { ensureModel } from "./setup.ts";
import { DEFAULT_BIN_DIR, linkBin, locked, makeCurrent, prepareVersion } from "./tool-install.ts";
import { repairAll } from "./upgrade.ts";
import { CURRENT_LINK, REPO_ROOT, versionAt } from "./version.ts";

// `crank-mem self-install`: install.sh runs it from the version it just
// unpacked. It installs that copy's packages, makes it `current`, links the
// command into the bin dir, downloads the search model, offers the PATH line
// and repoints projects that still run from another crank-mem (a clone).

type Options = { binDir: string; yes: boolean; host?: string; fetchTimeoutMs?: number };

/** Offers to add `binDir` to PATH in the shell's startup file when PATH lacks it. */
async function offerPath(binDir: string, yes: boolean): Promise<void> {
  const onPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((entry) => entry !== "" && path.resolve(entry) === binDir);
  if (onPath) return;
  const { file, line } = rcTarget(process.env.SHELL ?? "", process.platform, os.homedir());
  const text = line(binDir);
  const answer = yes
    ? "yes"
    : await choose(`Add ${binDir} to PATH in ${file}?`, ["yes", "no"] as const, "no");
  if (answer === "yes") {
    try {
      addPathBlock(file, text);
      console.log(`crank-mem: added ${binDir} to PATH in ${file}; open a new shell to use it`);
      return;
    } catch (err) {
      console.error(`crank-mem: could not write ${file} (${errorMessage(err)})`);
    }
  }
  console.log(`crank-mem: ${binDir} is not on your PATH; add this line to ${file}:\n  ${text}`);
}

/** Registered projects whose config records a tool root other than the stable `current` link. */
function projectsOffCurrent(): string[] {
  const current = path.join(crankHome(), CURRENT_LINK);
  return registeredRoots().filter((root) => {
    const crankDir = path.join(root, CRANK_DIR);
    return (
      fs.existsSync(path.join(crankDir, CONFIG_FILE)) && loadConfig(crankDir).clone_root !== current
    );
  });
}

/** Offers to repoint projects at `current`; an accepted offer repairs every registered project. */
async function offerRepoint(binDir: string, yes: boolean): Promise<number> {
  const stale = projectsOffCurrent();
  if (stale.length === 0) return 0;
  const count = stale.length === 1 ? "1 project runs" : `${stale.length} projects run`;
  const answer = yes
    ? "yes"
    : await choose(
        `${count} hooks from another crank-mem; repoint every registered project to this install?`,
        ["yes", "no"] as const,
        "no",
      );
  if (answer === "yes") return repairAll();
  const rerun =
    binDir === DEFAULT_BIN_DIR
      ? "crank-mem self-install --yes"
      : `crank-mem self-install --yes --bin-dir ${binDir}`;
  console.log(`crank-mem: ${count} hooks from another crank-mem:`);
  for (const root of stale) console.log(`  ${root}`);
  console.log(`crank-mem: to repoint them to this install, run \`${rerun}\``);
  return 0;
}

async function install(opts: Options): Promise<number> {
  const version = versionAt(REPO_ROOT);
  const prepared = prepareVersion(REPO_ROOT);
  if (!prepared.ok) {
    console.error(`crank-mem: could not install ${version} (${prepared.detail})`);
    return 1;
  }
  if (!makeCurrent(version)) return 1;

  let linked;
  try {
    linked = linkBin(opts.binDir);
  } catch (err) {
    console.error(`crank-mem: could not link crank-mem into ${opts.binDir} (${errorMessage(err)})`);
    return 1;
  }
  const command = path.join(opts.binDir, "crank-mem");
  if (linked.status === "blocked") {
    console.error(
      `crank-mem: ${linked.path} exists and is not a link; move it aside, or pass --bin-dir <dir>, then run install.sh again`,
    );
    return 1;
  }
  if (linked.status === "replaced") {
    console.log(`crank-mem: linked ${command} (it pointed at ${linked.previous})`);
  } else if (linked.status === "linked") {
    console.log(`crank-mem: linked ${command}`);
  }

  const model = await ensureModel({ host: opts.host, fetchTimeoutMs: opts.fetchTimeoutMs });
  if (!model.ok) {
    console.error(
      `crank-mem: could not download the search model (${model.detail}) — keyword search works; run \`crank-mem setup\` later to add search by meaning`,
    );
  } else if (model.downloaded) {
    console.log("crank-mem: downloaded the search model");
  }

  await offerPath(opts.binDir, opts.yes);
  return offerRepoint(opts.binDir, opts.yes);
}

export async function run(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, COMMANDS["self-install"].value);
  const binDir = stringFlag(flags["bin-dir"]);
  if (binDir === null) {
    console.error(`crank-mem: --bin-dir needs a directory\n${COMMANDS["self-install"].usage}`);
    return 1;
  }
  return locked("take the install lock", () =>
    install({
      binDir: path.resolve(binDir ?? DEFAULT_BIN_DIR),
      yes: flags.yes === true,
      host: stringFlag(flags["model-host"]) ?? undefined,
      fetchTimeoutMs: positive(flags["fetch-timeout-ms"], 0) || undefined,
    }),
  );
}

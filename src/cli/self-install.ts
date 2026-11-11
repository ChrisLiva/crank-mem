import * as os from "node:os";
import * as path from "node:path";
import { errorMessage } from "../hooks/lib/config.ts";
import { parseArgs, positive, stringFlag } from "./args.ts";
import { COMMANDS } from "./commands.ts";
import { ensureModel } from "./setup.ts";
import { activate, linkBin, prepareVersion, withToolLock } from "./tool-install.ts";
import { REPO_ROOT, versionAt } from "./version.ts";

// `crank-mem self-install`: install.sh runs it from the version it just
// unpacked. It installs that copy's packages, makes it `current`, links the
// command into the bin dir and downloads the search model.

type Options = { binDir: string; host?: string; fetchTimeoutMs?: number };

async function install(opts: Options): Promise<number> {
  const version = versionAt(REPO_ROOT);
  const prepared = prepareVersion(REPO_ROOT);
  if (!prepared.ok) {
    console.error(`crank-mem: could not install ${version} (${prepared.detail})`);
    return 1;
  }
  try {
    activate(version);
  } catch (err) {
    console.error(
      `crank-mem: could not make ${version} the current version (${errorMessage(err)})`,
    );
    return 1;
  }
  console.log(`crank-mem: ${version} is the current version`);

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
  return 0;
}

export async function run(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, COMMANDS["self-install"].value);
  const binDir = stringFlag(flags["bin-dir"]);
  if (binDir === null) {
    console.error(`crank-mem: --bin-dir needs a directory\n${COMMANDS["self-install"].usage}`);
    return 1;
  }
  let result: number | "locked";
  try {
    result = await withToolLock(() =>
      install({
        binDir: path.resolve(binDir ?? path.join(os.homedir(), ".local/bin")),
        host: stringFlag(flags["model-host"]) ?? undefined,
        fetchTimeoutMs: positive(flags["fetch-timeout-ms"], 0) || undefined,
      }),
    );
  } catch (err) {
    console.error(`crank-mem: could not take the install lock (${errorMessage(err)})`);
    return 1;
  }
  if (result === "locked") {
    console.error("crank-mem: another install or update is running");
    return 1;
  }
  return result;
}

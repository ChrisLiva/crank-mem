import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { errorMessage } from "../hooks/lib/config.ts";
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
import { cliVersion, CURRENT_LINK } from "./version.ts";

// `crank-mem self-update`: downloads the latest release (or `--to <tag>`),
// makes it `current`, prunes versions neither it nor this process nor a live
// daemon runs, then repairs every registered project from the new version.

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
  const prepared = prepareVersion(dir);
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
  console.log(`crank-mem: ${version} is the current version (was ${cliVersion()})`);
  try {
    for (const removed of pruneVersions([version, cliVersion()])) {
      console.log(`crank-mem: removed ${removed}`);
    }
  } catch (err) {
    console.error(`crank-mem: could not remove old versions (${errorMessage(err)})`);
  }
  return repairFromCurrent();
}

export async function runSelfUpdate(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, COMMANDS["self-update"].value);
  const tag = stringFlag(flags.to);
  if (tag === null) {
    console.error(
      `crank-mem: --to needs a release tag, such as v1.2.3\n${COMMANDS["self-update"].usage}`,
    );
    return 1;
  }
  let result: number | "locked";
  try {
    result = await withToolLock(() => update(tag ?? null));
  } catch (err) {
    console.error(`crank-mem: could not update (${errorMessage(err)})`);
    return 1;
  }
  if (result === "locked") {
    console.error(TOOL_BUSY);
    return 1;
  }
  return result;
}

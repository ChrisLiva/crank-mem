import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { embed, EMBED_MODEL, modelPresent, modelsDir } from "../daemon/embedder.ts";
import { ensureCrankHome } from "../hooks/lib/user-state.ts";
import { parseArgs } from "./args.ts";
import { REPO_ROOT } from "./version.ts";

// `crank-mem setup`: install the clone's packages and download the local
// search model into <crank home>/models.

export type InstallResult = { ok: true; tool: "bun" | "npm" } | { ok: false; detail: string };

function spawnTool(tool: "bun" | "npm", args: string[]): SpawnSyncReturns<string> {
  return spawnSync(tool, args, { cwd: REPO_ROOT, encoding: "utf-8" });
}

function isEnoent(r: SpawnSyncReturns<string>): boolean {
  return (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** bun from the lockfile; npm from the exact pin in package.json when bun is not on PATH, writing no package-lock.json. */
export function installPackages(): InstallResult {
  let tool: "bun" | "npm" = "bun";
  let r = spawnTool("bun", ["install", "--frozen-lockfile"]);
  if (isEnoent(r)) {
    tool = "npm";
    r = spawnTool("npm", ["install", "--ignore-scripts", "--no-package-lock"]);
  }
  if (!r.error && r.status === 0) return { ok: true, tool };
  const lastLine = (r.stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return { ok: false, detail: lastLine ?? r.error?.message ?? `${tool} exited ${r.status ?? r.signal}` };
}

export async function run(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, ["model-host", "fetch-timeout-ms"]);
  const host = typeof flags["model-host"] === "string" ? flags["model-host"] : undefined;
  const timeoutFlag = typeof flags["fetch-timeout-ms"] === "string" ? Number(flags["fetch-timeout-ms"]) : NaN;
  const fetchTimeoutMs = Number.isFinite(timeoutFlag) ? timeoutFlag : undefined;

  const installed = installPackages();
  if (!installed.ok) {
    console.error(`crank-mem: could not install packages (${installed.detail})`);
    return 1;
  }
  console.log(`crank-mem: installed packages with ${installed.tool}`);

  ensureCrankHome();
  const dir = modelsDir();
  if (modelPresent()) {
    console.log(`crank-mem: model already in ${dir}`);
    return 0;
  }
  try {
    await embed(["warm up"], { remote: true, host, fetchTimeoutMs });
  } catch (err) {
    console.error(`crank-mem: could not download the model (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }
  console.log(`crank-mem: downloaded ${EMBED_MODEL} to ${dir}`);
  return 0;
}

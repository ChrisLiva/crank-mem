import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { embed, EMBED_MODEL, modelPresent, modelsDir } from "../daemon/embedder.ts";
import { ensureCrankHome } from "../hooks/lib/user-state.ts";
import { parseArgs, positive } from "./args.ts";
import { COMMANDS } from "./commands.ts";
import { cliVersion, REPO_ROOT } from "./version.ts";

// `crank-mem setup`: install the clone's packages, build the dashboard and
// download the local search model into <crank home>/models.

/** The dashboard package, whose build `crank-mem dashboard` serves from `dist/`. */
export function dashboardDir(): string {
  return process.env.CRANK_DASHBOARD_DIR || path.join(REPO_ROOT, "dashboard");
}

/** True when `distDir` holds an `index.html` built for this clone's version. */
export function dashboardCurrent(distDir: string): boolean {
  if (!fs.existsSync(path.join(distDir, "index.html"))) return false;
  try {
    return fs.readFileSync(path.join(distDir, ".crank-version"), "utf-8").trim() === cliVersion();
  } catch {
    return false;
  }
}

export type InstallResult = { ok: true; tool: "bun" | "npm" } | { ok: false; detail: string };

function isEnoent(r: SpawnSyncReturns<string>): boolean {
  return (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Runs bun with `bunArgs` in `dir`, or npm with `npmArgs` when bun is not on PATH. */
function runTool(dir: string, bunArgs: string[], npmArgs: string[]): InstallResult {
  let tool: "bun" | "npm" = "bun";
  let r = spawnSync("bun", bunArgs, { cwd: dir, encoding: "utf-8" });
  if (isEnoent(r)) {
    tool = "npm";
    r = spawnSync("npm", npmArgs, { cwd: dir, encoding: "utf-8" });
  }
  if (!r.error && r.status === 0) return { ok: true, tool };
  const lastLine = (r.stderr ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return {
    ok: false,
    detail: lastLine ?? r.error?.message ?? `${tool} exited ${r.status ?? r.signal}`,
  };
}

/** bun from the lockfile; npm from the exact pins in package.json when bun is not on PATH, writing no package-lock.json. */
export function installPackages(dir: string): InstallResult {
  return runTool(
    dir,
    ["install", "--frozen-lockfile"],
    ["install", "--ignore-scripts", "--no-package-lock"],
  );
}

/** Builds the dashboard into `dist/` and stamps it with this clone's version. */
function buildDashboard(): InstallResult {
  const built = runTool(dashboardDir(), ["run", "build"], ["run", "build"]);
  if (!built.ok) return built;
  try {
    const dist = path.join(dashboardDir(), "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, ".crank-version"), cliVersion());
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  return built;
}

/**
 * Installs the dashboard's packages, then builds and stamps it. `error` is the
 * stderr line for the first failing step; the caller prints every line.
 */
export function setUpDashboard(): { installedWith: "bun" | "npm" | null; error: string | null } {
  const installed = installPackages(dashboardDir());
  if (!installed.ok) {
    return {
      installedWith: null,
      error: `crank-mem: could not install dashboard packages (${installed.detail})`,
    };
  }
  const built = buildDashboard();
  return {
    installedWith: installed.tool,
    error: built.ok ? null : `crank-mem: could not build the dashboard (${built.detail})`,
  };
}

export async function run(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, COMMANDS.setup.value);
  const host = typeof flags["model-host"] === "string" ? flags["model-host"] : undefined;
  const fetchTimeoutMs = positive(flags["fetch-timeout-ms"], 0) || undefined;

  const installed = installPackages(REPO_ROOT);
  if (!installed.ok) {
    console.error(`crank-mem: could not install packages (${installed.detail})`);
    return 1;
  }
  console.log(`crank-mem: installed packages with ${installed.tool}`);

  const dashboard = setUpDashboard();
  if (dashboard.installedWith) {
    console.log(`crank-mem: installed dashboard packages with ${dashboard.installedWith}`);
  }
  if (dashboard.error) {
    console.error(dashboard.error);
    return 1;
  }
  console.log("crank-mem: built the dashboard");

  ensureCrankHome();
  const dir = modelsDir();
  if (modelPresent()) {
    console.log(`crank-mem: model already in ${dir}`);
    return 0;
  }
  try {
    await embed(["warm up"], { remote: true, host, fetchTimeoutMs });
  } catch (err) {
    console.error(
      `crank-mem: could not download the model (${err instanceof Error ? err.message : String(err)})`,
    );
    return 1;
  }
  console.log(`crank-mem: downloaded ${EMBED_MODEL} to ${dir}`);
  return 0;
}

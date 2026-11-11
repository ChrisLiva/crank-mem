import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { embed, EMBED_MODEL, modelPresent, modelsDir } from "../daemon/embedder.ts";
import { errorMessage } from "../hooks/lib/config.ts";
import { ensureCrankHome } from "../hooks/lib/user-state.ts";
import { parseArgs, positive } from "./args.ts";
import { COMMANDS } from "./commands.ts";
import { cliVersion, installedCopy, REPO_ROOT } from "./version.ts";
import { printUpdateNotice } from "./updates.ts";

// `crank-mem setup`: install the tool's packages, build the dashboard (in a
// clone only: an installed copy ships its build) and download the local search
// model into <crank home>/models.

/** The dashboard package, whose build `crank-mem dashboard` serves from `dist/`. */
export function dashboardDir(): string {
  return process.env.CRANK_DASHBOARD_DIR || path.join(REPO_ROOT, "dashboard");
}

/** True when `distDir` holds an `index.html` stamped with `version`. */
export function dashboardCurrent(distDir: string, version: string): boolean {
  if (!fs.existsSync(path.join(distDir, "index.html"))) return false;
  try {
    return fs.readFileSync(path.join(distDir, ".crank-version"), "utf-8").trim() === version;
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

/**
 * bun from the lockfile; npm from the exact pins in package.json when bun is not on PATH, writing
 * no package-lock.json. `production` leaves out devDependencies.
 */
export function installPackages(dir: string, opts: { production?: boolean } = {}): InstallResult {
  return opts.production
    ? runTool(
        dir,
        ["install", "--production", "--frozen-lockfile"],
        ["install", "--omit=dev", "--ignore-scripts", "--no-package-lock"],
      )
    : runTool(
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
    return { ok: false, detail: errorMessage(err) };
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

/** Downloads the local search model into <crank home>/models unless it is already there. */
export async function ensureModel(opts: {
  host?: string;
  fetchTimeoutMs?: number;
}): Promise<{ ok: true; downloaded: boolean } | { ok: false; detail: string }> {
  ensureCrankHome();
  if (modelPresent()) return { ok: true, downloaded: false };
  try {
    await embed(["warm up"], {
      remote: true,
      host: opts.host,
      fetchTimeoutMs: opts.fetchTimeoutMs,
    });
  } catch (err) {
    return { ok: false, detail: errorMessage(err) };
  }
  return { ok: true, downloaded: true };
}

export async function run(args: string[]): Promise<number> {
  printUpdateNotice();
  const { flags } = parseArgs(args, COMMANDS.setup.value);
  const host = typeof flags["model-host"] === "string" ? flags["model-host"] : undefined;
  const fetchTimeoutMs = positive(flags["fetch-timeout-ms"], 0) || undefined;
  const fromInstalledCopy = installedCopy();

  const installed = installPackages(REPO_ROOT, { production: fromInstalledCopy });
  if (!installed.ok) {
    console.error(`crank-mem: could not install packages (${installed.detail})`);
    return 1;
  }
  console.log(`crank-mem: installed packages with ${installed.tool}`);

  if (!fromInstalledCopy) {
    const dashboard = setUpDashboard();
    if (dashboard.installedWith) {
      console.log(`crank-mem: installed dashboard packages with ${dashboard.installedWith}`);
    }
    if (dashboard.error) {
      console.error(dashboard.error);
      return 1;
    }
    console.log("crank-mem: built the dashboard");
  }

  const model = await ensureModel({ host, fetchTimeoutMs });
  if (!model.ok) {
    console.error(`crank-mem: could not download the model (${model.detail})`);
    return 1;
  }
  const dir = modelsDir();
  console.log(
    model.downloaded
      ? `crank-mem: downloaded ${EMBED_MODEL} to ${dir}`
      : `crank-mem: model already in ${dir}`,
  );
  return 0;
}

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { crankHome, ensureCrankHome, writeJsonAtomic } from "../hooks/lib/user-state.ts";
import { parseArgs, positive, stringFlag } from "./args.ts";
import { COMMANDS } from "./commands.ts";
import { serveDashboard } from "./dashboard-server.ts";
import { dashboardCurrent, dashboardDir } from "./setup.ts";
import { CHECK_EVERY_MS, printUpdateNotice } from "./updates.ts";
import { cliVersion } from "./version.ts";

// `crank-mem dashboard`: serve the built dashboard on 127.0.0.1 until a
// signal. Its only write is <crank home>/dashboard.json: the session token,
// and this process's pid and version, which keep its copy from being pruned.

export const TOKEN_FILE = "dashboard.json";
const TOKEN = /^[0-9a-f]{64}$/;

/** The --port value, the per-user default when absent, or null when it is not a port. */
function portFrom(value: string | boolean | undefined): number | null {
  const given = stringFlag(value);
  if (given === undefined) return 38700 + (process.getuid!() % 100);
  if (given === null || !/^\d+$/.test(given)) return null;
  const port = Number(given);
  return port <= 65535 ? port : null;
}

/** The stored token, or a fresh one written at mode 0600 when the file is missing or bad. */
function sessionToken(): string {
  const file = path.join(crankHome(), TOKEN_FILE);
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf-8"))?.token;
    if (typeof stored === "string" && TOKEN.test(stored)) return stored;
  } catch {
    // A missing or unparsable file gets a fresh token below.
  }
  const token = crypto.randomBytes(32).toString("hex");
  ensureCrankHome();
  writeJsonAtomic(file, { token }, { mode: 0o600 });
  return token;
}

/** The refusal for a port already taken: a dashboard answers 401 with its own body. */
async function inUseMessage(port: number): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    if (res.status === 401 && (await res.text()).includes("crank-mem dashboard")) {
      return `crank-mem: a dashboard already runs at http://127.0.0.1:${port}/`;
    }
  } catch {
    // No answer within the timeout: something other than a dashboard holds the port.
  }
  return `crank-mem: port ${port} is in use; pass --port <n>.`;
}

function openBrowser(url: string): void {
  try {
    const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is already on stdout; a browser that will not launch changes nothing.
  }
}

export async function run(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, COMMANDS.dashboard.value);
  const port = portFrom(flags.port);
  if (port === null) {
    console.error(COMMANDS.dashboard.usage);
    return 1;
  }
  const distDir = path.join(dashboardDir(), "dist");
  if (!dashboardCurrent(distDir, cliVersion())) {
    console.error("crank-mem: the dashboard is not built — run `crank-mem setup`.");
    return 1;
  }
  const token = sessionToken();

  let server: Awaited<ReturnType<typeof serveDashboard>>;
  try {
    const checkEveryMs = positive(flags["check-every-ms"], CHECK_EVERY_MS);
    server = await serveDashboard({ port, distDir, token, checkEveryMs });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.error(
      e.code === "EADDRINUSE"
        ? await inUseMessage(port)
        : `crank-mem: could not listen on port ${port} (${e.message})`,
    );
    return 1;
  }

  const tokenFile = path.join(crankHome(), TOKEN_FILE);
  writeJsonAtomic(tokenFile, { token, pid: process.pid, version: cliVersion() }, { mode: 0o600 });
  const url = `http://127.0.0.1:${server.port}/?token=${token}`;
  console.log(`crank-mem dashboard: ${url}`);
  printUpdateNotice();
  if (flags["no-open"] !== true) openBrowser(url);

  return new Promise((resolve) => {
    const stop = () => void server.close().then(() => resolve(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}

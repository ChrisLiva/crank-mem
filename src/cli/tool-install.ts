import * as fs from "node:fs";
import * as path from "node:path";
import { crankHome, ensureCrankHome } from "../hooks/lib/user-state.ts";
import { dashboardCurrent, installPackages } from "./setup.ts";
import { CURRENT_LINK, VERSIONS_DIR, versionAt } from "./version.ts";

// The steps that put an installed copy in use: the per-user tool lock, the
// copy's packages and dashboard check, the `current` link and the bin link.

/** The release tarball's file name on the release host. */
export const TARBALL = "crank-mem.tar.gz";
/** `<crank home>/tool.lock` holds the pid of the install or update in progress. */
export const TOOL_LOCK = "tool.lock";

/** True unless signalling `pid` reports no such process; EPERM means it lives under another user. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Creates the lock holding this pid; replaces a lock whose pid is dead or unreadable. */
function takeLock(file: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let holder = NaN;
    try {
      holder = Number(fs.readFileSync(file, "utf-8").trim());
    } catch {
      // Gone between the create and the read: the next attempt takes it.
    }
    if (pidAlive(holder)) return false;
    fs.rmSync(file, { force: true });
  }
  return false;
}

/** Runs `fn` holding `<crank home>/tool.lock`, or returns "locked" when a live process holds it. */
export async function withToolLock<T>(fn: () => Promise<T>): Promise<T | "locked"> {
  const file = path.join(ensureCrankHome(), TOOL_LOCK);
  if (!takeLock(file)) return "locked";
  try {
    return await fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Installs the copy's production packages and checks it ships a dashboard build for its version. */
export function prepareVersion(dir: string): { ok: true } | { ok: false; detail: string } {
  const installed = installPackages(dir, { production: true });
  if (!installed.ok) return installed;
  const version = versionAt(dir);
  if (!dashboardCurrent(path.join(dir, "dashboard/dist"), version)) {
    return {
      ok: false,
      detail: `the release's dashboard build is missing or not stamped ${version}`,
    };
  }
  return { ok: true };
}

/** Points `<crank home>/current` at `versions/<version>`; the rename means a reader never finds it missing. */
export function activate(version: string): void {
  const link = path.join(crankHome(), CURRENT_LINK);
  const tmp = `${link}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(path.join(VERSIONS_DIR, version), tmp);
  fs.renameSync(tmp, link);
}

export type LinkResult =
  | { status: "linked" | "unchanged" }
  | { status: "replaced"; previous: string }
  | { status: "blocked"; path: string };

/** Links `<binDir>/crank-mem` to the `current` launcher; a file there that is not a symlink is left alone. */
export function linkBin(binDir: string): LinkResult {
  const target = path.join(crankHome(), CURRENT_LINK, "bin/crank-mem");
  const link = path.join(binDir, "crank-mem");
  fs.mkdirSync(binDir, { recursive: true });
  let previous: string | null = null;
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return { status: "blocked", path: link };
    previous = fs.readlinkSync(link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (previous === target) return { status: "unchanged" };
  const tmp = `${link}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
  return previous === null ? { status: "linked" } : { status: "replaced", previous };
}

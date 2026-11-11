import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { errorMessage } from "../hooks/lib/config.ts";
import { daemonAlive, readDaemonState } from "../hooks/lib/spool.ts";
import { crankHome, ensureCrankHome } from "../hooks/lib/user-state.ts";
import { dashboardCurrent, installPackages } from "./setup.ts";
import { CURRENT_LINK, releaseBase, VERSIONS_DIR, versionAt, versionsDir } from "./version.ts";

// The steps that put an installed copy in use: the per-user tool lock, the
// release download, the copy's packages and dashboard check, the `current`
// link, the bin link and the pruning of versions no longer needed.

/** The release tarball's file name on the release host. */
export const TARBALL = "crank-mem.tar.gz";
/** `<crank home>/tool.lock` holds the pid of the install or update in progress. */
export const TOOL_LOCK = "tool.lock";
/** What a command prints when another process holds the tool lock. */
export const TOOL_BUSY = "crank-mem: another install or update is running";
/** Where `self-install` links the command and `self-uninstall` looks for it, unless `--bin-dir` says otherwise. */
export const DEFAULT_BIN_DIR = path.join(os.homedir(), ".local/bin");
/** A version usable as a dir name under `versions/`, the same test install.sh applies. */
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

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

/** Runs `fn` under the tool lock, reporting a held lock or a throw as `what` failing. */
export async function locked(what: string, fn: () => Promise<number>): Promise<number> {
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

/** Points `current` at `version` and says so, naming the version it replaced when given; false, after printing why, when it cannot. */
export function makeCurrent(version: string, was?: string): boolean {
  try {
    activate(version);
  } catch (err) {
    console.error(
      `crank-mem: could not make ${version} the current version (${errorMessage(err)})`,
    );
    return false;
  }
  console.log(`crank-mem: ${version} is the current version${was ? ` (was ${was})` : ""}`);
  return true;
}

/** The launcher reached through the `current` link, which the bin link points at. */
export function currentLauncher(): string {
  return path.join(crankHome(), CURRENT_LINK, "bin/crank-mem");
}

export type LinkResult =
  | { status: "linked" | "unchanged" }
  | { status: "replaced"; previous: string }
  | { status: "blocked"; path: string };

/** Links `<binDir>/crank-mem` to the `current` launcher; a file there that is not a symlink is left alone. */
export function linkBin(binDir: string): LinkResult {
  const target = currentLauncher();
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

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** The `version` in `<dir>/package.json` when it is a usable dir name, else null. */
function releaseVersion(dir: string): string | null {
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    return typeof version === "string" && VERSION_NAME.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Downloads the latest release, or the one `tag` names, checks it against its `.sha256`
 * and unpacks it into `versions/<version>`, keeping a version dir already there.
 * Install.sh's contract; a failure leaves `versions/` as it was.
 */
export async function fetchRelease(
  tag: string | null,
): Promise<{ ok: true; version: string; dir: string } | { ok: false; detail: string }> {
  const url =
    tag === null ? `${releaseBase()}/latest/download` : `${releaseBase()}/download/${tag}`;
  let incoming: string | null = null;
  try {
    const tarball = await download(`${url}/${TARBALL}`);
    const sums = (await download(`${url}/${TARBALL}.sha256`)).toString("utf-8");
    const expected = sums.split("\n")[0]!.trim().split(/\s+/)[0] ?? "";
    const actual = crypto.createHash("sha256").update(tarball).digest("hex");
    if (expected !== actual) {
      return {
        ok: false,
        detail: `checksum mismatch for ${url}/${TARBALL} (expected ${expected || "none"}, got ${actual}); nothing was installed`,
      };
    }
    fs.mkdirSync(versionsDir(), { recursive: true });
    incoming = fs.mkdtempSync(path.join(versionsDir(), ".incoming-"));
    const file = path.join(incoming, TARBALL);
    const release = path.join(incoming, "release");
    fs.writeFileSync(file, tarball);
    fs.mkdirSync(release);
    const untar = spawnSync("tar", ["-xzf", file, "-C", release], { encoding: "utf-8" });
    if (untar.status !== 0) {
      return {
        ok: false,
        detail: `could not extract ${TARBALL} (${untar.stderr.trim() || "tar failed"})`,
      };
    }
    const version = releaseVersion(release);
    if (version === null)
      return { ok: false, detail: "the release's package.json names no usable version" };
    const dir = path.join(versionsDir(), version);
    if (!fs.existsSync(dir)) fs.renameSync(release, dir);
    return { ok: true, version, dir };
  } catch (err) {
    return { ok: false, detail: errorMessage(err) };
  } finally {
    if (incoming !== null) fs.rmSync(incoming, { recursive: true, force: true });
  }
}

/**
 * Removes every `versions/<v>` not in `keep` and not the version a live daemon runs;
 * returns the removed versions. Dot entries, such as install.sh's downloads in progress, stay.
 */
export function pruneVersions(keep: string[]): string[] {
  const daemon = daemonAlive() ? readDaemonState()?.version : undefined;
  const kept = new Set(typeof daemon === "string" ? [...keep, daemon] : keep);
  let names: string[];
  try {
    names = fs.readdirSync(versionsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const removed = names.filter((name) => !name.startsWith(".") && !kept.has(name)).sort();
  for (const name of removed) {
    fs.rmSync(path.join(versionsDir(), name), { recursive: true, force: true });
  }
  return removed;
}

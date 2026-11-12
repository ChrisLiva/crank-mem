import * as path from "node:path";
import { CRANK_DIR, errorMessage, isObj, loadConfig, readJsonObject } from "../hooks/lib/config.ts";
import { installedRoots } from "../hooks/lib/registry.ts";
import { crankHome, writeJsonAtomic } from "../hooks/lib/user-state.ts";
import { cliVersion, currentVersion, installedCopy, newer, releaseBase } from "./version.ts";

// The release check's state in `<crank home>/update.json`: the user's settings
// (`checkDaily`, `auto`) and the last check's result.

export const UPDATE_FILE = "update.json";
export const CHECK_EVERY_MS = 86_400_000;

type Release = { version: string; tag: string; releasedAt: string };

export type UpdateState = {
  checkDaily: boolean;
  auto: boolean;
  latest: Release | null;
  checkedAtMs: number | null;
  error: string | null;
};

function updateFile(): string {
  return path.join(crankHome(), UPDATE_FILE);
}

/** A `{ version, tag, releasedAt }` of strings, else null. */
function asRelease(value: unknown): Release | null {
  if (!isObj(value)) return null;
  const { version, tag, releasedAt } = value;
  return typeof version === "string" && typeof tag === "string" && typeof releasedAt === "string"
    ? { version, tag, releasedAt }
    : null;
}

/** The recorded state; each missing or malformed field reads as its default. */
export function readUpdateState(): UpdateState {
  const raw = readJsonObject(updateFile()) ?? {};
  return {
    checkDaily: typeof raw.checkDaily === "boolean" ? raw.checkDaily : true,
    auto: typeof raw.auto === "boolean" ? raw.auto : false,
    latest: asRelease(raw.latest),
    checkedAtMs: Number.isFinite(raw.checkedAtMs) ? (raw.checkedAtMs as number) : null,
    error: typeof raw.error === "string" ? raw.error : null,
  };
}

export function writeUpdateState(patch: Partial<UpdateState>): UpdateState {
  const next = { ...readUpdateState(), ...patch };
  writeJsonAtomic(updateFile(), next);
  return next;
}

/** Fetches the latest release's `release.json` and records it, or records why it could not. */
export async function checkNow(timeoutMs = 10_000): Promise<UpdateState> {
  const url = `${releaseBase()}/latest/download/release.json`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": `crank-mem/${cliVersion()}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const latest = asRelease(await res.json());
    if (latest === null) throw new Error("names no release");
    return writeUpdateState({ latest, checkedAtMs: Date.now(), error: null });
  } catch (err) {
    return writeUpdateState({ checkedAtMs: Date.now(), error: `${url}: ${errorMessage(err)}` });
  }
}

/**
 * Checks now when `version`, just made current, is newer than the recorded latest release:
 * a release since the last check left the record, which the dashboard shows, behind it.
 */
export async function recheckIfBehind(version: string): Promise<void> {
  const { latest } = readUpdateState();
  if (latest !== null && newer(version, latest.version)) await checkNow();
}

/** True when an installed copy with daily checks on has not checked within `CHECK_EVERY_MS`. */
export function checkDue(state: UpdateState, nowMs: number): boolean {
  return (
    installedCopy() &&
    state.checkDaily &&
    !process.env.CRANK_NO_UPDATE_CHECK &&
    (state.checkedAtMs === null || nowMs - state.checkedAtMs >= CHECK_EVERY_MS)
  );
}

/**
 * The registered projects, in registry order, whose vendored hooks are older than `version`.
 * A root without `.crank/config.json` is left out: `upgrade --all` skips it as missing.
 */
export function laggingProjects(
  version: string,
): Array<{ root: string; name: string; vendored: string }> {
  return installedRoots().flatMap((root) => {
    const vendored = loadConfig(path.join(root, CRANK_DIR)).vendored_version;
    return newer(version, vendored) ? [{ root, name: path.basename(root), vendored }] : [];
  });
}

/** True when the running copy is installed and the last check found a newer release. */
export function updateAvailable(
  state: UpdateState,
): state is UpdateState & { latest: NonNullable<UpdateState["latest"]> } {
  return installedCopy() && state.latest !== null && newer(state.latest.version, currentVersion());
}

/** The line a human-run command prints when an update is available, else null. */
function updateNotice(): string | null {
  const state = readUpdateState();
  if (!updateAvailable(state)) return null;
  return `crank-mem ${state.latest.version} is available (installed ${currentVersion()}) — run \`crank-mem self-update\`.`;
}

export function printUpdateNotice(): void {
  const notice = updateNotice();
  if (notice !== null) process.stderr.write(notice + "\n");
}

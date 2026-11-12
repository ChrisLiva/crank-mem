import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_FILE, CRANK_DIR, errorMessage, loadConfig } from "../hooks/lib/config.ts";
import { registeredRoots } from "../hooks/lib/registry.ts";
import { crankHome, writeJsonAtomic } from "../hooks/lib/user-state.ts";
import { cliVersion, installedCopy, newer, releaseBase } from "./version.ts";

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
  if (typeof value !== "object" || value === null) return null;
  const { version, tag, releasedAt } = value as Record<string, unknown>;
  return typeof version === "string" && typeof tag === "string" && typeof releasedAt === "string"
    ? { version, tag, releasedAt }
    : null;
}

/** The recorded state; each missing or malformed field reads as its default. */
export function readUpdateState(): UpdateState {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(updateFile(), "utf-8"));
    if (typeof parsed === "object" && parsed !== null) raw = parsed;
  } catch {
    /* missing or unparsable: every field reads as its default */
  }
  return {
    checkDaily: typeof raw.checkDaily === "boolean" ? raw.checkDaily : true,
    auto: typeof raw.auto === "boolean" ? raw.auto : false,
    latest: asRelease(raw.latest),
    checkedAtMs: Number.isFinite(raw.checkedAtMs) ? (raw.checkedAtMs as number) : null,
    error: typeof raw.error === "string" ? raw.error : null,
  };
}

/** Merges `patch` into the recorded state and returns the result. */
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
  return registeredRoots().flatMap((root) => {
    const crankDir = path.join(root, CRANK_DIR);
    if (!fs.existsSync(path.join(crankDir, CONFIG_FILE))) return [];
    const vendored = loadConfig(crankDir).vendored_version;
    return newer(version, vendored) ? [{ root, name: path.basename(root), vendored }] : [];
  });
}

/** True when the running copy is installed and the last check found a newer release. */
export function updateAvailable(
  state: UpdateState,
): state is UpdateState & { latest: NonNullable<UpdateState["latest"]> } {
  return installedCopy() && state.latest !== null && newer(state.latest.version, cliVersion());
}

/** The line a human-run command prints when an update is available, else null. */
function updateNotice(): string | null {
  const state = readUpdateState();
  if (!updateAvailable(state)) return null;
  return `crank-mem ${state.latest.version} is available (installed ${cliVersion()}) — run \`crank-mem self-update\`.`;
}

/** Writes `updateNotice()` to stderr when there is one. */
export function printUpdateNotice(): void {
  const notice = updateNotice();
  if (notice !== null) process.stderr.write(notice + "\n");
}

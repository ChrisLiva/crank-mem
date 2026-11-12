import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonObject } from "../hooks/lib/config.ts";
import { crankHome } from "../hooks/lib/user-state.ts";

/** Absolute path to the running crank-mem copy (repo root), symlinks resolved. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `<crank home>/versions/<version>` holds each installed copy. */
export const VERSIONS_DIR = "versions";
/** `<crank home>/current` links to the installed copy in use. */
export const CURRENT_LINK = "current";

/** The version in `<root>/package.json`, "0.0.0" on any read or parse failure. */
export function versionAt(root: string): string {
  const version = readJsonObject(path.join(root, "package.json"))?.version;
  return typeof version === "string" ? version : "0.0.0";
}

/** Version of the running copy, from package.json. */
export function cliVersion(): string {
  return versionAt(REPO_ROOT);
}

export function versionsDir(): string {
  return path.join(crankHome(), VERSIONS_DIR);
}

/** True when the running copy is a version under `<crank home>/versions/`. */
export function installedCopy(): boolean {
  try {
    return path.dirname(REPO_ROOT) === fs.realpathSync(versionsDir());
  } catch {
    return false;
  }
}

/**
 * The version in use: the `current` copy's for an installed copy, which a long-running
 * process such as the dashboard may have been updated past, else the running clone's.
 */
export function currentVersion(): string {
  if (!installedCopy()) return cliVersion();
  const version = readJsonObject(path.join(crankHome(), CURRENT_LINK, "package.json"))?.version;
  return typeof version === "string" ? version : cliVersion();
}

/** The root to record and start from: the stable `current` link for an installed copy, else the clone. */
export function toolRoot(): string {
  return installedCopy() ? path.join(crankHome(), CURRENT_LINK) : REPO_ROOT;
}

/** The release host's base URL: `CRANK_RELEASE_URL` when set, trailing `/` trimmed. */
export function releaseBase(): string {
  return (
    process.env.CRANK_RELEASE_URL || "https://github.com/ChrisLiva/crank-mem/releases"
  ).replace(/\/+$/, "");
}

/** True when version `a` is above `b`, compared as numeric `x.y.z`; a missing or non-numeric part reads as 0. */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

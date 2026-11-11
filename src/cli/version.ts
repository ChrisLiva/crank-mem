import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { crankHome } from "../hooks/lib/user-state.ts";

/** Absolute path to the running crank-mem copy (repo root), symlinks resolved. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `<crank home>/versions/<version>` holds each installed copy. */
export const VERSIONS_DIR = "versions";
/** `<crank home>/current` links to the installed copy in use. */
export const CURRENT_LINK = "current";

/** The version in `<root>/package.json`, "0.0.0" on any read or parse failure. */
export function versionAt(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
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

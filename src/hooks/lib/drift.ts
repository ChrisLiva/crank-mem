import * as fs from "node:fs";
import * as path from "node:path";
import type { CrankConfig } from "./config.ts";

// Vendored-hook drift: the hooks under .crank/hooks/ are a copy of the
// src/hooks/ of the crank-mem that installed them (a clone or an installed
// copy's `current`), so a crank-mem that has moved on leaves the project
// running old code with nothing to say so.
//
// Warn only — never re-vendor. A hook that swapped its own files mid-session
// would be mutating the project from inside an advisory-only path.
//
// `clone_root`, the dir of the crank-mem that installed the hooks, comes from
// config.json and is read with `fs`, not imported, so the "hooks import
// nothing outside src/hooks/" vendoring invariant holds.

/**
 * One line naming both versions and the fix, or null when there is nothing to
 * say. Every failure mode — no `clone_root` (an install predating the field),
 * a `clone_root` that was moved or deleted, an unreadable or malformed package.json,
 * a missing `version` — returns null: drift reporting is a convenience, and a
 * hook that cannot read `clone_root` still has a working project memory.
 */
export function driftNote(config: CrankConfig): string | null {
  if (!config.clone_root) return null;
  let toolVersion: unknown;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(config.clone_root, "package.json"), "utf-8"));
    toolVersion = pkg?.version;
  } catch {
    return null;
  }
  if (typeof toolVersion !== "string" || !toolVersion) return null;
  if (toolVersion === config.vendored_version) return null;
  return (
    `crank-mem hooks are at ${config.vendored_version}, crank-mem is at ${toolVersion} — ` +
    "run `crank-mem upgrade`."
  );
}

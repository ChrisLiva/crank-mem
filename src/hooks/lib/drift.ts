import * as fs from "node:fs";
import * as path from "node:path";
import type { CrankConfig } from "./config.ts";

// Vendored-hook drift: the hooks under .crank/hooks/ are a copy of the clone's
// src/hooks/, so a clone that has moved on leaves the project running old code
// with nothing to say so. One real install ran 15 sessions on a truncating
// injection after the fix had already landed in the clone.
//
// Warn only — never re-vendor. A hook that swapped its own files mid-session
// would be mutating the project from inside an advisory-only path.
//
// `clone_root` comes from config.json and is read with `fs`, not imported, so
// the "hooks import nothing outside src/hooks/" vendoring invariant holds.

/**
 * One line naming both versions and the fix, or null when there is nothing to
 * say. Every failure mode — no `clone_root` (an install predating the field),
 * a clone that was moved or deleted, an unreadable or malformed package.json,
 * a missing `version` — returns null: drift reporting is a convenience, and a
 * hook that cannot read the clone still has a working project memory.
 */
export function driftNote(config: CrankConfig): string | null {
  if (!config.clone_root) return null;
  let cloneVersion: unknown;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(config.clone_root, "package.json"), "utf-8"));
    cloneVersion = pkg?.version;
  } catch {
    return null;
  }
  if (typeof cloneVersion !== "string" || !cloneVersion) return null;
  if (cloneVersion === config.vendored_version) return null;
  return (
    `crank-mem hooks are at ${config.vendored_version}, clone is at ${cloneVersion} — ` +
    "run `crank-mem upgrade`."
  );
}

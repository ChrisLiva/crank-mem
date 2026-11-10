import * as fs from "node:fs";
import * as path from "node:path";
import { crankHome, ensureCrankHome, writeJsonAtomic } from "../hooks/lib/user-state.ts";

// The per-user list of project roots that `init` and `upgrade` add and
// `uninstall` removes, kept at <crank home>/projects.json for the dashboard.
// A registry that cannot be read or written never changes a command's outcome.

const REGISTRY_FILE = "projects.json";

type Entry = { root: string; addedAtMs: number };

/** The listed entries; a missing or malformed file reads as none. */
function readEntries(): Entry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(crankHome(), REGISTRY_FILE), "utf-8"));
    if (!Array.isArray(parsed?.projects)) return [];
    return parsed.projects.filter(
      (e: unknown): e is Entry =>
        typeof (e as Entry)?.root === "string" && typeof (e as Entry)?.addedAtMs === "number",
    );
  } catch {
    return [];
  }
}

function writeEntries(projects: Entry[]): void {
  writeJsonAtomic(path.join(ensureCrankHome(), REGISTRY_FILE), { version: 1, projects });
}

export function registerProject(root: string): void {
  try {
    const entries = readEntries();
    if (entries.some((e) => e.root === root)) return;
    writeEntries([...entries, { root, addedAtMs: Date.now() }]);
  } catch {
    // An unwritable crank home loses the entry; the next init or upgrade adds it.
  }
}

export function unregisterProject(root: string): void {
  try {
    const entries = readEntries();
    const kept = entries.filter((e) => e.root !== root);
    if (kept.length !== entries.length) writeEntries(kept);
  } catch {
    // A failed write leaves the root listed until its .crank/config.json is gone
    // or a later uninstall of it writes the registry.
  }
}

export function registeredRoots(): string[] {
  return readEntries().map((e) => e.root);
}

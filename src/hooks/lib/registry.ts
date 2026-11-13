import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_FILE, CRANK_DIR, readJsonObject } from "./config.ts";
import { memoryPath } from "./memory.ts";
import { projectName } from "./owner.ts";
import { crankHome, ensureCrankHome, writeJsonAtomic } from "./user-state.ts";

// The per-user list of project roots, kept at <crank home>/projects.json.
// `init`, `upgrade` and the session-start hook add a root and `uninstall`
// removes it; the dashboard, `upgrade --all`, `self-install`,
// `self-uninstall`, `self-update` and the daemon read it.
// A registry that cannot be read or written never changes a command's outcome.

export const REGISTRY_FILE = "projects.json";

type Entry = { root: string; addedAtMs: number };

/** The listed entries; a missing or malformed file reads as none. */
function readEntries(): Entry[] {
  const projects = readJsonObject(path.join(crankHome(), REGISTRY_FILE))?.projects;
  if (!Array.isArray(projects)) return [];
  return projects.filter(
    (e: unknown): e is Entry =>
      typeof (e as Entry)?.root === "string" && typeof (e as Entry)?.addedAtMs === "number",
  );
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
    // An unwritable crank home loses the entry; the next session, init or upgrade adds it.
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

function isInstalled(root: string): boolean {
  return fs.existsSync(path.join(root, CRANK_DIR, CONFIG_FILE));
}

/** The registered roots that still hold a crank-mem install (`.crank/config.json`). */
export function installedRoots(): string[] {
  return registeredRoots().filter(isInstalled);
}

type Store = { root: string; storeDir: string; addedAtMs: number };

/**
 * One entry per distinct store over the installed roots: a linked worktree and its main checkout
 * share one, listed under the main checkout and dated by the newest registration among them.
 */
export function installedStores(): Store[] {
  const byDir = new Map<string, Store>();
  for (const e of readEntries().filter((e) => isInstalled(e.root))) {
    const storeDir = path.dirname(memoryPath(e.root));
    const seen = byDir.get(storeDir);
    const addedAtMs = Math.max(e.addedAtMs, seen?.addedAtMs ?? -Infinity);
    byDir.set(storeDir, { root: path.dirname(storeDir), storeDir, addedAtMs });
  }
  return [...byDir.values()];
}

/** The root of the store named `name` (`owner.ts` → `projectName`), the newest among several; else null. */
export function rootOfName(name: string): string | null {
  let best: Store | null = null;
  for (const s of installedStores()) {
    if (projectName(s.root) !== name) continue;
    if (best === null || s.addedAtMs > best.addedAtMs) best = s;
  }
  return best?.root ?? null;
}

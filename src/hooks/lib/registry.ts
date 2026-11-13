import * as path from "node:path";
import { readJsonObject } from "./config.ts";
import { memoryPath, type MemoryReader } from "./memory.ts";
import { isInstalled, projectName } from "./owner.ts";
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

/** Each installed store's roots by its name (`owner.ts` → `projectName`), newest first. */
function rootsByName(): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  const newestFirst = installedStores().sort((a, b) => b.addedAtMs - a.addedAtMs);
  for (const s of newestFirst) {
    const name = projectName(s.root);
    byName.set(name, [...(byName.get(name) ?? []), s.root]);
  }
  return byName;
}

/** The roots of the stores named `name`, newest first. */
export function rootsOfName(name: string): string[] {
  return rootsByName().get(name) ?? [];
}

/** The root of the store named `name`, the newest among several; else null. */
export function rootOfName(name: string): string | null {
  return rootsOfName(name)[0] ?? null;
}

/** `root`'s name (`owner.ts` → `projectName`), or the first `<name>-2`, `<name>-3`, … no other installed store has. */
export function unusedName(root: string): string {
  const name = projectName(root);
  const others = installedStores().filter((s) => s.root !== root);
  const taken = new Set(others.map((s) => projectName(s.root)));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name}-${n}`)) n++;
  return `${name}-${n}`;
}

/** The store's linked projects (`Memory` → `links`, sorted by name) that resolve to an installed root. */
export function linkedProjects(memory: MemoryReader): { name: string; root: string }[] {
  const names = memory.links();
  if (names.length === 0) return [];
  const roots = rootsByName();
  return names.flatMap((name) => {
    const root = roots.get(name)?.[0];
    return root === undefined ? [] : [{ name, root }];
  });
}

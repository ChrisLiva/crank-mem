import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, CRANK_DIR, type CrankConfig } from "../hooks/lib/config.ts";
import { findProjectRoot } from "../hooks/lib/hook-io.ts";
import type { StoreMigration } from "../hooks/lib/memory.ts";

// Shared "is crank-mem initialized here?" guard for CLI commands.

const NOT_INITIALIZED = "crank-mem: not initialized here — run `crank-mem init` first.";

export interface OpenedProject {
  root: string;
  crankDir: string;
  config: CrankConfig;
}

/** Open the current directory as an initialized project, or print the standard hint and return null. */
export function openProject(): OpenedProject | null {
  const root = process.cwd();
  const crankDir = path.join(root, CRANK_DIR);
  if (!fs.existsSync(path.join(crankDir, "config.json"))) {
    if (fs.existsSync(path.join(root, "crank", "config.json"))) {
      console.error("crank-mem: found a legacy crank/ install — this version uses .crank/.");
      console.error("Run `crank-mem uninstall` to remove it, then `crank-mem init` again.");
    } else {
      console.error(NOT_INITIALIZED);
    }
    return null;
  }
  return { root, crankDir, config: loadConfig(crankDir) };
}

/** Open the nearest initialized project at or above the current directory, or print the hint and return null. */
export function openNearestProject(): OpenedProject | null {
  const root = findProjectRoot(process.cwd());
  if (root === null) {
    console.error(NOT_INITIALIZED);
    return null;
  }
  const crankDir = path.join(root, CRANK_DIR);
  return { root, crankDir, config: loadConfig(crankDir) };
}

/** Prints a migration's one line: the version step on stdout, a failure on stderr, nothing otherwise. */
export function reportMigration(m: StoreMigration): void {
  if (m.status === "migrated" && m.from > 0)
    console.log(`  migrated memory.db v${m.from} → v${m.to}`);
  else if (m.status === "failed")
    console.error(`crank-mem: could not migrate memory.db (${m.detail})`);
}

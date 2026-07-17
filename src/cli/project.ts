import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, CRANK_DIR, type CrankConfig } from "../hooks/lib/config.ts";

// Shared "is crank-mem initialized here?" guard for CLI commands.

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
    console.error("crank-mem: not initialized here — run `crank-mem init` first.");
    return null;
  }
  return { root, crankDir, config: loadConfig(crankDir) };
}

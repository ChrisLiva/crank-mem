import { openProject } from "./project.ts";
import { fullScan } from "../hooks/lib/scanner.ts";
import { commitIndex } from "../hooks/lib/store.ts";
import { CLI_LOCK_BUDGET_MS } from "../hooks/lib/lock.ts";

export async function run(_args: string[]): Promise<number> {
  const project = openProject();
  if (!project) return 1;
  const { root, crankDir, config } = project;
  const index = commitIndex(crankDir, CLI_LOCK_BUDGET_MS, (current) =>
    fullScan(root, config, current),
  );
  if (index === null) {
    console.error(
      "crank-mem: could not acquire the index lock (another writer active) — try again.",
    );
    return 1;
  }
  console.log(scanCompleteLine(index.meta.fileCount));
  return 0;
}

/** The line a finished full scan prints, from `scan` and from `upgrade`. */
export function scanCompleteLine(fileCount: number): string {
  return `crank-mem: full scan complete — ${fileCount} files indexed → .crank/anatomy.md`;
}

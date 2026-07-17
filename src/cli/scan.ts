import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, CRANK_DIR } from "../hooks/lib/config.ts";
import { fullScan } from "../hooks/lib/scanner.ts";
import { saveIndex, saveAnatomyMd } from "../hooks/lib/store.ts";
import { withLock, CLI_LOCK_BUDGET_MS } from "../hooks/lib/lock.ts";

export async function run(_args: string[]): Promise<number> {
  const root = process.cwd();
  const crankDir = path.join(root, CRANK_DIR);
  if (!fs.existsSync(path.join(crankDir, "config.json"))) {
    console.error("crank-mem: not initialized here — run `crank-mem init` first.");
    return 1;
  }
  const config = loadConfig(crankDir);
  const count = withLock(crankDir, CLI_LOCK_BUDGET_MS, () => {
    const index = fullScan(root, config);
    saveIndex(crankDir, index);
    saveAnatomyMd(crankDir, index);
    return index.meta.fileCount;
  });
  if (count === null) {
    console.error("crank-mem: could not acquire the index lock (another writer active) — try again.");
    return 1;
  }
  console.log(`crank-mem: full scan complete — ${count} files indexed → crank/anatomy.md`);
  return 0;
}

import * as path from "node:path";
import { memoryPath, restoreMemory } from "../hooks/lib/memory.ts";
import { latestSnapshot, snapshotDir } from "../hooks/lib/store-upkeep.ts";
import { openNearestProject } from "./project.ts";
import { migrateStore } from "./upgrade.ts";

// Puts a memory.db snapshot back: the named file, or the newest snapshot.
// The current store is saved as a snapshot first, so a restore can be undone.

export async function run(args: string[]): Promise<number> {
  const project = openNearestProject();
  if (project === null) return 1;
  const store = memoryPath(project.root);
  const source =
    args[0] !== undefined ? path.resolve(process.cwd(), args[0]) : latestSnapshot(store)?.file;
  if (source === undefined) {
    console.error(`crank-mem: no snapshot in ${snapshotDir(store)}.`);
    return 1;
  }
  let result: Awaited<ReturnType<typeof restoreMemory>>;
  try {
    result = await restoreMemory(store, source);
  } catch (err) {
    console.error(
      `crank-mem: cannot restore: ${err instanceof Error ? err.message : String(err)}.`,
    );
    return 1;
  }
  if (result.status !== "restored") {
    console.error(
      result.status === "invalid"
        ? `crank-mem: cannot restore from ${source}: ${result.detail}`
        : `crank-mem: cannot restore: ${result.detail}.`,
    );
    return 1;
  }
  console.log(`restored memory.db from ${source}`);
  if (result.savedAs !== null) console.log(`  the previous store is at ${result.savedAs}`);
  migrateStore(store);
  return 0;
}

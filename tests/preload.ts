import { afterAll } from "bun:test";
import * as fs from "node:fs";
import { TEST_ROOT, killDaemon } from "./helpers.ts";

// bun runs this afterAll once per file under --parallel and once per run serially, so the root lives that long.
// A hook that finds a file awaiting a parse starts a daemon under this CRANK_HOME; it ends with the run.
afterAll(() => {
  killDaemon(process.env.CRANK_HOME!);
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

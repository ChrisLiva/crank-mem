import { afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { killDaemon } from "./helpers.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-test-"));
process.env.TMPDIR = root;
process.env.CRANK_HOME = fs.mkdtempSync(path.join(root, "crank-home-"));
process.env.CODEX_HOME = fs.mkdtempSync(path.join(root, "crank-codexhome-"));

// bun runs this afterAll once per file under --parallel and once per run serially, so the root lives that long.
// A hook that finds a file awaiting a parse starts a daemon under this CRANK_HOME; it ends with the run.
afterAll(() => {
  killDaemon(process.env.CRANK_HOME!);
  fs.rmSync(root, { recursive: true, force: true });
});

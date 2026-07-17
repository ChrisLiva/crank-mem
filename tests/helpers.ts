import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** Create a temp project with crank/ initialized and some source files. */
export function makeCrankProject(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-proj-"));
  fs.mkdirSync(path.join(root, "crank"), { recursive: true });
  saveConfig(path.join(root, "crank"), defaultConfig());
  fs.copyFileSync(
    path.join(REPO_ROOT, "src/templates/cerebrum.md"),
    path.join(root, "crank/cerebrum.md")
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

export interface HookRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run a hook script as a child process with the given stdin, like an agent would. */
export function runHook(script: string, stdin: string, cwd?: string): HookRun {
  const result = spawnSync("bun", [path.join(REPO_ROOT, script)], {
    input: stdin,
    encoding: "utf-8",
    cwd: cwd ?? os.tmpdir(),
    timeout: 15_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type * as sqlite from "node:sqlite";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { memoryPath, openMemory, type NewObservation } from "../src/hooks/lib/memory.ts";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** Create a temp project with .crank/ initialized and some source files. */
export function makeCrankProject(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-proj-"));
  fs.mkdirSync(path.join(root, ".crank"), { recursive: true });
  saveConfig(path.join(root, ".crank"), defaultConfig());
  fs.copyFileSync(
    path.join(REPO_ROOT, "src/templates/cerebrum.md"),
    path.join(root, ".crank/cerebrum.md")
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

/** Run git in `root`, throwing on failure; `git(root, "init", "-q")` makes it a repo. */
export function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** Stage everything in `root` and commit it as a fixed test identity, unsigned. */
export function gitCommit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", message);
}

export interface HookRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run a hook script as a child process with the given stdin, like an agent would. */
export function runHook(
  script: string,
  stdin: string,
  cwd?: string,
  env?: Record<string, string>
): HookRun {
  const result = spawnSync("bun", [path.join(REPO_ROOT, script)], {
    input: stdin,
    encoding: "utf-8",
    cwd: cwd ?? os.tmpdir(),
    timeout: 15_000,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

export type CliRun = HookRun;

/** A fresh empty temp directory to stand in for `~/.crank` in a child process. */
export function makeCrankHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crank-home-"));
}

/** Run the crank-mem CLI as a child process, with fresh temp CODEX_HOME and CRANK_HOME unless `env` overrides them. */
export function runCli(cwd: string, args: string[], env?: Record<string, string>): CliRun {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "src/cli/main.ts"), ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      ...process.env,
      CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "crank-codexhome-")),
      CRANK_HOME: makeCrankHome(),
      ...env,
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Set a file's atime and mtime to `ms` since the epoch. */
export function setMtime(p: string, ms: number): void {
  fs.utimesSync(p, new Date(ms), new Date(ms));
}

/** Turn on .crank/debug.log for a temp project. */
export function enableDebugConfig(root: string): void {
  const crankDir = path.join(root, ".crank");
  saveConfig(crankDir, { ...defaultConfig(), debug: true });
}

/** Parsed .crank/debug.log records, oldest first ([] when the log is absent). */
export function readDebugLog(root: string): Array<Record<string, any>> {
  try {
    return fs
      .readFileSync(path.join(root, ".crank/debug.log"), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

let seedCount = 0;

/** Append one digest of `observations` to the project's store and return their ids in input order. */
export function seedMemory(
  root: string,
  observations: Partial<NewObservation>[],
  opts: { costUsd?: number; nextSteps?: string } = {}
): number[] {
  const n = ++seedCount;
  const opened = openMemory(memoryPath(root), "write");
  if (opened.status !== "open") throw new Error(`seedMemory: store is ${opened.status}`);
  const memory = opened.memory;
  try {
    const before = memory.stats("seed", 0).observations;
    memory.appendDigest({
      session: { id: `seed-${n}`, agent: "claude", transcriptPath: `/seed/seed-${n}.jsonl` },
      expected: null,
      next: { uuid: `seed-${n}`, timestamp: new Date().toISOString() },
      model: "seed",
      costUsd: opts.costUsd ?? 0,
      summary: { request: "s", investigated: "s", learned: "s", completed: "s", next_steps: opts.nextSteps ?? "none" },
      observations: observations.map((o, i) => ({
        type: o.type ?? "discovery",
        title: o.title ?? `Observation ${i}`,
        narrative: o.narrative ?? `Narrative ${i}`,
        facts: o.facts ?? [],
        filesRead: o.filesRead ?? [],
        filesModified: o.filesModified ?? [],
      })),
    });
    const after = memory.stats("seed", 0).observations;
    if (after - before !== observations.length) {
      throw new Error(`seedMemory: stored ${after - before} of ${observations.length} observations`);
    }
    return memory.recent(observations.length).map((line) => line.id).reverse();
  } finally {
    memory.close();
  }
}

/** Write the project's store in one bad state: a newer schema, or a file that is not a database. */
export function plantMemory(root: string, state: "newer" | "unreadable"): void {
  const file = memoryPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (state === "unreadable") {
    fs.writeFileSync(file, "not a database");
    return;
  }
  const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite;
  const db = new mod.DatabaseSync(file);
  db.exec("PRAGMA user_version = 2");
  db.close();
}

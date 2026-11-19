import { expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type * as sqlite from "node:sqlite";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { openCodeDb } from "../src/hooks/lib/code-db.ts";
import {
  memoryPath,
  openMemory,
  openStoreForWrite,
  type DigestInput,
  type Memory,
  type NewObservation,
  type Position,
} from "../src/hooks/lib/memory.ts";
import { SCHEMA_VERSION } from "../src/hooks/lib/memory-schema.ts";
import { DAEMON_FILE, type DaemonState, type SpoolEntry } from "../src/hooks/lib/spool.ts";
import { STOP_FILE } from "../src/hooks/lib/user-state.ts";
import { EMBED_MODEL } from "../src/daemon/embedder.ts";
import { cliVersion } from "../src/cli/version.ts";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** The permissions.allow rules `crank-mem init` writes, in order: the hand-written oracle for `CRANK_ALLOW_RULES`. */
export const ALLOW_RULES = [
  "Bash(crank-mem search *)",
  "Bash(crank-mem timeline *)",
  "Bash(crank-mem get *)",
  "Bash(crank-mem outline *)",
  "Bash(crank-mem unfold *)",
  "Bash(crank-mem callers *)",
  "Bash(crank-mem callees *)",
  "Bash(crank-mem impact *)",
  "Bash(crank-mem anatomy *)",
];

// Every child that inherits process.env checks for a release against a closed local port, never
// GitHub, unless its test passes a release server.
process.env.CRANK_RELEASE_URL ??= "http://127.0.0.1:9";

/** Writes each `files` entry under `root`, creating its parent directories. */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

export function makeCrankProject(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-proj-"));
  fs.mkdirSync(path.join(root, ".crank"), { recursive: true });
  saveConfig(path.join(root, ".crank"), defaultConfig());
  fs.copyFileSync(
    path.join(REPO_ROOT, "src/templates/cerebrum.md"),
    path.join(root, ".crank/cerebrum.md"),
  );
  writeFiles(root, files);
  return root;
}

/** Fills and fully parses `root`'s `code.db` through `crank-mem anatomy`. */
export function buildGraph(root: string): void {
  const run = runCli(root, ["anatomy"]);
  if (run.status !== 0 || run.stdout.includes("still pending parse")) {
    throw new Error(`anatomy did not build the graph: ${run.stderr}${run.stdout}`);
  }
}

/** A crank project holding `files`, graph built. */
export function graphProject(files: Record<string, string>): string {
  const root = makeCrankProject(files);
  buildGraph(root);
  return root;
}

export function makeProject(extra: Record<string, string> = {}): {
  root: string;
  codexHome: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-init-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "crank-codexhome-"));
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.6"\n');
  fs.writeFileSync(path.join(root, "app.ts"), "/** The app. */\nexport const app = 1;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Test project\n");
  writeFiles(root, extra);
  spawnSync("git", ["init", "-q"], { cwd: root });
  return { root, codexHome };
}

export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      const rel = path.relative(root, full);
      if (rel === ".git" || rel === ".crank") continue;
      if (item.isDirectory()) walk(full);
      else out[rel] = fs.readFileSync(full, "utf-8");
    }
  };
  walk(root);
  return out;
}

/** Run git in `root`, throwing on failure; `git(root, "init", "-q")` makes it a repo. */
export function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

export function gitCommit(root: string, message: string): void {
  git(root, "add", "-A");
  git(
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    message,
  );
}

export interface HookRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** `TZ` as the test process started, before an in-process zone test sets it to "UTC". */
const STARTED_TZ = process.env.TZ;

/**
 * `process.env` plus `extra`, for a child process. When the test process started without `TZ`,
 * the child gets none unless `extra` names one, so it runs in the system zone after an
 * in-process zone test left `process.env.TZ` at "UTC".
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (STARTED_TZ === undefined && extra.TZ === undefined) delete env.TZ;
  return env;
}

export function runHook(
  script: string,
  stdin: string,
  cwd?: string,
  env?: Record<string, string>,
): HookRun {
  const result = spawnSync("bun", [path.join(REPO_ROOT, script)], {
    input: stdin,
    encoding: "utf-8",
    cwd: cwd ?? os.tmpdir(),
    timeout: 15_000,
    env: childEnv(env),
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** The `additionalContext` of a hook run that exited 0, checking `hookEventName` when given. */
export function hookContext(run: HookRun, eventName?: string): string {
  expect(run.status).toBe(0);
  const out = JSON.parse(run.stdout).hookSpecificOutput;
  if (eventName !== undefined) expect(out.hookEventName).toBe(eventName);
  return out.additionalContext;
}

export type CliRun = HookRun;

/** A fresh empty temp directory to stand in for `~/.crank` in a child process. */
export function makeCrankHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crank-home-"));
}

/** Run `fn` with `vars` set in `process.env`, then put each back as it was, unset ones deleted. */
export function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = Object.keys(vars).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Run the crank-mem CLI as a child process, with fresh temp CODEX_HOME and CRANK_HOME and a
 * current dashboard fixture as CRANK_DASHBOARD_DIR unless `env` overrides them.
 */
export function runCli(cwd: string, args: string[], env?: Record<string, string>): CliRun {
  const home = makeCrankHome();
  // `init` and `upgrade` start a parsing daemon; in a throwaway home nothing ever stops it, and it
  // rewrites code.db under the test (an uninstall then keeps code.db as "what other tools wrote").
  if (args[0] === "init" || args[0] === "upgrade") stopDigests(home);
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "src/cli/main.ts"), ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: childEnv({
      CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "crank-codexhome-")),
      CRANK_HOME: home,
      CRANK_DASHBOARD_DIR: sharedDashboardDir(),
      ...env,
    }),
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

export function setMtime(p: string, ms: number): void {
  fs.utimesSync(p, new Date(ms), new Date(ms));
}

/**
 * Runs `fn` with `.crank/code.db` and the WAL files beside it made read-only, then restores their
 * modes. SQLite creates a missing `-wal` or `-shm` at the store's mode, so the restore lists the
 * files again after `fn`. A read-only store makes `anatomy` answer without refreshing, so what it
 * lists was written by the hook.
 */
export function withReadOnlyCodeDb<T>(root: string, fn: () => T): T {
  const present = () =>
    ["code.db", "code.db-wal", "code.db-shm"]
      .map((name) => path.join(root, ".crank", name))
      .filter((file) => fs.existsSync(file));
  try {
    for (const file of present()) fs.chmodSync(file, 0o444);
    return fn();
  } finally {
    for (const file of present()) fs.chmodSync(file, 0o644);
  }
}

/** The rows `sql` returns from the project's code.db, which must open. */
export function queryCodeDb<T>(root: string, sql: string, ...params: sqlite.SQLInputValue[]): T[] {
  const opened = openCodeDb(root, "read");
  expect(opened.status).toBe("open");
  try {
    return opened.db!.prepare(sql).all(...params) as T[];
  } finally {
    opened.db!.close();
  }
}

/** Plant a WAL code.db at a user_version no crank-mem reads, which hooks leave alone and the CLI rebuilds. */
export function plantCodeDb(root: string, state: "newer"): void {
  const file = path.join(root, ".crank", "code.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite;
  const db = new mod.DatabaseSync(file);
  if (state === "newer")
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE files (x); PRAGMA user_version = 99");
  db.close();
}

/** Hold code.db's write lock so the next writer times out; returns the release. */
export function holdCodeDb(root: string): () => void {
  const opened = openCodeDb(root, "write");
  expect(opened.status).toBe("open");
  opened.db!.exec("BEGIN IMMEDIATE");
  return () => {
    opened.db!.exec("ROLLBACK");
    opened.db!.close();
  };
}

export function enableDebugConfig(root: string): void {
  const crankDir = path.join(root, ".crank");
  saveConfig(crankDir, { ...defaultConfig(), debug: true });
}

/** One .crank/debug.log line: what `flushDebug` and `runAdvisoryHook` write. */
type DebugRecord = {
  hook: string;
  ok: boolean;
  ms: number;
  ts: string;
  error?: string;
  events: Array<{ event: string; [k: string]: unknown }>;
};

/** Parsed .crank/debug.log records, oldest first ([] when the log is absent). */
export function readDebugLog(root: string): DebugRecord[] {
  try {
    return fs
      .readFileSync(path.join(root, ".crank/debug.log"), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as DebugRecord);
  } catch {
    return [];
  }
}

let seedCount = 0;

/** Append one digest of `observations` to the project's store and return their ids in input order. */
export function seedMemory(
  root: string,
  observations: Partial<NewObservation>[],
  opts: {
    costUsd?: number;
    nextSteps?: string;
    proposals?: DigestInput["proposals"];
    stale?: DigestInput["stale"];
    request?: string;
    links?: string[];
    session?: string;
    next?: Position;
  } = {},
): number[] {
  const n = ++seedCount;
  const sessionId = opts.session ?? `seed-${n}`;
  const opened = openStoreForWrite(root);
  if (opened.status !== "open") throw new Error(`seedMemory: store is ${opened.status}`);
  const memory = opened.memory;
  try {
    const before = memory.stats("seed", 0).observations;
    memory.appendDigest({
      session: { id: sessionId, agent: "claude", transcriptPath: `/seed/${sessionId}.jsonl` },
      expected: memory.position(sessionId),
      next: opts.next ?? { uuid: `seed-${n}`, timestamp: new Date().toISOString() },
      model: "seed",
      costUsd: opts.costUsd ?? 0,
      summary: {
        request: opts.request ?? "s",
        investigated: "s",
        learned: "s",
        completed: "s",
        next_steps: opts.nextSteps ?? "none",
      },
      observations: observations.map((o, i) => ({
        type: o.type ?? "discovery",
        title: o.title ?? `Observation ${i}`,
        narrative: o.narrative ?? `Narrative ${i}`,
        facts: o.facts ?? [],
        filesRead: o.filesRead ?? [],
        filesModified: o.filesModified ?? [],
        refs: o.refs ?? [],
      })),
      proposals: opts.proposals ?? [],
      stale: opts.stale ?? [],
      origin: null,
      links: opts.links ?? [],
    });
    const after = memory.stats("seed", 0).observations;
    if (after - before !== observations.length) {
      throw new Error(
        `seedMemory: stored ${after - before} of ${observations.length} observations`,
      );
    }
    return memory
      .recent(observations.length)
      .map((line) => line.id)
      .reverse();
  } finally {
    memory.close();
  }
}

/** Store one vector so `search` embeds its query. */
export function plantVector(root: string, id: number): void {
  const opened = openStoreForWrite(root);
  if (opened.status !== "open") throw new Error(`store is ${opened.status}`);
  try {
    opened.memory.putVectors(EMBED_MODEL, [{ id, vector: new Float32Array(384) }]);
  } finally {
    opened.memory.close();
  }
}

/**
 * Write the project's store in one bad state: a newer schema, a file that is not a database, or a
 * database at the current schema version with no tables, which opens and then fails every query.
 */
export function plantMemory(root: string, state: "newer" | "unreadable" | "broken"): void {
  const file = memoryPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (state === "unreadable") {
    fs.writeFileSync(file, "not a database");
    return;
  }
  const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite;
  const db = new mod.DatabaseSync(file);
  if (state === "newer") db.exec("PRAGMA journal_mode=WAL");
  db.exec(`PRAGMA user_version = ${state === "newer" ? SCHEMA_VERSION + 1 : SCHEMA_VERSION}`);
  db.close();
}

const writables: Memory[] = [];

/** Opens the store at `file` for writing; `closeWritables` closes it. */
export function openWritable(file: string): Memory {
  const result = openMemory(file, "write");
  if (result.status !== "open") throw new Error(`expected open, got ${result.status}`);
  writables.push(result.memory);
  return result.memory;
}

/** Closes every store `openWritable` opened since the last call. */
export function closeWritables(): void {
  for (const memory of writables.splice(0)) memory.close();
}

/** A temp project with digests on; `extraConfig` keys are written into config.json as given, and `temps` registers the root for cleanup. */
export function digestProject(extraConfig: Record<string, unknown> = {}, temps?: string[]): string {
  const root = makeCrankProject();
  temps?.push(root);
  saveConfig(path.join(root, ".crank"), { ...defaultConfig(), digest: true });
  if (Object.keys(extraConfig).length > 0) {
    const file = path.join(root, ".crank/config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...extraConfig }, null, 2),
    );
  }
  return root;
}

/** The names under a crank home's spool/ ([] when it is absent). */
export function spoolFiles(home: string): string[] {
  try {
    return fs.readdirSync(path.join(home, "spool"));
  } catch {
    return [];
  }
}

/**
 * Record a stop under a crank home, as the daemon does when claude is logged out
 * (`login`) or runs on a credential other than the user's login (`credential`).
 */
export function stopDigests(home: string, reason: "login" | "credential" = "login"): void {
  const detail = reason === "login" ? "Not logged in" : "API key in use";
  fs.writeFileSync(
    path.join(home, STOP_FILE),
    JSON.stringify({ reason, atMs: Date.now(), detail }),
  );
}

/** Write a spool entry under a crank home, or under spool/parked/ when `parked`. */
export function spoolEntry(
  home: string,
  stem: string,
  projectRoot: string,
  updatedAt: number,
  parked = false,
  opts: { transcriptPath?: string; cwd?: string; ended?: boolean } = {},
): void {
  const dir = parked ? path.join(home, "spool", "parked") : path.join(home, "spool");
  fs.mkdirSync(dir, { recursive: true });
  const entry: SpoolEntry = {
    transcriptPath: opts.transcriptPath ?? `/t/${stem}.jsonl`,
    projectRoot,
    cwd: opts.cwd ?? projectRoot,
    agent: "claude",
    ended: opts.ended ?? true,
    updatedAt,
  };
  fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(entry));
}

export async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function userRecord(uuid: string, timestamp: string, content: string): string {
  return JSON.stringify({ type: "user", uuid, timestamp, message: { role: "user", content } });
}

/** An `assistant` transcript record holding one `Read` call of `filePath`, as one JSONL line. */
export function readRecord(uuid: string, timestamp: string, filePath: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp,
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_" + uuid, name: "Read", input: { file_path: filePath } },
      ],
    },
  });
}

/** Append records to a transcript; the leading newline ends the fixture's partial last line. */
export function appendRecords(transcript: string, records: string[]): void {
  fs.appendFileSync(transcript, "\n" + records.join("\n") + "\n");
}

/** The parsed daemon.json under a crank home, or null when it is absent or does not parse. */
export function readDaemon(crankHome: string): DaemonState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(crankHome, DAEMON_FILE), "utf-8"));
  } catch {
    return null;
  }
}

/** Spawn `<cloneRoot ?? REPO_ROOT>/bin/crank-mem daemon ...args`, detached, so the daemon leads its own process group. */
export function startDaemon(
  args: string[],
  env: Record<string, string>,
  cloneRoot?: string,
): { proc: ChildProcess; exited: Promise<number> } {
  const root = cloneRoot ?? REPO_ROOT;
  const proc = spawn(path.join(root, "bin/crank-mem"), ["daemon", ...args], {
    cwd: root,
    env: childEnv(env),
    detached: true,
    stdio: "ignore",
  });
  const exited = new Promise<number>((resolve) => proc.once("exit", (code) => resolve(code ?? -1)));
  return { proc, exited };
}

/** SIGKILL the process group of the pid in daemon.json, if any, so a running job and its fake claude die with the daemon. */
export function killDaemon(crankHome: string): void {
  const pid = readDaemon(crankHome)?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // No such group: the daemon already exited.
  }
}

/**
 * A `clone_root` whose `bin/crank-mem` only records that it ran. A daemon that starts under a
 * stop state exits without a trace, so a test that no daemon started reads this record instead.
 */
export function fakeCloneRoot(): { root: string; starts(): number } {
  const root = tempDir("crank-fake-clone-");
  const calls = path.join(root, "calls");
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin/crank-mem"), `#!/bin/sh\necho "$@" >> "${calls}"\n`, {
    mode: 0o755,
  });
  return {
    root,
    starts: () =>
      fs.existsSync(calls) ? fs.readFileSync(calls, "utf-8").split("\n").length - 1 : 0,
  };
}

/**
 * A dashboard dir whose `dist/` copies tests/fixtures/dashboard-dist/, with `dist/.crank-version`
 * holding `stamp` unless `stamp` is null. `dir` is a fresh `tempDir` unless given.
 */
export function dashboardFixture(stamp: string | null, dir = tempDir("crank-dashdir-")): string {
  fs.cpSync(path.join(REPO_ROOT, "tests/fixtures/dashboard-dist"), path.join(dir, "dist"), {
    recursive: true,
  });
  if (stamp !== null) fs.writeFileSync(path.join(dir, "dist/.crank-version"), stamp);
  return dir;
}

let sharedDashboard: string | undefined;

/** One current dashboard fixture per process, outside `tempDir` so `cleanup` keeps it; the preload's root holds it. */
export function sharedDashboardDir(): string {
  sharedDashboard ??= dashboardFixture(
    cliVersion(),
    fs.mkdtempSync(path.join(os.tmpdir(), "crank-dashdir-")),
  );
  return sharedDashboard;
}

// bun test runs this process in UTC, so each CLI child gets a pinned zone and dates are computed in it.
// Zones on both sides of UTC make a UTC-midnight reading fail at any hour in one of them.
export const ZONES = ["Pacific/Kiritimati", "Pacific/Pago_Pago"];

/** Runs `fn` in `zone`, then restores the UTC `bun test` starts in; `delete` would fall back to the machine zone. */
export function inZone<T>(zone: string, fn: () => T): T {
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    process.env.TZ = "UTC";
  }
}

export const temps: string[] = [];
export const children: ChildProcess[] = [];
export async function cleanup(): Promise<void> {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      process.kill(-child.pid!, "SIGKILL");
      await exited;
    }
  }
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

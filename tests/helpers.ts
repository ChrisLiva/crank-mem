import { expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type * as sqlite from "node:sqlite";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import {
  memoryPath,
  openMemory,
  type DigestInput,
  type NewObservation,
} from "../src/hooks/lib/memory.ts";
import { DAEMON_FILE, type DaemonState } from "../src/hooks/lib/spool.ts";
import { STOP_FILE } from "../src/hooks/lib/user-state.ts";
import { EMBED_MODEL, MODEL_FILES } from "../src/daemon/embedder.ts";
import { claudeSessionEnd, claudeStop } from "./fixtures/payloads.ts";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** Create a temp project with .crank/ initialized and some source files. */
export function makeCrankProject(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-proj-"));
  fs.mkdirSync(path.join(root, ".crank"), { recursive: true });
  saveConfig(path.join(root, ".crank"), defaultConfig());
  fs.copyFileSync(
    path.join(REPO_ROOT, "src/templates/cerebrum.md"),
    path.join(root, ".crank/cerebrum.md"),
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

/** Run a hook script as a child process with the given stdin, like an agent would. */
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
  opts: {
    costUsd?: number;
    nextSteps?: string;
    proposals?: DigestInput["proposals"];
    stale?: DigestInput["stale"];
  } = {},
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
      summary: {
        request: "s",
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
      })),
      proposals: opts.proposals ?? [],
      stale: opts.stale ?? [],
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
  db.exec("PRAGMA user_version = 3");
  db.close();
}

export type FakeScenario = {
  auth?: { stdout: string; exit: number } | "hang"; // default: the logged-in claude.ai stdout, exit 0
  lines?: string[]; // stream-json lines printed on a -p run
  raw?: string; // printed instead of lines
  exit?: number; // default 0
  sleepMs?: number; // wait before printing
  pauseAfterFirstMs?: number; // wait after printing the first line, before the rest
};
export type FakeCall = {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
  cwd: string;
  startMs: number;
  endMs: number | null;
};

// The gating keys of live `claude auth status` at 2.1.316, without its account and path fields.
const AUTH_LOGGED_IN = {
  stdout: JSON.stringify(
    { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" },
    null,
    2,
  ),
  exit: 0,
};

// A bun script, not /bin/sh: sh adds `_`, `PWD` and `SHLVL` to the environment it records.
const FAKE_CLAUDE = `#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
const dir = import.meta.dir;
const scenarios = JSON.parse(fs.readFileSync(path.join(dir, "scenarios.json"), "utf8"));
const callsFile = path.join(dir, "calls.jsonl");
const n = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\\n").filter(Boolean).length : 0;
const s = scenarios[Math.min(n, scenarios.length - 1)] ?? {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
if (argv[0] === "auth" && argv[1] === "status") {
  const auth = s.auth ?? ${JSON.stringify(AUTH_LOGGED_IN)};
  if (auth === "hang") { setInterval(() => {}, 1 << 30); await new Promise(() => {}); }
  process.stdout.write(auth.stdout + "\\n");
  process.exit(auth.exit);
}
const startMs = Date.now();
const stdin = await new Response(Bun.stdin.stream()).text();
fs.appendFileSync(callsFile, JSON.stringify({ argv, env: process.env, stdin, cwd: process.cwd(), startMs }) + "\\n");
if (s.sleepMs) await sleep(s.sleepMs);
if (s.raw !== undefined) process.stdout.write(s.raw);
else for (const [i, line] of (s.lines ?? []).entries()) {
  process.stdout.write(line + "\\n");
  if (i === 0 && s.pauseAfterFirstMs) await sleep(s.pauseAfterFirstMs);
}
fs.appendFileSync(path.join(dir, "ends.jsonl"), JSON.stringify({ n, endMs: Date.now() }) + "\\n");
process.exit(s.exit ?? 0);
`;

function readJsonl(file: string): any[] {
  try {
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** A fake `claude` on PATH: the n-th `-p` call plays `scenarios[n]` (the last repeats) and records its argv, env, stdin and cwd. */
export function fakeClaude(
  dir: string,
  scenarios: FakeScenario[],
): { env: Record<string, string>; calls(): FakeCall[] } {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "scenarios.json"), JSON.stringify(scenarios));
  return {
    env: { PATH: `${dir}:${process.env.PATH}` },
    calls() {
      const ends = new Map<number, number>(
        readJsonl(path.join(dir, "ends.jsonl")).map((e) => [e.n, e.endMs]),
      );
      return readJsonl(path.join(dir, "calls.jsonl")).map((c, n) => ({
        ...c,
        endMs: ends.get(n) ?? null,
      }));
    },
  };
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

/** Record a `login` stop under a crank home, as the daemon does when claude is logged out. */
export function stopDigests(home: string): void {
  fs.writeFileSync(
    path.join(home, STOP_FILE),
    JSON.stringify({ reason: "login", atMs: Date.now(), detail: "Not logged in" }),
  );
}

/** Write a spool entry under a crank home, or under spool/parked/ when `parked`. */
export function spoolEntry(
  home: string,
  stem: string,
  projectRoot: string,
  updatedAt: number,
  parked = false,
): void {
  const dir = parked ? path.join(home, "spool", "parked") : path.join(home, "spool");
  fs.mkdirSync(dir, { recursive: true });
  const entry = {
    transcriptPath: `/t/${stem}.jsonl`,
    projectRoot,
    agent: "claude",
    ended: true,
    updatedAt,
  };
  fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(entry));
}

/** Poll `cond` every 20 ms until it holds, or throw after `timeoutMs`. */
export async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A `user` transcript record as one JSONL line. */
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
    env: { ...process.env, ...env },
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

/** The model `crank-mem setup` put in the real ~/.crank/models; read only, and it throws when the model is absent. */
export function realModelsDir(): string {
  const dir = path.join(os.homedir(), ".crank", "models");
  const missing = MODEL_FILES.filter((f) => !fs.existsSync(path.join(dir, EMBED_MODEL, f)));
  if (missing.length > 0) {
    throw new Error(
      `the local search model is missing ${missing.join(", ")} under ${dir}; run \`crank-mem setup\` once`,
    );
  }
  return dir;
}

/** A temp CRANK_HOME whose models entry is a symlink to realModelsDir(). */
export function makeModelHome(): string {
  const home = makeCrankHome();
  fs.symlinkSync(realModelsDir(), path.join(home, "models"));
  return home;
}

/** Start tests/fixtures/model-server.ts as a child serving `dir`; `requests()` lists the paths it was asked for. */
export async function startModelServer(
  dir: string,
  mode: "ok" | "stall" | "slow",
): Promise<{ url: string; requests(): string[]; stop(): void }> {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crank-modelsrv-")), "requests.log");
  fs.writeFileSync(log, "");
  const proc = spawn(
    process.execPath,
    [
      path.join(REPO_ROOT, "tests/fixtures/model-server.ts"),
      "--dir",
      dir,
      "--mode",
      mode,
      "--log",
      log,
    ],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const stop = () => {
    proc.kill("SIGKILL");
  };
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error("model server did not print its port")),
      10_000,
    );
    proc.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = /^PORT (\d+)\n/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("model server exited before printing its port"));
    });
  }).catch((err) => {
    stop();
    throw err;
  });
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => fs.readFileSync(log, "utf-8").split("\n").filter(Boolean),
    stop,
  };
}

export const FIXTURE = path.join(REPO_ROOT, "tests/fixtures/transcript.jsonl");
export const TOKEN = "ghp_" + "a1".repeat(18);

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

export type Journey = {
  root: string;
  home: string;
  stem: string;
  transcript: string;
  fake: ReturnType<typeof fakeClaude>;
  job: CliRun;
  spool: string[];
};

/**
 * Write the `stem` (default s1) spool entry through the Stop and SessionEnd hooks, then run `job <stem>`.
 * `transcript` replaces the fixture's text; `env` adds to the job's environment; `home` replaces the empty crank home.
 */
export function journey(
  root: string,
  scenarios: FakeScenario[],
  opts: {
    transcript?: string;
    env?: Record<string, string>;
    skipJob?: boolean;
    timeoutMs?: number | string;
    home?: string;
    stem?: string;
    cwd?: string;
    args?: string[];
  } = {},
): Journey {
  const home = opts.home ?? makeCrankHome();
  const stem = opts.stem ?? "s1";
  temps.push(home);
  const tmp = tempDir("crank-job-");
  const transcript = path.join(tmp, `t/${stem}.jsonl`);
  fs.mkdirSync(path.dirname(transcript));
  if (opts.transcript === undefined) fs.copyFileSync(FIXTURE, transcript);
  else fs.writeFileSync(transcript, opts.transcript);
  const fake = fakeClaude(path.join(tmp, "bin"), scenarios);
  const hookEnv = { ...fake.env, CRANK_HOME: home };
  const cwd = opts.cwd ?? root;
  expect(
    runHook(
      "src/hooks/stop.ts",
      JSON.stringify({ ...claudeStop(cwd), transcript_path: transcript }),
      root,
      hookEnv,
    ).status,
  ).toBe(0);
  expect(
    runHook(
      "src/hooks/session-end.ts",
      JSON.stringify(claudeSessionEnd(cwd, transcript)),
      root,
      hookEnv,
    ).status,
  ).toBe(0);
  expect(spoolFiles(home)).toEqual([`${stem}.json`]);
  const j = { root, home, stem, transcript, fake };
  const job = opts.skipJob
    ? { status: -1, stdout: "", stderr: "" }
    : rerun(j, opts.timeoutMs, opts.env, opts.args);
  return { ...j, job, spool: spoolFiles(home) };
}

/** Run `job <stem>` again on a journey's project, home and fake. */
export function rerun(
  j: Pick<Journey, "root" | "home" | "fake"> & { stem?: string },
  timeoutMs: number | string = 10_000,
  env: Record<string, string> = {},
  args: string[] = [],
): CliRun {
  const argv = ["job", j.stem ?? "s1", "--run-timeout-ms", String(timeoutMs), ...args];
  return runCli(j.root, argv, { ...j.fake.env, CRANK_HOME: j.home, ...env });
}

/** The recorded stop state under a crank home, or null when digests are not stopped. */
export function stopState(home: string): { reason: string; atMs: unknown; detail: unknown } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "digest-state.json"), "utf8"));
  } catch {
    return null;
  }
}

export function expectStopped(home: string, reason: "credential" | "login"): void {
  const state = stopState(home);
  expect(state?.reason).toBe(reason);
  expect(typeof state?.atMs).toBe("number");
  expect(typeof state?.detail === "string" && state.detail.length > 0).toBe(true);
}

/**
 * Three 800-character `user` records dated after the fixture, and their distilled text. A job finds its saved
 * position by uuid, so each job in one journey needs a batch with its own `tag`.
 */
export function laterRecords(tag = "later"): { records: string[]; text: string } {
  const contents = [0, 1, 2].map(() => `${tag} `.repeat(800).slice(0, 800));
  return {
    records: contents.map((c, i) => userRecord(`${tag}-${i}`, `2026-01-03T00:00:0${i}.000Z`, c)),
    text: contents.map((c) => `[USER]\n${c}`).join("\n\n"),
  };
}

/** Send the Stop hook for a journey's transcript, rewriting its spool entry. */
export function stop(j: Pick<Journey, "root" | "home" | "fake" | "transcript">): void {
  const payload = JSON.stringify({ ...claudeStop(j.root), transcript_path: j.transcript });
  expect(
    runHook("src/hooks/stop.ts", payload, j.root, { ...j.fake.env, CRANK_HOME: j.home }).status,
  ).toBe(0);
}

/** Start `job s1` in its own process group, so a kill takes its claude child with it. */
export function spawnJob(
  j: Pick<Journey, "root" | "home" | "fake">,
  args: string[] = [],
): Promise<number | null> {
  const child = spawn(
    process.execPath,
    [path.join(REPO_ROOT, "src/cli/main.ts"), "job", "s1", "--run-timeout-ms", "10000", ...args],
    {
      cwd: j.root,
      env: { ...process.env, ...j.fake.env, CRANK_HOME: j.home },
      detached: true,
      stdio: "ignore",
    },
  );
  children.push(child);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

/** `crank-mem search` stdout; `home` is the CRANK_HOME it reads the model from (none by default). */
export function search(root: string, query: string, home?: string): string {
  const run = runCli(
    root,
    ["search", query],
    home === undefined ? undefined : { CRANK_HOME: home },
  );
  expect(run.status).toBe(0);
  return run.stdout;
}

/** `crank-mem get` on the one observation a search finds. */
export function getOne(root: string, query: string): string {
  const id = /^#(\d+) /.exec(search(root, query))?.[1];
  expect(id).toBeDefined();
  const run = runCli(root, ["get", id!]);
  expect(run.status).toBe(0);
  return run.stdout;
}

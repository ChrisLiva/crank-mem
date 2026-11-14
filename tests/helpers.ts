import { expect } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type * as sqlite from "node:sqlite";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import {
  memoryPath,
  openStoreForWrite,
  type DigestInput,
  type NewObservation,
  type Position,
} from "../src/hooks/lib/memory.ts";
import { SCHEMA_VERSION } from "../src/hooks/lib/memory-schema.ts";
import { DAEMON_FILE, type DaemonState, type SpoolEntry } from "../src/hooks/lib/spool.ts";
import { STOP_FILE } from "../src/hooks/lib/user-state.ts";
import { EMBED_MODEL, MODEL_FILES } from "../src/daemon/embedder.ts";
import { cliVersion } from "../src/cli/version.ts";
import { registerProject } from "../src/hooks/lib/registry.ts";
import { claudeSessionEnd, claudeStop } from "./fixtures/payloads.ts";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");

// Every child that inherits process.env checks for a release against a closed local port, never
// GitHub, unless its test passes a release server.
process.env.CRANK_RELEASE_URL ??= "http://127.0.0.1:9";

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

export function makeProject(extra: Record<string, string> = {}): {
  root: string;
  codexHome: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-init-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "crank-codexhome-"));
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.6"\n');
  fs.writeFileSync(path.join(root, "app.ts"), "/** The app. */\nexport const app = 1;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Test project\n");
  for (const [rel, content] of Object.entries(extra)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  spawnSync("git", ["init", "-q"], { cwd: root });
  return { root, codexHome };
}

/** Recursive listing and contents of everything except .git and .crank. */
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
    env: childEnv(env),
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
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
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "src/cli/main.ts"), ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: childEnv({
      CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "crank-codexhome-")),
      CRANK_HOME: makeCrankHome(),
      CRANK_DASHBOARD_DIR: sharedDashboardDir(),
      ...env,
    }),
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

export type Call = { argv: string; cwd: string };

/**
 * A fake package manager named `name` that appends each call's argv and cwd,
 * then exits `exit`, or 1 on the call `failOn` names. With `exit` "runtime" it
 * exits 0 for `install` and otherwise runs the test's own runtime with its
 * arguments, so the launcher's `exec bun` still runs the CLI.
 */
export function fakeTool(
  name: "bun" | "npm",
  exit: number | "runtime",
  failOn?: { argv: string; cwd?: string },
): { dir: string; calls(): Call[] } {
  const dir = tempDir(`crank-fake${name}-`);
  const log = path.join(dir, "calls");
  const match = failOn
    ? `[ "$*" = "${failOn.argv}" ]${failOn.cwd ? ` && [ "$(pwd -P)" = "${failOn.cwd}" ]` : ""}`
    : "false";
  const record = `printf '%s\\t%s\\n' "$*" "$(pwd -P)" >> "${log}"`;
  const body =
    exit === "runtime"
      ? `[ "$1" = install ] && exit 0\nexec '${process.execPath}' "$@"`
      : `echo "${name} failed on purpose" >&2\nif ${match}; then exit 1; fi\nexit ${exit}`;
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${record}\n${body}\n`, { mode: 0o755 });
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [argv, cwd] = l.split("\t");
            return { argv: argv!, cwd: cwd! };
          })
      : [];
  return { dir, calls };
}

/**
 * An installed copy of this repo at `<home>/versions/<version>`: `src/`, `bin/`, `bun.lock` and
 * `package.json` (its version set to `version`), the repo's `node_modules` linked in, and a
 * dashboard build stamped `version`. Points `<home>/current` at it and returns the version dir.
 */
export function makeInstalledCopy(home: string, version: string): string {
  const dir = path.join(home, "versions", version);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["src", "bin", "bun.lock"])
    fs.cpSync(path.join(REPO_ROOT, name), path.join(dir, name), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ ...pkg, version }, null, 2));
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"));
  fs.cpSync(path.join(dashboardFixture(version), "dist"), path.join(dir, "dashboard/dist"), {
    recursive: true,
  });
  // A rename replaces an existing link in one step, so a reader never finds `current` missing.
  const link = path.join(home, "current");
  const tmp = `${link}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(path.join("versions", version), tmp);
  fs.renameSync(tmp, link);
  return dir;
}

/**
 * Run `<home>/current/bin/crank-mem` in `cwd` with `home` as its crank home, a fresh CODEX_HOME,
 * and a runtime `fakeTool` bun first on PATH so no real `bun install` writes through the copy's linked node_modules.
 */
export function runInstalled(
  home: string,
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): CliRun {
  const result = spawnSync(path.join(home, "current/bin/crank-mem"), args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: childEnv({
      CRANK_HOME: home,
      CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "crank-codexhome-")),
      PATH: `${fakeTool("bun", "runtime").dir}:${process.env.PATH}`,
      ...env,
    }),
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const initedTemplates = new Map<string, string>();

/**
 * A copy of a project inited once per process with `files`, timestamps kept. Only for tests that assert
 * nothing about the registry or Codex trust and run no `uninstall` and no `--restore`: init's backup
 * manifest names the template's path. The template lives outside `tempDir`, which `cleanup` empties.
 */
export function initedCopy(
  files: Record<string, string> = { "a.ts": "export const a = 1;\n" },
): string {
  const key = JSON.stringify(files);
  let template = initedTemplates.get(key);
  if (template === undefined) {
    template = fs.mkdtempSync(path.join(os.tmpdir(), "crank-template-"));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(template, rel)), { recursive: true });
      fs.writeFileSync(path.join(template, rel), content);
    }
    expect(runCli(template, ["init", "--yes", "--codex", "skip"]).status).toBe(0);
    initedTemplates.set(key, template);
  }
  const copy = tempDir("crank-copy-");
  fs.cpSync(template, copy, { recursive: true, preserveTimestamps: true });
  return copy;
}

/** An `initedCopy` listed in `home`'s registry, as a realpath, since the dashboard hashes the root as listed. */
export function registeredCopy(home: string, files?: Record<string, string>): string {
  const root = fs.realpathSync(initedCopy(files));
  withEnv({ CRANK_HOME: home }, () => registerProject(root));
  return root;
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

export type FakeScenario = {
  auth?: { stdout: string; exit: number } | "hang"; // default: the logged-in claude.ai stdout, exit 0
  lines?: string[]; // stream-json lines printed on a -p run
  raw?: string; // printed instead of lines
  exit?: number; // default 0
  sleepMs?: number; // wait before printing
  hold?: true; // wait before printing until the test calls the fake's release()
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
// An orphaned held fake (its job killed without its group) exits instead of polling forever.
if (s.hold) while (!fs.existsSync(path.join(dir, "release"))) {
  if (process.ppid === 1) process.exit(1);
  await sleep(20);
}
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

/**
 * A fake `claude` on PATH: the n-th `-p` call plays `scenarios[n]` (the last repeats) and records its argv, env, stdin and cwd.
 * `release()` lets every `hold` scenario, running or later, print.
 */
export function fakeClaude(
  dir: string,
  scenarios: FakeScenario[],
): { env: Record<string, string>; calls(): FakeCall[]; release(): void } {
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
    release() {
      fs.writeFileSync(path.join(dir, "release"), "");
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

/**
 * Start `script` under this runtime with `args` plus `--log <file>`; it prints `PORT <n>` once
 * listening on 127.0.0.1 and appends each requested path to the log, which `requests()` lists.
 */
async function startFixtureServer(
  script: string,
  args: string[],
): Promise<{ url: string; requests(): string[]; stop(): void }> {
  const log = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "crank-fixturesrv-")),
    "requests.log",
  );
  fs.writeFileSync(log, "");
  const proc = spawn(process.execPath, [script, ...args, "--log", log], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stop = () => {
    proc.kill("SIGKILL");
  };
  const name = path.basename(script);
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`${name} did not print its port`)), 10_000);
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
      reject(new Error(`${name} exited before printing its port`));
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

/** Start tests/fixtures/model-server.ts as a child serving `dir`; `requests()` lists the paths it was asked for. */
export function startModelServer(
  dir: string,
  mode: "ok" | "stall" | "slow",
): Promise<{ url: string; requests(): string[]; stop(): void }> {
  return startFixtureServer(path.join(REPO_ROOT, "tests/fixtures/model-server.ts"), [
    "--dir",
    dir,
    "--mode",
    mode,
  ]);
}

/** Start tests/fixtures/release-server.ts as a child answering `GET /<path>` with `<dir>/<path>`. */
export function startReleaseServer(
  dir: string,
  opts: { delayMs?: number } = {},
): Promise<{ url: string; requests(): string[]; stop(): void }> {
  return startFixtureServer(path.join(REPO_ROOT, "tests/fixtures/release-server.ts"), [
    "--dir",
    dir,
    ...(opts.delayMs === undefined ? [] : ["--delay-ms", String(opts.delayMs)]),
  ]);
}

export type Pack = { status: number; stderr: string; out: string };

/** Run `scripts/pack-release.ts` from a temp cwd into a fresh out dir. */
export function pack(dist: string, extra: string[] = []): Pack {
  const out = tempDir("crank-release-out-");
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/pack-release.ts"), "--out", out, "--dist", dist, ...extra],
    { cwd: tempDir("crank-release-cwd-"), encoding: "utf-8", timeout: 60_000, env: childEnv() },
  );
  return { status: result.status ?? -1, stderr: result.stderr, out };
}

const RELEASE_FILES = ["crank-mem.tar.gz", "crank-mem.tar.gz.sha256", "release.json"];
const packedReleases = new Map<string, string>();

/** The release files of `version`, packed once per process outside `tempDir`, which `cleanup` empties. */
function packedRelease(version: string): string {
  let dir = packedReleases.get(version);
  if (dir === undefined) {
    const run = pack(path.join(dashboardFixture(version), "dist"), ["--version", version]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crank-release-dir-"));
    for (const file of RELEASE_FILES) {
      fs.copyFileSync(path.join(run.out, file), path.join(dir, file));
    }
    packedReleases.set(version, dir);
  }
  return dir;
}

/**
 * A fresh release dir laid out like the release host: `download/v<V>/` for each of `versions`
 * and `latest/download/` holding `latest`. Each call returns its own copy, so a test may edit it.
 */
export function releaseDir(versions: string[] = ["1.0.0"], latest = versions[0]!): string {
  const copy = tempDir("crank-release-r-");
  const subs: Array<[string, string]> = [
    ...versions.map((v): [string, string] => [`download/v${v}`, v]),
    ["latest/download", latest],
  ];
  for (const [sub, version] of subs) {
    fs.cpSync(packedRelease(version), path.join(copy, sub), { recursive: true });
  }
  return copy;
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

/** `root` (a fresh temp dir by default) inited with `home` as its crank home, as a realpath. */
export function registeredProject(home: string, root = tempDir("crank-dash-proj-")): string {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
  expect(runCli(root, ["init", "--yes", "--codex", "skip"], { CRANK_HOME: home }).status).toBe(0);
  return fs.realpathSync(root);
}

/** The id the dashboard gives a project whose store sits in `<root>/.crank`. */
export function projectId(root: string): string {
  return crypto
    .createHash("sha256")
    .update(path.join(fs.realpathSync(root), ".crank"))
    .digest("hex")
    .slice(0, 12);
}

// bun test runs this process in UTC, so each CLI child gets a pinned zone and dates are computed in it.
// Zones on both sides of UTC make a UTC-midnight reading fail at any hour in one of them.
export const ZONES = ["Pacific/Kiritimati", "Pacific/Pago_Pago"];

const STARTUP_LINE = /^crank-mem dashboard: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+))\n/;

/**
 * Start `crank-mem dashboard` as a child on `home` and wait for its startup line; with `bin`, the
 * child is that launcher (an installed copy's), which needs its own `dashboardDir`. `get` sends a
 * request with the session cookie and the Host the URL names unless `init` overrides them.
 */
export async function startDashboard(
  home: string,
  args: string[],
  opts: {
    open?: boolean;
    cwd?: string;
    env?: Record<string, string>;
    dashboardDir?: string;
    keep?: true;
    bin?: string;
  } = {},
): Promise<{
  url: string;
  token: string;
  get(path: string, init?: RequestInit): Promise<Response>;
  stop(signal?: "SIGTERM" | "SIGINT"): Promise<number>;
  output(): { stdout: string; stderr: string };
}> {
  const dashArgs = ["dashboard", ...(opts.open ? [] : ["--no-open"]), ...args];
  const child = spawn(
    opts.bin ?? process.execPath,
    opts.bin ? dashArgs : [path.join(REPO_ROOT, "src/cli/main.ts"), ...dashArgs],
    {
      cwd: opts.cwd ?? tempDir("crank-dash-cwd-"),
      env: childEnv({
        CRANK_HOME: home,
        CRANK_DASHBOARD_DIR: opts.dashboardDir ?? dashboardFixture(cliVersion()),
        ...opts.env,
      }),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!opts.keep) children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const closed = new Promise<number>((resolve) =>
    child.once("close", (code) => resolve(code ?? -1)),
  );
  const [url, port, token] = await new Promise<[string, number, string]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`dashboard did not print its startup line: ${stderr}`)),
      10_000,
    );
    const check = () => {
      const m = STARTUP_LINE.exec(stdout);
      if (!m) return;
      clearTimeout(timer);
      resolve([m[1]!, Number(m[2]), m[3]!]);
    };
    child.stdout!.on("data", check);
    void closed.then((code) => {
      clearTimeout(timer);
      reject(new Error(`dashboard exited ${code} before its startup line: ${stderr}`));
    });
  });
  return {
    url,
    token,
    get(p, init = {}) {
      const headers = new Headers({
        Host: `127.0.0.1:${port}`,
        Cookie: `crank_dashboard=${token}`,
      });
      new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      return fetch(`http://127.0.0.1:${port}${p}`, { redirect: "manual", ...init, headers });
    },
    stop(signal = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return closed;
    },
    output: () => ({ stdout, stderr }),
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
 * Plant the `stem` (default s1) spool entry, or with `hooks` write it through the Stop and SessionEnd hooks, then
 * run `job <stem>`. `transcript` replaces the fixture's text; `env` adds to the job's environment; `home` replaces
 * the empty crank home.
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
    hooks?: true;
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
  const cwd = opts.cwd ?? root;
  if (opts.hooks) {
    const hookEnv = { ...fake.env, CRANK_HOME: home };
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
  } else {
    spoolEntry(home, stem, root, Date.now(), false, { transcriptPath: transcript, cwd });
  }
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
export function spawnJob(j: Pick<Journey, "root" | "home" | "fake">): Promise<number | null> {
  const child = spawn(
    process.execPath,
    [path.join(REPO_ROOT, "src/cli/main.ts"), "job", "s1", "--run-timeout-ms", "10000"],
    {
      cwd: j.root,
      env: childEnv({ ...j.fake.env, CRANK_HOME: j.home }),
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

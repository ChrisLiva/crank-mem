import { expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { STOP_FILE } from "../src/hooks/lib/user-state.ts";
import { claudeSessionEnd, claudeStop } from "./fixtures/payloads.ts";
import {
  REPO_ROOT,
  children,
  childEnv,
  makeCrankHome,
  runCli,
  runHook,
  spoolEntry,
  spoolFiles,
  tempDir,
  temps,
  userRecord,
  type CliRun,
} from "./helpers.ts";

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

export const FIXTURE = path.join(REPO_ROOT, "tests/fixtures/transcript.jsonl");
export const TOKEN = "ghp_" + "a1".repeat(18);

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
    return JSON.parse(fs.readFileSync(path.join(home, STOP_FILE), "utf8"));
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

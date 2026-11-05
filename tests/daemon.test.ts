import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  REPO_ROOT,
  appendRecords,
  digestProject,
  fakeClaude,
  killDaemon,
  laterRecords,
  makeCrankHome,
  readDaemon,
  runCli,
  runHook,
  setMtime,
  spoolFiles,
  startDaemon,
  stopDigests,
  userRecord,
  waitFor,
  type FakeCall,
  type FakeScenario,
} from "./helpers.ts";
import { digestRequest } from "../src/daemon/digest-prompt.ts";
import { okStream, refusalStream, status500Stream } from "./fixtures/claude-scenarios.ts";
import { SAMPLE_DIGEST } from "./fixtures/digest-output.ts";
import { claudeSessionEnd, claudeStop } from "./fixtures/payloads.ts";

const FIXTURE = path.join(REPO_ROOT, "tests/fixtures/transcript.jsonl");
const EXPECTED = fs.readFileSync(
  path.join(REPO_ROOT, "tests/fixtures/transcript.expected.txt"),
  "utf8",
);
const OK: FakeScenario = { lines: okStream(SAMPLE_DIGEST) };
const FAIL: FakeScenario = { lines: status500Stream() };
const MINUTE = 60_000;

// Every crank home and daemon a test starts, so afterEach kills them and afterAll proves none survived.
const temps: string[] = [];
const homes: string[] = [];
const handles: { proc: ChildProcess; exited: Promise<number> }[] = [];
const others: ChildProcess[] = [];
const daemonPids = new Set<number>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Pids a test wrote into daemon.json itself; they are not daemons.
const planted = new Set<number>();

/** The pid in a crank home's daemon.json, recorded for the afterAll check. */
function daemonPid(home: string): number | undefined {
  const pid = readDaemon(home)?.pid;
  if (typeof pid === "number" && !planted.has(pid)) daemonPids.add(pid);
  return pid;
}

afterEach(async () => {
  for (const home of homes.splice(0)) {
    daemonPid(home);
    killDaemon(home);
  }
  for (const pid of daemonPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  for (const h of handles.splice(0)) {
    if (h.proc.exitCode === null && h.proc.signalCode === null) {
      try {
        process.kill(-h.proc.pid!, "SIGKILL");
      } catch {}
    }
    await h.exited;
  }
  for (const child of others.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
  }
  await waitFor(() => [...daemonPids].every((pid) => !alive(pid)), 5_000);
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  for (const pid of daemonPids)
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

type Env = { home: string; fake: ReturnType<typeof fakeClaude>; env: Record<string, string> };

/** A crank home that afterEach cleans up, a fake claude playing `scenarios`, and the env every run here carries. */
function setup(scenarios: FakeScenario[] = [OK]): Env {
  const home = makeCrankHome();
  temps.push(home);
  homes.push(home);
  const fake = fakeClaude(path.join(tempDir("crank-fake-"), "bin"), scenarios);
  return { home, fake, env: { ...fake.env, CRANK_HOME: home } };
}

function daemon(
  args: string[],
  e: Env,
  cloneRoot?: string,
): { proc: ChildProcess; exited: Promise<number> } {
  const h = startDaemon(args, e.env, cloneRoot);
  handles.push(h);
  daemonPids.add(h.proc.pid!);
  return h;
}

function plantDaemon(home: string, pid: number, heartbeatMs: number): void {
  planted.add(pid);
  fs.writeFileSync(
    path.join(home, "daemon.json"),
    JSON.stringify({ pid, version: "0.8.0", heartbeatMs }),
  );
}

/** The pid of a child that already exited. */
function finishedPid(): number {
  return spawnSync(process.execPath, ["-e", "0"]).pid;
}

/** Resolve with the exit code, or "running" when `ms` passes first. */
function within(exited: Promise<number>, ms: number): Promise<number | "running"> {
  return Promise.race([exited, new Promise<"running">((r) => setTimeout(() => r("running"), ms))]);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A copy of the fixture transcript under a temp dir, named `<stem>.jsonl`. */
function transcriptCopy(stem: string, marker?: string): string {
  const file = path.join(tempDir("crank-t-"), `${stem}.jsonl`);
  fs.copyFileSync(FIXTURE, file);
  if (marker)
    appendRecords(file, [
      userRecord(`${marker}-1`, "2026-01-03T00:00:00.000Z", `Note for ${marker}.`),
    ]);
  return file;
}

function plantEntry(
  home: string,
  stem: string,
  entry: { transcriptPath: string; projectRoot: string; ended: boolean; updatedAt?: number },
  parked = false,
): string {
  const file = path.join(home, "spool", parked ? "parked" : "", `${stem}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ agent: "claude", updatedAt: Date.now(), ...entry }));
  return file;
}

function search(root: string, query: string): string {
  const run = runCli(root, ["search", query]);
  expect(run.status).toBe(0);
  return run.stdout;
}

/** Asserts `search` prints exactly one stored row: one line carrying the `#<id> ` prefix. */
function expectOneRow(root: string, query: string): void {
  const lines = search(root, query).trim().split("\n");
  expect(lines.length).toBe(1);
  expect(lines[0]).toMatch(/^#\d+ /);
}

describe("daemon ownership (real processes)", () => {
  test("a second daemon exits while the first heartbeats, and the first keeps the file", async () => {
    const e = setup();
    const first = daemon([], e);
    await waitFor(() => daemonPid(e.home) === first.proc.pid, 3_000);
    const second = daemon([], e);
    expect(await within(second.exited, 2_000)).toBe(0);
    expect(daemonPid(e.home)).toBe(first.proc.pid);
    expect(alive(first.proc.pid!)).toBe(true);
  }, 10_000);

  test("a daemon.json with an old heartbeat is replaced, and its live pid is never signalled", async () => {
    const e = setup();
    plantDaemon(e.home, finishedPid(), Date.now() - 120_000);
    const a = daemon([], e);
    await waitFor(() => daemonPid(e.home) === a.proc.pid, 3_000);
    killDaemon(e.home);
    await a.exited;

    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    others.push(sleeper);
    plantDaemon(e.home, sleeper.pid!, Date.now() - 120_000);
    const b = daemon([], e);
    await waitFor(() => daemonPid(e.home) === b.proc.pid, 3_000);
    await sleepMs(200);
    expect(sleeper.exitCode).toBe(null);
    expect(sleeper.signalCode).toBe(null);
  }, 10_000);

  test("two daemons started at once: exactly one keeps running and the other exits 0", async () => {
    const e = setup();
    const pair = [daemon([], e), daemon([], e)];
    const first = await Promise.race(pair.map((h, i) => h.exited.then((code) => ({ i, code }))));
    expect(first.code).toBe(0);
    const winner = pair[1 - first.i]!;
    expect(await within(winner.exited, 500)).toBe("running");
    expect(daemonPid(e.home)).toBe(winner.proc.pid);
  }, 10_000);

  test("two daemons stealing one stale file: within 2 s exactly one is alive and owns it", async () => {
    const e = setup();
    plantDaemon(e.home, finishedPid(), Date.now() - 120_000);
    const pair = [daemon(["--sweep-ms", "50"], e), daemon(["--sweep-ms", "50"], e)];
    const codes = await Promise.all(pair.map((h) => within(h.exited, 2_000)));
    expect(codes.filter((c) => c === "running").length).toBe(1);
    expect(codes.filter((c) => c === 0).length).toBe(1);
    expect(daemonPid(e.home)).toBe(pair[codes.indexOf("running")]!.proc.pid);
  }, 10_000);

  test("a daemon whose file names another pid exits 0 at its next sweep and leaves the file", async () => {
    const e = setup();
    const d = daemon(["--sweep-ms", "50"], e);
    await waitFor(() => daemonPid(e.home) === d.proc.pid, 3_000);
    const other = finishedPid();
    plantDaemon(e.home, other, Date.now());
    expect(await within(d.exited, 1_000)).toBe(0);
    expect(readDaemon(e.home)?.pid).toBe(other);
  }, 10_000);
});

describe("daemon sweeps", () => {
  test("the capture-to-recall journey: Stop, SessionEnd, one sweep, then search and get", () => {
    const root = digestProject({}, temps);
    const e = setup();
    const transcript = transcriptCopy("s1");
    expect(
      runHook(
        "src/hooks/stop.ts",
        JSON.stringify({ ...claudeStop(root), transcript_path: transcript }),
        root,
        e.env,
      ).status,
    ).toBe(0);
    expect(
      runHook(
        "src/hooks/session-end.ts",
        JSON.stringify(claudeSessionEnd(root, transcript)),
        root,
        e.env,
      ).status,
    ).toBe(0);
    expect(spoolFiles(e.home)).toEqual(["s1.json"]);

    const run = runCli(root, ["daemon", "--once"], {
      ...e.env,
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "t",
      CLAUDE_CODE_OAUTH_TOKEN: "o",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      CLAUDE_CODE_MAX_RETRIES: "9",
    });
    expect(run.status).toBe(0);
    expect(e.fake.calls().length).toBe(1);
    const call = e.fake.calls()[0]!;
    expect(call.stdin).toBe(
      "[CEREBRUM]\n## User Preferences\n\n## Memory\n\n[TRANSCRIPT]\n" + EXPECTED,
    );
    expect(Object.keys(call.env).sort()).toEqual([
      "CLAUDE_CODE_MAX_RETRIES",
      "HOME",
      "PATH",
      "TMPDIR",
      "USER",
    ]);
    expect(spoolFiles(e.home)).toEqual([]);
    expect(fs.existsSync(path.join(e.home, "daemon.json"))).toBe(false);

    expectOneRow(root, "EEXIST");
    const id = /^#(\d+) /.exec(search(root, "credentials"))?.[1];
    expect(id).toBeDefined();
    const got = runCli(root, ["get", id!]);
    expect(got.stdout).toContain("[redacted]");
    expect(got.stdout).not.toContain("ghp_");
  }, 30_000);

  test("a Stop entry is digested once its transcript is quiet for 30 minutes, not while it is fresh", () => {
    const root = digestProject({}, temps);
    const e = setup();
    const fresh = transcriptCopy("fresh");
    plantEntry(e.home, "fresh", { transcriptPath: fresh, projectRoot: root, ended: false });
    expect(runCli(root, ["daemon", "--once"], e.env).status).toBe(0);
    expect(e.fake.calls().length).toBe(0);
    expect(spoolFiles(e.home)).toEqual(["fresh.json"]);

    const quiet = transcriptCopy("quiet");
    setMtime(quiet, Date.now() - 31 * MINUTE);
    plantEntry(e.home, "quiet", { transcriptPath: quiet, projectRoot: root, ended: false });
    expect(runCli(root, ["daemon", "--once"], e.env).status).toBe(0);
    expect(e.fake.calls().length).toBe(1);
    expect(spoolFiles(e.home)).toEqual(["fresh.json"]);
  }, 30_000);

  test("one sweep prunes off, removed and transcript-less entries and old seen files, with no model call", () => {
    const e = setup();
    const off = digestProject({}, temps);
    plantEntry(e.home, "off", {
      transcriptPath: transcriptCopy("off"),
      projectRoot: off,
      ended: false,
    });
    expect(runCli(off, ["digest", "off"], e.env).status).toBe(0);

    const gone = digestProject({}, temps);
    const goneEntry = { transcriptPath: transcriptCopy("gone"), projectRoot: gone, ended: true };
    plantEntry(e.home, "gone", goneEntry);
    plantEntry(e.home, "gone-parked", goneEntry, true);
    fs.rmSync(gone, { recursive: true, force: true });

    const on = digestProject({}, temps);
    plantEntry(e.home, "missing", {
      transcriptPath: path.join(on, "nope.jsonl"),
      projectRoot: on,
      ended: false,
    });
    const keptParked = plantEntry(
      e.home,
      "kept",
      { transcriptPath: transcriptCopy("kept"), projectRoot: on, ended: true },
      true,
    );

    const seen = path.join(e.home, "seen");
    fs.mkdirSync(seen);
    fs.writeFileSync(path.join(seen, "old.json"), "{}");
    fs.writeFileSync(path.join(seen, "new.json"), "{}");
    setMtime(path.join(seen, "old.json"), Date.now() - 8 * 24 * 60 * MINUTE);

    expect(runCli(on, ["daemon", "--once"], e.env).status).toBe(0);
    expect(spoolFiles(e.home)).toEqual(["parked"]);
    expect(fs.readdirSync(path.join(e.home, "spool/parked"))).toEqual(["kept.json"]);
    expect(fs.existsSync(keptParked)).toBe(true);
    expect(fs.readdirSync(seen)).toEqual(["new.json"]);
    expect(e.fake.calls().length).toBe(0);
  }, 30_000);

  test("one job at a time across projects, oldest first, while sweeps keep heartbeating", async () => {
    const e = setup([{ ...OK, sleepMs: 400 }]);
    const a = digestProject({}, temps);
    const b = digestProject({}, temps);
    const now = Date.now();
    plantEntry(e.home, "sa", {
      transcriptPath: transcriptCopy("sa", "marker-A"),
      projectRoot: a,
      ended: true,
      updatedAt: now - 2_000,
    });
    plantEntry(e.home, "sb", {
      transcriptPath: transcriptCopy("sb", "marker-B"),
      projectRoot: b,
      ended: true,
      updatedAt: now,
    });
    daemon(["--sweep-ms", "50"], e);

    await waitFor(() => e.fake.calls().length === 1, 10_000);
    const beat = readDaemon(e.home)!.heartbeatMs;
    await sleepMs(200);
    expect(readDaemon(e.home)!.heartbeatMs).toBeGreaterThan(beat);

    await waitFor(() => e.fake.calls().length === 2 && e.fake.calls()[1]!.endMs !== null, 10_000);
    const [first, second] = e.fake.calls();
    expect(first!.stdin).toContain("marker-A");
    expect(second!.stdin).toContain("marker-B");
    expect(first!.endMs!).toBeLessThanOrEqual(second!.startMs);
  }, 30_000);
});

describe("daemon retry holds", () => {
  /** The gap from each call's endMs to the next call's startMs. */
  function gaps(calls: FakeCall[]): number[] {
    return calls.slice(1).map((c, k) => c.startMs - calls[k]!.endMs!);
  }

  test("a failing stem waits --retry-ms, doubling each failure up to --retry-cap-ms", async () => {
    const e = setup([FAIL]);
    const root = digestProject({}, temps);
    plantEntry(e.home, "s1", {
      transcriptPath: transcriptCopy("s1"),
      projectRoot: root,
      ended: true,
    });
    daemon(["--sweep-ms", "25", "--retry-ms", "200", "--retry-cap-ms", "800"], e);
    await waitFor(() => e.fake.calls().length >= 5, 15_000);
    const [g1, g2, g3, g4] = gaps(e.fake.calls().slice(0, 5));
    expect(g1!).toBeGreaterThanOrEqual(200);
    expect(g1!).toBeLessThan(700);
    expect(g2!).toBeGreaterThanOrEqual(400);
    expect(g2!).toBeLessThan(900);
    expect(g3!).toBeGreaterThanOrEqual(800);
    expect(g3!).toBeLessThan(1_300);
    expect(g4!).toBeGreaterThanOrEqual(800);
    expect(g4!).toBeLessThan(1_500);
  }, 20_000);

  test("a run past --run-timeout-ms is killed and retried, never parked", async () => {
    const e = setup([{ ...OK, sleepMs: 5_000 }]);
    const root = digestProject({}, temps);
    plantEntry(e.home, "s1", {
      transcriptPath: transcriptCopy("s1"),
      projectRoot: root,
      ended: true,
    });
    daemon(["--sweep-ms", "25", "--run-timeout-ms", "1000", "--retry-ms", "200"], e);
    await waitFor(() => e.fake.calls().length >= 3, 6_000);
    for (const call of e.fake.calls()) expect(call.endMs).toBe(null);
    expect(spoolFiles(e.home)).toEqual(["s1.json"]);
  }, 10_000);

  test("a hold belongs to one stem, a refusal holds like a failure, and exit 0 clears it", async () => {
    const two = setup([FAIL, OK, FAIL]);
    const a = digestProject({}, temps);
    const b = digestProject({}, temps);
    const now = Date.now();
    plantEntry(two.home, "sa", {
      transcriptPath: transcriptCopy("sa", "marker-A"),
      projectRoot: a,
      ended: true,
      updatedAt: now - 2_000,
    });
    plantEntry(two.home, "sb", {
      transcriptPath: transcriptCopy("sb", "marker-B"),
      projectRoot: b,
      ended: true,
      updatedAt: now,
    });
    daemon(["--sweep-ms", "25", "--retry-ms", "400"], two);
    await waitFor(() => two.fake.calls().length >= 4, 10_000);
    const calls = two.fake.calls();
    expect(calls[0]!.stdin).toContain("marker-A");
    expect(calls[1]!.stdin).toContain("marker-B");
    for (const call of calls.slice(2)) expect(call.stdin).toContain("marker-A");
    expectOneRow(b, "EEXIST");
    expect(spoolFiles(two.home)).toContain("sa.json");

    const one = setup([FAIL, { lines: refusalStream() }, FAIL, FAIL]);
    const root = digestProject({}, temps);
    plantEntry(one.home, "s1", {
      transcriptPath: transcriptCopy("s1"),
      projectRoot: root,
      ended: true,
    });
    daemon(["--sweep-ms", "25", "--retry-ms", "400"], one);
    await waitFor(() => one.fake.calls().length >= 3, 10_000);
    const [g0, g1] = gaps(one.fake.calls());
    expect(g0!).toBeGreaterThanOrEqual(400);
    expect(g0!).toBeLessThan(800);
    expect(g1!).toBeGreaterThanOrEqual(800);
    expect(g1!).toBeLessThan(1_600);
  }, 25_000);
});

describe("daemon exits", () => {
  test("after --idle-ms with an empty spool, or with only parked entries, removing daemon.json", async () => {
    const empty = setup();
    const d1 = daemon(["--idle-ms", "300", "--sweep-ms", "50"], empty);
    expect(await within(d1.exited, 2_000)).toBe(0);
    expect(fs.existsSync(path.join(empty.home, "daemon.json"))).toBe(false);

    const parked = setup();
    const root = digestProject({}, temps);
    const entry = plantEntry(
      parked.home,
      "p",
      { transcriptPath: transcriptCopy("p"), projectRoot: root, ended: true },
      true,
    );
    const d2 = daemon(["--idle-ms", "300", "--sweep-ms", "50"], parked);
    expect(await within(d2.exited, 2_000)).toBe(0);
    expect(fs.existsSync(path.join(parked.home, "daemon.json"))).toBe(false);
    expect(fs.existsSync(entry)).toBe(true);
  }, 10_000);

  test("at the sweep after a stop file appears while it idles", async () => {
    const e = setup();
    const d = daemon(["--sweep-ms", "50"], e);
    await waitFor(() => daemonPid(e.home) === d.proc.pid, 3_000);
    stopDigests(e.home);
    expect(await within(d.exited, 1_000)).toBe(0);
  }, 10_000);

  test("a stop file written while a job runs: the job finishes and the daemon exits", async () => {
    const e = setup([{ ...OK, sleepMs: 1_500 }]);
    const root = digestProject({}, temps);
    plantEntry(e.home, "s1", {
      transcriptPath: transcriptCopy("s1"),
      projectRoot: root,
      ended: true,
    });
    const d = daemon(["--sweep-ms", "50"], e);
    await waitFor(() => e.fake.calls().length === 1, 10_000);
    stopDigests(e.home);
    expect(await within(d.exited, 5_000)).toBe(0);
    expect(e.fake.calls()[0]!.endMs).not.toBe(null);
    expectOneRow(root, "EEXIST");
  }, 20_000);

  test("after its current job when package.json's version changes, starting no other job", async () => {
    const clone = tempDir("crank-clone-");
    for (const name of ["src", "bin", "package.json"])
      fs.cpSync(path.join(REPO_ROOT, name), path.join(clone, name), { recursive: true });
    const e = setup([{ ...OK, sleepMs: 1_500 }, OK]);
    const root = digestProject({ clone_root: clone }, temps);
    const now = Date.now();
    plantEntry(e.home, "s1", {
      transcriptPath: transcriptCopy("s1"),
      projectRoot: root,
      ended: true,
      updatedAt: now - 1_000,
    });
    plantEntry(e.home, "s2", {
      transcriptPath: transcriptCopy("s2"),
      projectRoot: root,
      ended: true,
      updatedAt: now,
    });
    const d = daemon(["--sweep-ms", "50"], e, clone);
    await waitFor(() => e.fake.calls().length === 1, 10_000);
    const pkg = path.join(clone, "package.json");
    fs.writeFileSync(
      pkg,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(pkg, "utf8")), version: "9.9.9" }),
    );
    expect(await within(d.exited, 5_000)).toBe(0);
    expect(e.fake.calls().length).toBe(1);
    expectOneRow(root, "EEXIST");
    expect(spoolFiles(e.home)).toEqual(["s2.json"]);
  }, 20_000);
});

describe("daemon recovery", () => {
  test("entries survive a killed daemon, and the next Stop restarts it and drains them", async () => {
    const root = digestProject({ clone_root: REPO_ROOT }, temps);
    const e = setup();
    const transcript = transcriptCopy("s1");
    const stop = () =>
      runHook(
        "src/hooks/stop.ts",
        JSON.stringify({ ...claudeStop(root), transcript_path: transcript }),
        root,
        e.env,
      );
    expect(stop().status).toBe(0);
    await waitFor(() => daemonPid(e.home) !== undefined, 3_000);
    const killed = daemonPid(e.home)!;
    killDaemon(e.home);
    await waitFor(() => !alive(killed), 3_000);
    fs.writeFileSync(
      path.join(e.home, "daemon.json"),
      JSON.stringify({ ...readDaemon(e.home), heartbeatMs: Date.now() - 120_000 }),
    );
    expect(spoolFiles(e.home)).toEqual(["s1.json"]);

    setMtime(transcript, Date.now() - 31 * MINUTE);
    expect(stop().status).toBe(0);
    await waitFor(() => {
      const pid = daemonPid(e.home);
      return pid !== undefined && pid !== killed;
    }, 3_000);
    await waitFor(() => spoolFiles(e.home).length === 0, 5_000);
    expectOneRow(root, "EEXIST");
  }, 20_000);

  test("digest resume clears the stop file from any directory and the stopped entry drains", async () => {
    const root = digestProject({}, temps);
    const e = setup();
    stopDigests(e.home);
    plantEntry(e.home, "s1", {
      transcriptPath: transcriptCopy("s1"),
      projectRoot: root,
      ended: true,
    });
    expect(runCli(root, ["daemon", "--once"], e.env).status).toBe(0);
    expect(e.fake.calls().length).toBe(0);
    expect(spoolFiles(e.home)).toEqual(["s1.json"]);

    const run = runCli(tempDir("crank-nowhere-"), ["digest", "resume"], e.env);
    expect(run.status).toBe(0);
    expect(fs.existsSync(path.join(e.home, "digest-state.json"))).toBe(false);
    await waitFor(() => spoolFiles(e.home).length === 0, 5_000);
    daemonPid(e.home);
    expectOneRow(root, "EEXIST");
  }, 20_000);
});

describe("mid-session digests", () => {
  const MID = ["--sweep-ms", "50", "--idle-ms", "60000", "--mid-session-ms", "1500"];

  test("a live session is digested once per window, the first one window after the first sweep that saw it", async () => {
    const e = setup();
    const root = digestProject({}, temps);
    const transcript = transcriptCopy("mid", "marker-A");
    plantEntry(e.home, "mid", { transcriptPath: transcript, projectRoot: root, ended: false });
    const t0 = Date.now();
    daemon(MID, e);

    await sleepMs(1_000);
    expect(e.fake.calls()).toEqual([]);
    await waitFor(() => e.fake.calls().length === 1, 10_000);
    const first = e.fake.calls()[0]!;
    expect(first.startMs - t0).toBeGreaterThanOrEqual(1_500);
    expect(first.stdin).toContain("marker-A");

    await waitFor(() => e.fake.calls()[0]!.endMs !== null, 10_000);
    await waitFor(() => spoolFiles(e.home).length === 0, 10_000);
    const firstEndMs = e.fake.calls()[0]!.endMs!;
    const later = laterRecords();
    appendRecords(transcript, later.records);
    plantEntry(e.home, "mid", {
      transcriptPath: transcript,
      projectRoot: root,
      ended: false,
      updatedAt: Date.now(),
    });
    await waitFor(() => e.fake.calls().length === 2, 10_000);
    const second = e.fake.calls()[1]!;
    expect(second.startMs - firstEndMs).toBeGreaterThanOrEqual(1_500);
    expect(second.stdin).toBe(
      digestRequest(later.text, SAMPLE_DIGEST.summary, {
        cerebrum: "## User Preferences\n\n## Memory",
        existing: [],
      }).input,
    );
  }, 30_000);

  test("a restarted daemon opens the window again at its first sweep", async () => {
    const e = setup();
    const root = digestProject({}, temps);
    plantEntry(e.home, "mid", {
      transcriptPath: transcriptCopy("mid", "marker-A"),
      projectRoot: root,
      ended: false,
    });
    const first = daemon(MID, e);
    await sleepMs(800);
    killDaemon(e.home);
    await first.exited;
    fs.writeFileSync(
      path.join(e.home, "daemon.json"),
      JSON.stringify({ ...readDaemon(e.home), heartbeatMs: Date.now() - 120_000 }),
    );

    const t1 = Date.now();
    daemon(MID, e);
    await waitFor(() => e.fake.calls().length === 1, 10_000);
    expect(e.fake.calls()[0]!.startMs - t1).toBeGreaterThanOrEqual(1_500);
  }, 20_000);
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  REPO_ROOT,
  digestProject,
  fakeClaude,
  killDaemon,
  makeCrankHome,
  makeCrankProject,
  readDaemon,
  runHook,
  spoolFiles,
  waitFor,
} from "./helpers.ts";
import { claudeSessionEnd, claudeStop } from "./fixtures/payloads.ts";

const STOP = "src/hooks/stop.ts";
const SESSION_END = "src/hooks/session-end.ts";
const TRANSCRIPT = "/x/abc-1.jsonl";

// Every daemon a hook starts here, so none outlives the suite.
const homes: string[] = [];
const daemonPids = new Set<number>();
function daemonPid(home: string): number | undefined {
  const pid = readDaemon(home)?.pid;
  if (typeof pid === "number") daemonPids.add(pid);
  return pid;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  await waitFor(() => [...daemonPids].every((pid) => !alive(pid)), 5_000);
});
afterAll(() => {
  for (const pid of daemonPids)
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
});

/** A crank home whose daemon afterEach kills, and a fake claude for any job that daemon runs. */
function daemonEnv(): { home: string; env: Record<string, string> } {
  const home = makeCrankHome();
  homes.push(home);
  const fake = fakeClaude(path.join(home, "fake-bin"), [{ raw: "", exit: 1 }]);
  return { home, env: { ...fake.env, CRANK_HOME: home } };
}
function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("hook-started daemon (black-box)", () => {
  test("a Stop with digest on starts a daemon that outlives the hook", async () => {
    const root = digestProject({ clone_root: REPO_ROOT });
    const { home, env } = daemonEnv();
    const run = runHook(
      STOP,
      JSON.stringify({ ...claudeStop(root), transcript_path: TRANSCRIPT }),
      root,
      env,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    await waitFor(() => daemonPid(home) !== undefined, 20_000);
    expect(alive(daemonPid(home)!)).toBe(true);
  }, 30_000);

  test("a SessionEnd replaces a daemon whose heartbeat is older than 90 s", async () => {
    const root = digestProject({ clone_root: REPO_ROOT });
    const { home, env } = daemonEnv();
    const finished = spawnSync(process.execPath, ["-e", "0"]).pid;
    fs.writeFileSync(
      path.join(home, "daemon.json"),
      JSON.stringify({ pid: finished, version: "0.8.0", heartbeatMs: Date.now() - 120_000 }),
    );
    const run = runHook(SESSION_END, JSON.stringify(claudeSessionEnd(root, TRANSCRIPT)), root, env);
    expect(run.status).toBe(0);
    await waitFor(() => {
      const pid = daemonPid(home);
      return pid !== undefined && pid !== finished;
    }, 20_000);
    expect(alive(daemonPid(home)!)).toBe(true);
  }, 30_000);

  test("a stop file or digest off starts no daemon", async () => {
    const stopped = daemonEnv();
    fs.writeFileSync(
      path.join(stopped.home, "digest-state.json"),
      JSON.stringify({ reason: "login", atMs: 1, detail: "x" }),
    );
    const on = digestProject({ clone_root: REPO_ROOT });
    const payload = (root: string) =>
      JSON.stringify({ ...claudeStop(root), transcript_path: TRANSCRIPT });
    expect(runHook(STOP, payload(on), on, stopped.env).status).toBe(0);
    expect(spoolFiles(stopped.home)).toEqual(["abc-1.json"]);

    const off = daemonEnv();
    const offRoot = makeCrankProject();
    const file = path.join(offRoot, ".crank/config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), clone_root: REPO_ROOT }),
    );
    expect(runHook(STOP, payload(offRoot), offRoot, off.env).status).toBe(0);

    await sleepMs(1_500);
    expect(fs.existsSync(path.join(stopped.home, "daemon.json"))).toBe(false);
    // A daemon would have swept the entry away, since its transcript does not exist.
    expect(spoolFiles(stopped.home)).toEqual(["abc-1.json"]);
    expect(fs.existsSync(path.join(off.home, "daemon.json"))).toBe(false);
  }, 10_000);

  test.each([
    ["empty", ""],
    ["a missing directory", "/nonexistent/crank-mem-clone"],
  ])(
    "clone_root %s starts nothing, and the hook still signals",
    async (_label, cloneRoot) => {
      const root = digestProject({ clone_root: cloneRoot });
      const { home, env } = daemonEnv();
      const run = runHook(
        STOP,
        JSON.stringify({ ...claudeStop(root), transcript_path: TRANSCRIPT }),
        root,
        env,
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
      expect(spoolFiles(home)).toEqual(["abc-1.json"]);
      // ensureDaemon returns before spawn when clone_root names no clone.
      await sleepMs(200);
      expect(fs.existsSync(path.join(home, "daemon.json"))).toBe(false);
    },
    10_000,
  );
});

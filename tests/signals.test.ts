import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  REPO_ROOT,
  childEnv,
  digestProject,
  makeCrankHome,
  makeCrankProject,
  runHook,
  setMtime,
  spoolEntry,
  spoolFiles,
} from "./helpers.ts";
import { claudeSessionEnd, claudeStop } from "./fixtures/payloads.ts";
import {
  deleteEntry,
  deleteParked,
  readParked,
  readSpool,
  settleEntry,
} from "../src/hooks/lib/spool.ts";

const STOP = "src/hooks/stop.ts";
const SESSION_END = "src/hooks/session-end.ts";
const TRANSCRIPT = "/x/abc-1.jsonl";
// Any time after the files were written: cerebrum is fresher than all of them.
const FRESH = Date.now() + 1_000_000_000;

function entryFile(home: string, stem = "abc-1"): string {
  return path.join(home, "spool", `${stem}.json`);
}
function readEntry(home: string, stem = "abc-1"): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(entryFile(home, stem), "utf-8"));
}
function stop(root: string, home: string, active = false) {
  const payload = { ...claudeStop(root, active), transcript_path: TRANSCRIPT };
  return runHook(STOP, JSON.stringify(payload), root, { CRANK_HOME: home });
}

describe("digest signals (black-box)", () => {
  test("Stop writes a spool entry keyed by the transcript stem", () => {
    const root = digestProject();
    const home = makeCrankHome();
    // Inside a stop_hook_active continuation, Stop still signals and prints nothing.
    const run = stop(root, home, true);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    const entry = readEntry(home);
    expect(entry).toMatchObject({
      transcriptPath: TRANSCRIPT,
      projectRoot: root,
      cwd: root,
      agent: "claude",
      ended: false,
    });
    expect(typeof entry.updatedAt).toBe("number");
    expect(Math.abs(Date.now() - (entry.updatedAt as number))).toBeLessThan(60_000);
  });

  test("a hook run with no env writes its spool entry under the preload's CRANK_HOME", () => {
    expect(process.env.CRANK_HOME).toBeTruthy();
    expect(process.env.CRANK_HOME).not.toBe(path.join(os.homedir(), ".crank"));
    const root = digestProject();
    const payload = { ...claudeStop(root), transcript_path: "/x/t/preload-probe.jsonl" };
    expect(runHook(STOP, JSON.stringify(payload), root).status).toBe(0);
    expect(spoolFiles(process.env.CRANK_HOME!)).toContain("preload-probe.json");
  });

  test("SessionEnd marks the entry ended, and a later Stop reopens it", () => {
    const root = digestProject();
    const home = makeCrankHome();
    const end = runHook(SESSION_END, JSON.stringify(claudeSessionEnd(root, TRANSCRIPT)), root, {
      CRANK_HOME: home,
    });
    expect(end.status).toBe(0);
    expect(end.stdout).toBe("");
    expect(readEntry(home)).toMatchObject({
      transcriptPath: TRANSCRIPT,
      projectRoot: root,
      ended: true,
    });

    expect(stop(root, home).status).toBe(0);
    expect(readEntry(home).ended).toBe(false);
  });

  test("a digest: true committed in config.json alone writes no spool entry", () => {
    const root = makeCrankProject();
    const file = path.join(root, ".crank/config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf-8")), digest: true }, null, 2),
    );
    const home = makeCrankHome();
    expect(stop(root, home).status).toBe(0);
    expect(
      runHook(SESSION_END, JSON.stringify(claudeSessionEnd(root, TRANSCRIPT)), root, {
        CRANK_HOME: home,
      }).status,
    ).toBe(0);
    expect(spoolFiles(home)).toEqual([]);
  });

  test.each([
    ["absent", undefined, 0],
    ["a number", 42, 0],
    ["not a transcript", "/x/a.txt", 0],
    ["a subagent transcript", "/x/s1/subagents/agent-a.jsonl", 0],
    ["a stem with a space", "/x/a b.jsonl", 0],
    ["a plain transcript", "/x/a.jsonl", 1],
  ])("transcript_path %s", (_label, transcriptPath, count) => {
    const root = digestProject();
    const home = makeCrankHome();
    const payload: Record<string, unknown> = {
      ...claudeStop(root),
      transcript_path: transcriptPath,
    };
    if (transcriptPath === undefined) delete payload.transcript_path;
    expect(runHook(STOP, JSON.stringify(payload), root, { CRANK_HOME: home }).status).toBe(0);
    expect(spoolFiles(home).length).toBe(count);
  });

  test("with CRANK_HOME empty, the entry lands under ~/.crank, created 0700", () => {
    const root = digestProject();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crank-userhome-"));
    const run = runHook(
      STOP,
      JSON.stringify({ ...claudeStop(root), transcript_path: TRANSCRIPT }),
      root,
      {
        CRANK_HOME: "",
        HOME: tmp,
      },
    );
    expect(run.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, ".crank/spool/abc-1.json"))).toBe(true);
    expect(fs.statSync(path.join(tmp, ".crank")).mode & 0o777).toBe(0o700);
  });

  test("concurrent Stops for one session leave one parseable entry", async () => {
    const root = digestProject();
    const home = makeCrankHome();
    const payload = JSON.stringify({ ...claudeStop(root), transcript_path: TRANSCRIPT });
    const statuses = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise<number | null>((resolve) => {
            const child = spawn("bun", [path.join(REPO_ROOT, STOP)], {
              cwd: root,
              env: childEnv({ CRANK_HOME: home }),
              stdio: ["pipe", "ignore", "ignore"],
            });
            child.on("close", resolve);
            child.stdin.end(payload);
          }),
      ),
    );
    expect(statuses).toEqual(Array(8).fill(0));
    expect(readEntry(home).transcriptPath).toBe(TRANSCRIPT);
    expect(spoolFiles(home)).toEqual(["abc-1.json"]);
  });

  test("an unwritable crank home leaves the hook silent and exit 0", () => {
    const root = digestProject();
    setMtime(path.join(root, ".crank/cerebrum.md"), FRESH);
    const run = stop(root, "/dev/null/x");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toContain("crank-mem stop:");
  });

  test("a new signal unparks a parked session; the spool readers skip temp and broken files", () => {
    const root = digestProject();
    const home = makeCrankHome();
    const saved = process.env.CRANK_HOME;
    process.env.CRANK_HOME = home;
    try {
      expect(readSpool()).toEqual([]);
      expect(readParked()).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.CRANK_HOME;
      else process.env.CRANK_HOME = saved;
    }
    const parked = path.join(home, "spool/parked/abc-1.json");
    fs.mkdirSync(path.dirname(parked), { recursive: true });
    fs.writeFileSync(
      parked,
      JSON.stringify({
        transcriptPath: TRANSCRIPT,
        projectRoot: root,
        agent: "claude",
        ended: true,
        updatedAt: 1,
      }),
    );

    expect(stop(root, home).status).toBe(0);
    expect(fs.existsSync(parked)).toBe(false);
    expect(fs.existsSync(entryFile(home))).toBe(true);

    fs.writeFileSync(path.join(home, "spool/abc-1.json.99.0.tmp"), "{");
    fs.writeFileSync(path.join(home, "spool/bad.json"), "{");
    process.env.CRANK_HOME = home;
    try {
      const [item] = readSpool();
      expect(item?.stem).toBe("abc-1");
      expect(settleEntry("abc-1", item!.entry.updatedAt, "park")).toBe(true);
      expect(readSpool()).toEqual([]);
      expect(readParked().map((i) => i.stem)).toEqual(["abc-1"]);
      deleteParked("abc-1");
      expect(readParked()).toEqual([]);
      expect(() => deleteEntry("nope")).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.CRANK_HOME;
      else process.env.CRANK_HOME = saved;
    }
  });

  test("settleEntry removes or parks only the entry the job read", () => {
    const root = digestProject();
    const home = makeCrankHome();
    const spool = path.join(home, "spool");
    const t = 1_700_000_000_000.5;
    const claims = () => fs.readdirSync(spool).filter((n) => n.endsWith(".claim"));
    const saved = process.env.CRANK_HOME;
    process.env.CRANK_HOME = home;
    try {
      spoolEntry(home, "s1", root, t);
      expect(settleEntry("s1", t, "delete")).toBe(true);
      expect(fs.readdirSync(spool)).toEqual([]);

      spoolEntry(home, "s1", root, t);
      expect(settleEntry("s1", t, "park")).toBe(true);
      expect(readSpool()).toEqual([]);
      expect(readParked().map((i) => i.entry.updatedAt)).toEqual([t]);
      expect(claims()).toEqual([]);
      deleteParked("s1");

      spoolEntry(home, "s1", root, t + 1);
      expect(settleEntry("s1", t, "delete")).toBe(false);
      expect(settleEntry("s1", t, "park")).toBe(false);
      expect(readSpool().map((i) => i.entry.updatedAt)).toEqual([t + 1]);
      expect(readParked()).toEqual([]);
      expect(claims()).toEqual([]);

      fs.writeFileSync(path.join(spool, "s1.json"), "{");
      expect(settleEntry("s1", t, "delete")).toBe(false);
      expect(fs.readFileSync(path.join(spool, "s1.json"), "utf-8")).toBe("{");
      expect(claims()).toEqual([]);
      deleteEntry("s1");

      expect(settleEntry("nope", t, "delete")).toBe(false);
      expect(claims()).toEqual([]);

      spoolEntry(home, "s1", root, t);
      expect(settleEntry("s1", t, "delete")).toBe(true);
      expect(settleEntry("s1", t, "delete")).toBe(false);
      expect(fs.readdirSync(spool)).toEqual(["parked"]);
    } finally {
      if (saved === undefined) delete process.env.CRANK_HOME;
      else process.env.CRANK_HOME = saved;
    }
  });
});

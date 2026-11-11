import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  REPO_ROOT,
  makeCrankHome,
  makeCrankProject,
  plantMemory,
  runHook,
  seedMemory,
  setMtime,
  type HookRun,
} from "./helpers.ts";
import { claudePostBash, claudePostRead } from "./fixtures/payloads.ts";

const HOOK = "src/hooks/post-read.ts";
const TRANSCRIPT = "/u/.claude/projects/-proj/551be959.jsonl";
const HOUR = 3_600_000;

/** A project whose src/a.ts has `rows` observations, its mtime an hour before the seed. */
function seeded(rows = 7, title = (i: number) => `Read a ${i}`): { root: string; seedMs: number } {
  const root = makeCrankProject({
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 1;\n",
  });
  const seedMs = Date.now();
  seedMemory(
    root,
    Array.from({ length: rows }, (_, i) => ({ title: title(i), filesRead: ["src/a.ts"] })),
  );
  setMtime(path.join(root, "src/a.ts"), seedMs - HOUR);
  return { root, seedMs };
}

function run(root: string, payload: object, env: Record<string, string> = {}): HookRun {
  return runHook(HOOK, JSON.stringify(payload), root, { CRANK_HOME: makeCrankHome(), ...env });
}

function context(r: HookRun): string {
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  expect(out.hookEventName).toBe("PostToolUse");
  return out.additionalContext;
}

describe("post-read file history", () => {
  test("a Read of a file with observations shows its newest five lines", () => {
    const { root } = seeded();
    const r = run(root, claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT));
    expect(r.status).toBe(0);
    const ctx = context(r);
    expect(ctx).toStartWith("History of src/a.ts:\n#");
    const lines = ctx.split("\n").slice(1);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^#\d+ \d{4}-\d\d-\d\d discovery Read a 6$/);
  });

  test("an unwritable seen marker still shows the history, silently", () => {
    const { root } = seeded();
    const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crank-homefile-")), "home");
    fs.writeFileSync(home, "a regular file");
    const r = run(root, claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT), {
      CRANK_HOME: home,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(context(r)).toStartWith("History of src/a.ts:\n#");
  });

  test("a Bash read names the same history as a Read", () => {
    const { root } = seeded();
    const viaRead = context(
      run(root, claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT)),
    );
    const viaBash = context(run(root, claudePostBash(root, "sed -n '1,20p' src/a.ts", TRANSCRIPT)));
    expect(viaBash).toBe(viaRead);
    const viaUnfold = context(
      run(root, claudePostBash(root, "crank-mem unfold src/a.ts f", TRANSCRIPT)),
    );
    expect(viaUnfold).toBe(viaRead);
  }, 20_000);

  test("sections stop at 1,536 bytes", () => {
    const root = makeCrankProject({ "src/a.ts": "a\n", "src/b.ts": "b\n" });
    const seedMs = Date.now();
    const long = (f: string) => (i: number) => `${f}${i} `.padEnd(200, "x");
    seedMemory(
      root,
      Array.from({ length: 20 }, (_, i) => ({ title: long("a")(i), filesRead: ["src/a.ts"] })),
    );
    seedMemory(
      root,
      Array.from({ length: 20 }, (_, i) => ({ title: long("b")(i), filesRead: ["src/b.ts"] })),
    );
    for (const f of ["src/a.ts", "src/b.ts"]) setMtime(path.join(root, f), seedMs - HOUR);
    const ctx = context(run(root, claudePostBash(root, "cat src/a.ts src/b.ts", TRANSCRIPT)));
    expect(ctx).toContain("History of src/a.ts:");
    expect(ctx).not.toContain("History of src/b.ts:");
    expect(Buffer.byteLength(ctx)).toBeLessThanOrEqual(1536);
  });
});

describe("post-read stale rows", () => {
  test("a file's history leaves out a stale row", () => {
    const root = makeCrankProject({ "src/a.ts": "export const a = 1;\n" });
    const seedMs = Date.now();
    const [a] = seedMemory(root, [
      { title: "Lock retry is two seconds", filesRead: ["src/a.ts"] },
      { title: "Lock files live in .crank", filesRead: ["src/a.ts"] },
    ]) as [number];
    seedMemory(root, [], { stale: [{ id: a, reason: "retry is 5 s now" }] });
    setMtime(path.join(root, "src/a.ts"), seedMs - HOUR);
    const ctx = context(run(root, claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT)));
    expect(ctx).toMatch(/^History of src\/a\.ts:\n#\d+ \S+ discovery Lock files live in \.crank$/);
  });
});

describe("post-read once per agent per session", () => {
  test("a repeat read is silent; a subagent and another session see it again", () => {
    const { root } = seeded();
    const env = { CRANK_HOME: makeCrankHome() };
    const file = path.join(root, "src/a.ts");
    expect(context(run(root, claudePostRead(root, file, TRANSCRIPT), env))).toStartWith(
      "History of src/a.ts:",
    );
    expect(run(root, claudePostRead(root, file, TRANSCRIPT), env).stdout).toBe("");
    expect(context(run(root, claudePostRead(root, file, TRANSCRIPT, "a1b2"), env))).toStartWith(
      "History of src/a.ts:",
    );
    const other = "/u/.claude/projects/-proj/7c2e9f14.jsonl";
    expect(context(run(root, claudePostRead(root, file, other), env))).toStartWith(
      "History of src/a.ts:",
    );
  });
});

describe("post-read change tag", () => {
  test("a file written after its newest observation is tagged, an older one is not, and a deleted one shows no history", () => {
    const { root, seedMs } = seeded();
    const file = path.join(root, "src/a.ts");
    setMtime(file, seedMs + HOUR);
    expect(context(run(root, claudePostRead(root, file, TRANSCRIPT)))).toStartWith(
      "History of src/a.ts: [file changed since]\n#",
    );
    setMtime(file, seedMs - HOUR);
    expect(context(run(root, claudePostRead(root, file, TRANSCRIPT)))).toStartWith(
      "History of src/a.ts:\n#",
    );
    seedMemory(root, [{ title: "Gone", filesRead: ["src/gone.ts"] }]);
    expect(run(root, claudePostBash(root, "cat src/gone.ts", TRANSCRIPT)).stdout).toBe("");
  });
});

describe("post-read stays silent", () => {
  test("no read, no rows, outside, sensitive, no store, a bad store or no transcript: empty stdout, exit 0", () => {
    const { root } = seeded();
    seedMemory(root, [{ title: "Env", filesRead: [".env"] }]);
    const bare = makeCrankProject({ "src/a.ts": "a\n" });
    const garbage = makeCrankProject({ "src/a.ts": "a\n" });
    plantMemory(garbage, "unreadable");
    const noTranscript: Record<string, unknown> = {
      ...claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT),
    };
    delete noTranscript.transcript_path;
    const cases: Array<[string, string, object]> = [
      ["grep", root, claudePostBash(root, "grep foo src/a.ts", TRANSCRIPT)],
      ["no rows", root, claudePostBash(root, "cat src/b.ts", TRANSCRIPT)],
      ["outside", root, claudePostRead(root, "/elsewhere/a.ts", TRANSCRIPT)],
      [".env", root, claudePostRead(root, path.join(root, ".env"), TRANSCRIPT)],
      ["no store", bare, claudePostRead(bare, path.join(bare, "src/a.ts"), TRANSCRIPT)],
      ["text store", garbage, claudePostRead(garbage, path.join(garbage, "src/a.ts"), TRANSCRIPT)],
      ["no transcript", root, noTranscript],
    ];
    for (const [name, cwd, payload] of cases) {
      const r = run(cwd, payload);
      expect([name, r.status, r.stdout]).toEqual([name, 0, ""]);
    }
    expect(fs.existsSync(path.join(bare, ".crank/memory.db"))).toBe(false);
  });
});

describe("post-read under both runtimes", () => {
  test("node and bun print the same history from a store with no -wal or -shm", () => {
    const { root } = seeded();
    const db = path.join(root, ".crank/memory.db");
    const sidecars = () => [fs.existsSync(`${db}-wal`), fs.existsSync(`${db}-shm`)];
    expect(sidecars()).toEqual([false, false]);
    const input = JSON.stringify(claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT));
    const viaNode = spawnSync(
      "node",
      ["--disable-warning=ExperimentalWarning", path.join(REPO_ROOT, HOOK)],
      {
        input,
        encoding: "utf-8",
        env: { ...process.env, CRANK_HOME: makeCrankHome() },
      },
    );
    expect(sidecars()).toEqual([false, false]);
    const viaBun = runHook(HOOK, input, root, { CRANK_HOME: makeCrankHome() });
    expect([viaNode.status, viaBun.status]).toEqual([0, 0]);
    expect(viaNode.stdout).not.toBe("");
    expect(viaNode.stdout).toBe(viaBun.stdout);
  });
});

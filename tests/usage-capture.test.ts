import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cleanup,
  childEnv,
  git,
  gitCommit,
  hookContext,
  makeCrankHome,
  makeCrankProject,
  plantMemory,
  REPO_ROOT,
  runCli,
  runHook,
  seedMemory,
  tempDir,
} from "./helpers.ts";
import { RECALL_BULLET } from "../src/hooks/lib/injection.ts";
import {
  claudePostBash,
  claudePostRead,
  claudeSessionStart,
  claudeSubagentStart,
  codexSessionStart,
} from "./fixtures/payloads.ts";
import {
  CLAUDE_SHELL,
  claudeCli,
  HOOK,
  lineCount,
  printedIds,
  READ_HOOK,
  SUBAGENT_HOOK,
  THREE,
  TRANSCRIPT,
  usageLines,
} from "./fixtures/usage-lines.ts";

afterEach(cleanup);

function sessionStart(root: string, payload: object, cwd = root) {
  return runHook(HOOK, JSON.stringify(payload), cwd, { CRANK_HOME: makeCrankHome() });
}

type Ran = { status: number | null; stdout: string; stderr: string };

/** Each run in `unwritable` exits 0 and prints what the run at its index in `written` printed. */
function expectSameOutput(written: Ran[], unwritable: Ran[]): void {
  for (const [i, a] of written.entries()) {
    const b = unwritable[i]!;
    expect([a.status, b.status]).toEqual([0, 0]);
    expect(a.stdout).not.toBe("");
    expect(b.stdout).toBe(a.stdout);
    expect(b.stderr).toBe(a.stderr);
  }
}

/** A commit-mode main checkout with a linked worktree beside it. */
function commitModeProject(): { root: string; worktree: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crank-usage-git-"));
  const root = path.join(tmp, "main");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  git(root, "init", "-q");
  expect(runCli(root, ["init", "--git", "commit", "--yes", "--codex", "skip"]).status).toBe(0);
  gitCommit(root, "init");
  const worktree = path.join(tmp, "wt");
  git(root, "worktree", "add", "-q", worktree);
  return { root, worktree };
}

describe("usage capture: the session-start line", () => {
  test("a Claude SessionStart records what its injection showed", () => {
    const root = makeCrankProject({ "docs/adr/0001-x.md": "# X\n" });
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n- p1\n\n## Memory\n- m1\n- m2\n",
    );
    const seeded = seedMemory(root, [{ title: "one" }, { title: "two" }, { title: "three" }]);
    const before = Date.now();
    const run = sessionStart(root, claudeSessionStart(root));
    const ctx = hookContext(run);
    expect(ctx).toContain("## Cerebrum (.crank/cerebrum.md)");
    expect(ctx).toContain("## ADRs (");

    const lines = usageLines(root);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.ts).toBeGreaterThanOrEqual(before);
    expect(line.ts).toBeLessThanOrEqual(Date.now());
    expect(line).toEqual({
      v: 1,
      ts: line.ts,
      agent: "claude",
      session: "a46b6073-1111-2222-3333-444455556666",
      channel: "session-start",
      source: "startup",
      ids: [...seeded].reverse(),
      nextSteps: false,
      cerebrum: true,
      adrs: true,
      cerebrumBullets: { shown: 3, total: 3 },
      bytes: Buffer.byteLength(ctx, "utf-8"),
      budget: 8192,
      notes: ctx.split("_Note: ").length - 1,
      recallPointer: ctx.includes(RECALL_BULLET),
    });
    expect(line.ids).toEqual([...ctx.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1])));
  });

  test("without cerebrum.md the line records no cerebrum; a bullet-less one counts zero", () => {
    const bare = makeCrankProject();
    fs.rmSync(path.join(bare, ".crank/cerebrum.md"));
    const bareRun = sessionStart(bare, claudeSessionStart(bare));
    expect(bareRun.status).toBe(0);
    expect(hookContext(bareRun)).not.toContain(RECALL_BULLET);
    const [noFile] = usageLines(bare);
    expect(noFile!.recallPointer).toBe(false);
    expect(noFile!.cerebrum).toBe(false);
    expect(noFile!.cerebrumBullets).toBeNull();
    expect(noFile!.ids).toEqual([]);

    const template = makeCrankProject();
    expect(sessionStart(template, claudeSessionStart(template)).status).toBe(0);
    const [blank] = usageLines(template);
    expect(blank!.cerebrum).toBe(false);
    expect(blank!.cerebrumBullets).toEqual({ shown: 0, total: 0 });

    const empty = makeCrankProject();
    fs.writeFileSync(path.join(empty, ".crank/cerebrum.md"), "");
    expect(sessionStart(empty, claudeSessionStart(empty)).status).toBe(0);
    const [emptyLine] = usageLines(empty);
    expect(emptyLine!.cerebrum).toBe(false);
    expect(emptyLine!.cerebrumBullets).toBeNull();
  });

  test("a Codex SessionStart records agent codex, and a session id that is not a string records a null session", () => {
    const root = makeCrankProject();
    const payload = codexSessionStart(root);
    expect(payload.turn_id).toBeUndefined();
    expect(sessionStart(root, payload).status).toBe(0);
    const [line] = usageLines(root);
    expect(line!.agent).toBe("codex");
    expect(line!.session).toBe("019f6e07-aaaa-bbbb-cccc-ddddeeeeffff");

    const odd = makeCrankProject();
    const oddPayload = { ...claudeSessionStart(odd), session_id: 42, source: undefined };
    expect(sessionStart(odd, oddPayload).status).toBe(0);
    const [oddLine] = usageLines(odd);
    expect(oddLine!.session).toBeNull();
    expect(oddLine!.source).toBeNull();
  });

  test("a SessionStart that returns before emitting writes no line", () => {
    const root = makeCrankProject();
    const garbled = runHook(HOOK, "not json", root, { CRANK_HOME: makeCrankHome() });
    expect(garbled.status).toBe(0);
    expect(garbled.stdout).toBe("");
    expect(fs.existsSync(path.join(root, ".crank/usage.jsonl"))).toBe(false);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crank-outside-"));
    const homeless = sessionStart(outside, claudeSessionStart(outside));
    expect(homeless.status).toBe(0);
    expect(homeless.stdout).toBe("");
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

function subagentStart(root: string, payload: object) {
  return runHook(SUBAGENT_HOOK, JSON.stringify(payload), root, { CRANK_HOME: makeCrankHome() });
}

function postRead(root: string, payload: object, home = makeCrankHome()) {
  return runHook(READ_HOOK, JSON.stringify(payload), root, { CRANK_HOME: home });
}

describe("usage capture: the subagent-start line", () => {
  test("a SubagentStart records its agent type, excerpt bytes and recall pointer", () => {
    const root = makeCrankProject();
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n- p1\n\n## Memory\n- m1\n",
    );
    seedMemory(root, [{ title: "one" }]);
    const run = subagentStart(root, claudeSubagentStart(root, "Explore"));
    expect(run.status).toBe(0);
    const ctx = hookContext(run);
    const excerpt = ctx.slice(ctx.indexOf("\n\n") + 2);
    expect(excerpt).toContain("- p1");
    const lines = usageLines(root);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      v: 1,
      ts: lines[0]!.ts,
      agent: "claude",
      session: "5195319c-1111-2222-3333-444455556666",
      channel: "subagent-start",
      agentType: "Explore",
      excerptBytes: Buffer.byteLength(excerpt, "utf-8"),
      recallPointer: true,
    });
    expect(ctx.includes(RECALL_BULLET)).toBe(true);
  });

  test("a bullet-less cerebrum records no excerpt bytes; a missing agent type records null", () => {
    const template = makeCrankProject();
    expect(subagentStart(template, claudeSubagentStart(template)).status).toBe(0);
    const [blank] = usageLines(template);
    expect(blank!.excerptBytes).toBe(0);
    expect(blank!.agentType).toBe("general-purpose");
    expect(blank!.recallPointer).toBe(false);

    const recalled = makeCrankProject();
    fs.rmSync(path.join(recalled, ".crank/cerebrum.md"));
    seedMemory(recalled, [{ title: "one" }]);
    expect(subagentStart(recalled, claudeSubagentStart(recalled, "Explore")).status).toBe(0);
    const [noFile] = usageLines(recalled);
    expect(noFile!.excerptBytes).toBe(0);
    expect(noFile!.recallPointer).toBe(true);

    const unreadable = makeCrankProject();
    const cerebrum = path.join(unreadable, ".crank/cerebrum.md");
    fs.rmSync(cerebrum);
    fs.mkdirSync(cerebrum); // the read fails with EISDIR
    expect(subagentStart(unreadable, claudeSubagentStart(unreadable, "Explore")).status).toBe(0);
    const [dir] = usageLines(unreadable);
    expect(dir!.excerptBytes).toBe(0);
    expect(dir!.recallPointer).toBe(false);

    const untyped = makeCrankProject();
    const payload = claudeSubagentStart(untyped);
    delete payload.agent_type;
    expect(subagentStart(untyped, payload).status).toBe(0);
    const [line] = usageLines(untyped);
    expect(line!.agentType).toBeNull();
  });
});

describe("usage capture: the file-history line", () => {
  test("a Read records the history it added, then the path as seen; a Bash read records an empty path", () => {
    const root = makeCrankProject({
      "a.ts": "export const a = 1;\n",
      "b.ts": "export const b = 1;\n",
    });
    const seeded = seedMemory(root, [
      { title: "one", filesRead: ["a.ts"] },
      { title: "two", filesRead: ["a.ts"] },
    ]);
    const home = makeCrankHome();
    const first = postRead(root, claudePostRead(root, path.join(root, "a.ts"), TRANSCRIPT), home);
    expect(first.status).toBe(0);
    const ctx = hookContext(first);
    const again = postRead(root, claudePostRead(root, path.join(root, "a.ts"), TRANSCRIPT), home);
    expect(again.stdout).toBe("");
    const bash = postRead(
      root,
      claudePostBash(
        root,
        "cat b.ts ~/.crank/projects.json missing.ts; head -n 300 b.ts",
        TRANSCRIPT,
      ),
      home,
    );
    expect(bash.stdout).toBe("");

    const lines = usageLines(root);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({
      v: 1,
      ts: lines[0]!.ts,
      agent: "claude",
      session: "551be959-1111-2222-3333-444455556666",
      channel: "file-history",
      tool: "Read",
      shown: [{ path: "a.ts", ids: [...seeded].reverse() }],
      empty: [],
      seen: [],
      cut: [],
      bytes: Buffer.byteLength(ctx, "utf-8"),
    });
    expect(lines[0]!.shown[0].ids).toEqual(
      [...ctx.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1])),
    );
    expect(lines[1]).toMatchObject({ tool: "Read", shown: [], seen: ["a.ts"], bytes: 0 });
    expect(lines[2]).toMatchObject({ tool: "Bash", empty: ["b.ts"], bytes: 0 });
    const before = lineCount(root);
    const missing = postRead(
      root,
      claudePostRead(root, path.join(root, "nope.ts"), TRANSCRIPT),
      home,
    );
    expect([missing.status, missing.stdout]).toEqual([0, ""]);
    expect(lineCount(root)).toBe(before);
  });
});

describe("usage capture: the file-history cap", () => {
  test("the paths the 1,536-byte cap stopped are recorded as cut, in command order, and a list keeps its first 100 entries", () => {
    const files = ["f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts", "f6.ts"];
    const root = makeCrankProject(Object.fromEntries(files.map((f) => [f, "x\n"])));
    seedMemory(
      root,
      files.flatMap((f) =>
        Array.from({ length: 5 }, (_, i) => ({
          title: `${f} ${i} `.padEnd(120, "t"),
          filesRead: [f],
        })),
      ),
    );
    const run = postRead(root, claudePostBash(root, `cat ${files.join(" ")}`, TRANSCRIPT));
    expect(run.status).toBe(0);
    const [line] = usageLines(root);
    const shown = line!.shown.map((s: { path: string }) => s.path);
    expect(shown.length + line!.cut.length).toBe(6);
    expect(line!.cut.length).toBeGreaterThanOrEqual(1);
    expect(shown).toEqual(files.slice(0, shown.length));
    expect(line!.cut).toEqual(files.slice(shown.length));
    expect(line!.bytes).toBeLessThanOrEqual(1536);
    expect(line!.bytes).toBe(Buffer.byteLength(hookContext(run), "utf-8"));

    const paths = Array.from({ length: 150 }, (_, i) => `p${i}.ts`);
    const wide = makeCrankProject(Object.fromEntries(paths.map((p) => [p, "x\n"])));
    seedMemory(wide, [{ title: "one", filesRead: ["other.ts"] }]);
    const listRun = postRead(wide, claudePostBash(wide, `cat ${paths.join(" ")}`, TRANSCRIPT));
    expect(listRun.status).toBe(0);
    const [wideLine] = usageLines(wide);
    expect(wideLine!.empty).toEqual(paths.slice(0, 100));
  });
});

describe("usage capture: post-read early returns", () => {
  test("a PostToolUse that returns before the store opens writes no line", () => {
    const root = makeCrankProject({ "a.ts": "a\n" });
    seedMemory(root, [{ title: "one", filesRead: ["a.ts"] }]);
    const bare = makeCrankProject({ "a.ts": "a\n" });
    const newer = makeCrankProject({ "a.ts": "a\n" });
    plantMemory(newer, "newer");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crank-outside-"));
    const noStem = claudePostRead(root, path.join(root, "a.ts"), TRANSCRIPT);
    delete noStem.transcript_path;

    const runs = [
      runHook(READ_HOOK, "not json", root, { CRANK_HOME: makeCrankHome() }),
      postRead(root, claudePostBash(root, "grep foo a.ts", TRANSCRIPT)),
      postRead(outside, claudePostRead(outside, path.join(outside, "a.ts"), TRANSCRIPT)),
      postRead(root, noStem),
      postRead(root, claudePostBash(root, "cat .env /elsewhere/a.ts", TRANSCRIPT)),
      postRead(bare, claudePostRead(bare, path.join(bare, "a.ts"), TRANSCRIPT)),
      postRead(newer, claudePostRead(newer, path.join(newer, "a.ts"), TRANSCRIPT)),
    ];
    expect(runs.map((r) => [r.status, r.stdout])).toEqual(runs.map(() => [0, ""]));
    for (const project of [root, bare, newer]) {
      expect(fs.existsSync(path.join(project, ".crank/usage.jsonl"))).toBe(false);
    }
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe("usage capture: rotation, failure and placement", () => {
  test("an append past 4 MiB first rotates usage.jsonl, replacing the older rotation", () => {
    const root = makeCrankProject();
    const padding = "x".repeat(4 * 1024 * 1024 - 10) + "\n";
    fs.writeFileSync(path.join(root, ".crank/usage.jsonl"), padding);
    fs.writeFileSync(path.join(root, ".crank/usage.1.jsonl"), "old\n");
    expect(sessionStart(root, claudeSessionStart(root)).status).toBe(0);
    expect(fs.readFileSync(path.join(root, ".crank/usage.1.jsonl"), "utf-8")).toBe(padding);
    const lines = usageLines(root);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.v).toBe(1);
  });

  test("concurrent writers at the 4 MiB mark rotate once and keep every line", async () => {
    const root = makeCrankProject();
    const padding = "x".repeat(4 * 1024 * 1024 - 10) + "\n";
    fs.writeFileSync(path.join(root, ".crank/usage.jsonl"), padding);
    const at = String(Date.now() + 1000);
    const children = Array.from({ length: 8 }, (_, n) =>
      Bun.spawn(["bun", path.join(REPO_ROOT, "tests/fixtures/usage-writer.ts"), root, `${n}`, at], {
        env: childEnv(),
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    expect(await Promise.all(children.map((c) => c.exited))).toEqual(Array(8).fill(0));
    const rotated = fs.readFileSync(path.join(root, ".crank/usage.1.jsonl"), "utf-8");
    expect(rotated.startsWith(padding)).toBe(true);
    const lines = [
      ...rotated
        .slice(padding.length)
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
      ...usageLines(root),
    ];
    expect(lines.map((l) => l.requested[0]).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const line of lines) expect(line).toMatchObject({ v: 1, channel: "get" });
  });

  test("a usage line that cannot be written changes neither SessionStart's, SubagentStart's nor post-read's output", () => {
    const root = makeCrankProject({ "a.ts": "export const a = 1;\n" });
    seedMemory(root, [{ title: "one", filesRead: ["a.ts"] }]);
    const usage = path.join(root, ".crank/usage.jsonl");
    const home = makeCrankHome();
    const both = () => [
      runHook(HOOK, JSON.stringify(claudeSessionStart(root)), root, { CRANK_HOME: home }),
      subagentStart(root, claudeSubagentStart(root, "Explore")),
      postRead(root, claudePostRead(root, path.join(root, "a.ts"), TRANSCRIPT)),
    ];
    both();
    fs.rmSync(usage);
    const written = both();
    expect(usageLines(root)).toHaveLength(3);
    fs.rmSync(usage);
    fs.mkdirSync(usage);
    const unwritable = both();
    expectSameOutput(written, unwritable);
  });

  test("a usage line that cannot be written changes neither search's nor outline's output", () => {
    const root = makeCrankProject({ "a.ts": THREE });
    seedMemory(root, [{ title: "Delta note" }]);
    const both = () => [claudeCli(root, ["search", "delta"]), claudeCli(root, ["outline", "a.ts"])];
    const written = both();
    expect(usageLines(root)).toHaveLength(2);
    fs.rmSync(path.join(root, ".crank/usage.jsonl"));
    fs.mkdirSync(path.join(root, ".crank/usage.jsonl"));
    const unwritable = both();
    expectSameOutput(written, unwritable);
  }, 30_000);

  test("a commit-mode linked worktree records into its main checkout's usage.jsonl", () => {
    const { root, worktree } = commitModeProject();
    expect(sessionStart(worktree, claudeSessionStart(worktree)).status).toBe(0);
    expect(usageLines(root)).toHaveLength(1);
    expect(fs.existsSync(path.join(worktree, ".crank/usage.jsonl"))).toBe(false);
  });

  test("in commit mode both usage files stay ignored, and --delete-crank deletes them", () => {
    const { root } = commitModeProject();
    expect(sessionStart(root, claudeSessionStart(root)).status).toBe(0);
    fs.writeFileSync(path.join(root, ".crank/usage.1.jsonl"), "{}\n");
    const status = git(root, "status", "--porcelain", "--ignored", ".crank");
    const naming = status.split("\n").filter((l) => /usage(\.1)?\.jsonl/.test(l));
    expect(naming.sort()).toEqual(["!! .crank/usage.1.jsonl", "!! .crank/usage.jsonl"]);
    expect(runCli(root, ["uninstall", "--yes", "--delete-crank"]).status).toBe(0);
    expect(fs.existsSync(path.join(root, ".crank/usage.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".crank/usage.1.jsonl"))).toBe(false);
  });
});

describe("usage capture: the search, timeline and get lines", () => {
  test("a search whose store opens records its flags, mode and hit ids", () => {
    const root = makeCrankProject({ "src/a.ts": "export const a = 1;\n" });
    seedMemory(root, [
      { type: "bugfix", title: "Alpha fix", filesModified: ["src/a.ts"] },
      { type: "bugfix", title: "Alpha other", filesModified: ["src/b.ts"] },
      { type: "decision", title: "Alpha decision", filesModified: ["src/a.ts"] },
    ]);
    const args = ["search", "Alpha", "--limit", "99", "--type", "bugfix", "--since", "2020-01-01"];
    const run = claudeCli(root, [...args, "--file", "src/a.ts", "--stale"]);
    expect(run.status).toBe(0);
    const ids = printedIds(run.stdout);
    expect(ids).toHaveLength(1);
    const [line] = usageLines(root);
    expect(line!.ms).toBeGreaterThanOrEqual(0);
    expect(line).toEqual({
      v: 1,
      ts: line!.ts,
      agent: "claude",
      session: "sess-1",
      channel: "search",
      query: "Alpha",
      limit: 50,
      type: "bugfix",
      since: "2020-01-01",
      file: "src/a.ts",
      stale: true,
      mode: "keyword",
      ids,
      ms: line!.ms,
    });

    expect(claudeCli(root, ["search", "Alpha"]).status).toBe(0);
    expect(usageLines(root)[1]).toMatchObject({
      limit: 10,
      type: null,
      since: null,
      file: null,
      stale: false,
    });
    expect(claudeCli(root, ["search", "zzz-none"])).toMatchObject({ status: 0, stdout: "" });
    expect(usageLines(root)[2]!.ids).toEqual([]);
    const key = "AKIA" + "IOSFODNN7EXAMPL" + "E";
    expect(claudeCli(root, ["search", `key ${key}`]).status).toBe(0);
    const redacted: string = usageLines(root)[3]!.query;
    expect(redacted.startsWith("key ")).toBe(true);
    expect(redacted).not.toContain(key);
    expect(claudeCli(root, ["search", "q".repeat(600)]).status).toBe(0);
    expect(usageLines(root)[4]!.query).toBe("q".repeat(500));
  }, 30_000);

  test("a search records its shell's actor, and writes no line before its store opens", () => {
    const root = makeCrankProject();
    seedMemory(root, [{ title: "Beta note" }]);
    runCli(root, ["search", "beta"], { CLAUDECODE: "", CLAUDE_CODE_SESSION_ID: "" });
    runCli(root, ["search", "beta"], { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "" });
    claudeCli(root, ["search", "beta", "--file", ".env"]);
    const lines = usageLines(root);
    expect(lines.map((l) => [l.agent, l.session])).toEqual([
      ["manual", null],
      ["claude", null],
      ["claude", "sess-1"],
    ]);
    expect(lines[2]!.file).toBeNull();

    const bare = makeCrankProject();
    expect(claudeCli(bare, ["search", "beta"]).status).toBe(0);
    const newer = makeCrankProject();
    plantMemory(newer, "newer");
    expect(claudeCli(newer, ["search", "beta"]).status).toBe(1);
    expect(claudeCli(root, ["search", ""]).status).toBe(1);
    expect(claudeCli(root, ["search", "beta", "--file", "/elsewhere/a.ts"]).status).toBe(0);
    expect([lineCount(bare), lineCount(newer), lineCount(root)]).toEqual([0, 0, 3]);
  }, 30_000);

  test("timeline and get record their anchor or ids and what they printed", () => {
    const root = makeCrankProject();
    const seeded = seedMemory(
      root,
      Array.from({ length: 6 }, (_, i) => ({ title: `Gamma ${i}` })),
    );
    const anchor = seeded[3]!;
    const timeline = claudeCli(root, ["timeline", String(anchor), "--depth", "2"]);
    expect(timeline.status).toBe(0);
    const unknown = claudeCli(root, ["timeline", "999"]);
    expect(unknown.status).toBe(1);
    const get = claudeCli(root, ["get", String(seeded[0]), String(seeded[1]), "999"]);
    expect(get.status).toBe(0);
    const many = Array.from({ length: 25 }, (_, i) => String(i + 1));
    expect(claudeCli(root, ["get", ...many]).status).toBe(0);

    const [t, u, g, m] = usageLines(root);
    const actor = { v: 1, agent: "claude", session: "sess-1" };
    expect(t).toEqual({
      ...actor,
      ts: t!.ts,
      channel: "timeline",
      anchor,
      depth: 2,
      ids: printedIds(timeline.stdout),
    });
    expect(t!.ids.length).toBeGreaterThan(1);
    expect(u).toEqual({
      ...actor,
      ts: u!.ts,
      channel: "timeline",
      anchor: 999,
      depth: 5,
      ids: null,
    });
    expect(g).toEqual({
      ...actor,
      ts: g!.ts,
      channel: "get",
      requested: [seeded[0], seeded[1], 999],
      found: [seeded[0], seeded[1]],
    });
    expect(printedIds(get.stdout)).toEqual([seeded[0]!, seeded[1]!]);
    expect(m!.requested).toEqual(many.slice(0, 20).map(Number));

    const bare = makeCrankProject();
    expect(claudeCli(bare, ["timeline", "1"]).status).toBe(1);
    expect(claudeCli(bare, ["get", "1"]).status).toBe(1);
    expect(claudeCli(root, ["timeline", "x"]).status).toBe(1);
    expect(claudeCli(root, ["get", "x"]).status).toBe(1);
    expect([lineCount(bare), lineCount(root)]).toEqual([0, 4]);
  }, 30_000);
});

describe("usage capture: the outline and unfold lines", () => {
  test("an outline records the rows it listed, its length and whether CAP cut it", () => {
    const many = Array.from({ length: 3000 }, (_, i) => `export function f${i}() {}\n`).join("");
    const root = makeCrankProject({ "a.ts": THREE, "src/many.ts": many });
    const run = claudeCli(root, ["outline", "a.ts"]);
    expect(run.status).toBe(0);
    const [line] = usageLines(root);
    expect(line!.ms).toBeGreaterThanOrEqual(0);
    expect(line).toEqual({
      v: 1,
      ts: line!.ts,
      agent: "claude",
      session: "sess-1",
      channel: "outline",
      path: "a.ts",
      from: null,
      matches: 3,
      chars: run.stdout.length,
      capped: false,
      outcome: "ok",
      ms: line!.ms,
    });

    const cut = claudeCli(root, ["outline", "src/many.ts"]);
    const rows = cut.stdout.split("\n").filter(Boolean);
    expect(rows.at(-1)).toMatch(/^… \d+ more symbols from L\d+/);
    const capped = usageLines(root)[1]!;
    expect(capped).toMatchObject({ path: "src/many.ts", capped: true, outcome: "ok" });
    expect(capped.matches).toBe(rows.length - 2);
    expect(capped.chars).toBe(cut.stdout.length);
  }, 30_000);

  test("unfold records its symbol and matches, and each refusal records its outcome", () => {
    const big = `export function big() {\n${"  const x = 1;\n".repeat(2200)}}\n`;
    const root = makeCrankProject({
      "a.ts": THREE,
      "big.ts": big,
      "notes.xyz": "notes\n",
      ".env": "SECRET=1\n",
    });
    fs.mkdirSync(path.join(root, "src/x.ts"), { recursive: true });
    const outside = path.join(tempDir("crank-usage-outside-"), "outside.ts");
    fs.writeFileSync(outside, THREE);
    const ok = claudeCli(root, ["unfold", "a.ts", "one"]);
    expect(ok.status).toBe(0);
    claudeCli(root, ["unfold", "big.ts", "big"]);
    claudeCli(root, ["unfold", "missing.ts", "x"]);
    claudeCli(root, ["unfold", "a.ts", "nope"]);
    claudeCli(root, ["outline", "notes.xyz"]);
    claudeCli(root, ["outline", path.relative(root, outside)]);
    claudeCli(root, ["outline", ".env"]);
    claudeCli(root, ["outline", "src/x.ts"]);
    claudeCli(root, ["outline", "a.ts", "--from", "2"]);
    const before = lineCount(root);
    expect(claudeCli(root, ["outline"]).status).toBe(1);
    expect(claudeCli(root, ["unfold", "a.ts"]).status).toBe(1);
    expect(lineCount(root)).toBe(before);

    const pick = (l: Record<string, any>) => ({
      channel: l.channel,
      path: l.path,
      ...(l.channel === "unfold" ? { symbol: l.symbol } : { from: l.from }),
      matches: l.matches,
      capped: l.capped,
      outcome: l.outcome,
    });
    const lines = usageLines(root);
    expect(lines[0]).toMatchObject({ chars: ok.stdout.length, agent: "claude" });
    expect(lines.map(pick)).toEqual([
      { channel: "unfold", path: "a.ts", symbol: "one", matches: 1, capped: false, outcome: "ok" },
      { channel: "unfold", path: "big.ts", symbol: "big", matches: 1, capped: true, outcome: "ok" },
      {
        channel: "unfold",
        path: "missing.ts",
        symbol: "x",
        matches: 0,
        capped: false,
        outcome: "not-found",
      },
      {
        channel: "unfold",
        path: "a.ts",
        symbol: "nope",
        matches: 0,
        capped: false,
        outcome: "not-found",
      },
      {
        channel: "outline",
        path: "notes.xyz",
        from: null,
        matches: 0,
        capped: false,
        outcome: "no-reader",
      },
      { channel: "outline", path: null, from: null, matches: 0, capped: false, outcome: "refused" },
      {
        channel: "outline",
        path: "src/x.ts",
        from: null,
        matches: 0,
        capped: false,
        outcome: "refused",
      },
      { channel: "outline", path: "a.ts", from: 2, matches: 2, capped: false, outcome: "ok" },
    ]);

    const bare = tempDir("crank-usage-bare-");
    expect(claudeCli(bare, ["outline", "a.ts"]).status).toBe(1);
    expect(fs.readdirSync(bare)).toEqual([]);
  }, 60_000);

  test("an outline without the code reader records no-reader", () => {
    const clone = tempDir("crank-clone-");
    for (const name of ["src", "bin", "package.json"])
      fs.cpSync(path.join(REPO_ROOT, name), path.join(clone, name), { recursive: true });
    fs.mkdirSync(path.join(clone, "node_modules"));
    const root = makeCrankProject({ "a.ts": THREE });
    const result = spawnSync(
      process.execPath,
      [path.join(clone, "src/cli/main.ts"), "outline", "a.ts"],
      {
        cwd: root,
        encoding: "utf-8",
        timeout: 30_000,
        env: childEnv({ ...CLAUDE_SHELL, CRANK_HOME: makeCrankHome() }),
      },
    );
    expect(result.status).toBe(1);
    expect(usageLines(root).map((l) => [l.path, l.matches, l.outcome])).toEqual([
      ["a.ts", 0, "no-reader"],
    ]);
  }, 30_000);
});

describe("usage capture: the graph commands", () => {
  test("anatomy, callers, callees and impact each record a line, and a miss, an ambiguous name and a refusal record their outcome", () => {
    const root = makeCrankProject({
      "src/x.ts": "export function f1() {}\nexport function f2() {}\n",
      "src/y.ts": 'import { f1 } from "./x";\nexport function useF1() {\n  f1();\n}\n',
      "src/a.ts": "export function save() {}\n",
      "src/b.ts": "export function save() {}\n",
      ".env": "SECRET=1\n",
    });
    const outside = path.join(tempDir("crank-usage-outside-"), "outside.ts");
    fs.writeFileSync(outside, "export const o = 1;\n");
    fs.symlinkSync(outside, path.join(root, "src/link.ts"));
    const runs = [
      claudeCli(root, ["anatomy"]),
      claudeCli(root, ["callers", "f1"]),
      claudeCli(root, ["callees", "useF1"]),
      claudeCli(root, ["impact", "f1"]),
      claudeCli(root, ["impact", "src/x.ts"]),
      claudeCli(root, ["callers", "src/x.ts", "nope"]),
      claudeCli(root, ["callees", "save"]),
      claudeCli(root, ["impact", ".env", "x"]),
      claudeCli(root, ["anatomy", "--from", ".env"]),
      claudeCli(root, ["anatomy", "src/link.ts"]),
      claudeCli(root, ["callers", "src/missing.ts", "x"]),
    ];
    expect(runs.map((r) => r.status)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1]);
    const before = lineCount(root);
    expect(claudeCli(root, ["callers"]).status).toBe(1);
    expect(claudeCli(root, ["impact", "f1", "--depth", "9"]).status).toBe(1);
    expect(claudeCli(root, ["anatomy", "a", "b"]).status).toBe(1);
    expect(lineCount(root)).toBe(before);

    const lines = usageLines(root);
    expect(lines).toHaveLength(runs.length);
    lines.forEach((line, i) => {
      expect(line).toMatchObject({ v: 1, agent: "claude", session: "sess-1", pending: 0 });
      expect(line.ms).toBeGreaterThanOrEqual(0);
      expect(line.chars).toBe(runs[i]!.stdout.length);
    });
    const pick = (l: Record<string, any>) => [
      l.channel,
      l.path,
      "symbol" in l ? l.symbol : l.from,
      l.matches,
      l.outcome,
    ];
    expect(lines.map(pick)).toEqual([
      ["anatomy", null, null, 4, "ok"],
      ["callers", null, "f1", 1, "ok"],
      ["callees", null, "useF1", 1, "ok"],
      ["impact", null, "f1", 1, "ok"],
      ["impact", "src/x.ts", null, 1, "ok"],
      ["callers", "src/x.ts", "nope", 0, "not-found"],
      ["callees", null, "save", 0, "refused"],
      ["impact", null, "x", 0, "refused"],
      ["anatomy", null, null, 4, "ok"],
      ["anatomy", "src/link.ts", null, 0, "refused"],
      ["callers", "src/missing.ts", "x", 0, "not-found"],
    ]);

    const bare = tempDir("crank-usage-bare-");
    expect(claudeCli(bare, ["callers", "f1"]).status).toBe(1);
    expect(fs.readdirSync(bare)).toEqual([]);
  }, 60_000);
});

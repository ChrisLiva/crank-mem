import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cleanup,
  git,
  gitCommit,
  makeCrankHome,
  makeCrankProject,
  plantMemory,
  projectId,
  REPO_ROOT,
  registeredProject,
  runCli,
  runHook,
  seedMemory,
  startDashboard,
  tempDir,
  ZONES,
} from "./helpers.ts";
import { RECALL_BULLET } from "../src/hooks/lib/injection.ts";
import {
  claudePostBash,
  claudePostRead,
  claudeSessionStart,
  claudeSubagentStart,
  codexSessionStart,
} from "./fixtures/payloads.ts";

afterEach(cleanup);

const HOOK = "src/hooks/session-start.ts";
const SUBAGENT_HOOK = "src/hooks/subagent-start.ts";
const READ_HOOK = "src/hooks/post-read.ts";
const TRANSCRIPT = "/u/.claude/projects/-proj/551be959.jsonl";

function sessionStart(root: string, payload: object, cwd = root) {
  return runHook(HOOK, JSON.stringify(payload), cwd, { CRANK_HOME: makeCrankHome() });
}

function usageLines(root: string): Array<Record<string, any>> {
  return fs
    .readFileSync(path.join(root, ".crank/usage.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The number of lines in the project's usage.jsonl, 0 when it is absent. */
function lineCount(root: string): number {
  const file = path.join(root, ".crank/usage.jsonl");
  return fs.existsSync(file) ? usageLines(root).length : 0;
}

/** The ids of a run's printed `#<id>` lines, in order. */
function printedIds(stdout: string): number[] {
  return [...stdout.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
}

const CLAUDE_SHELL = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "sess-1" };

/** A crank-mem command run from a Claude Code shell with session sess-1. */
function claudeCli(root: string, args: string[], env: Record<string, string> = {}) {
  return runCli(root, args, { ...CLAUDE_SHELL, ...env });
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
    expect(run.status).toBe(0);
    const ctx: string = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
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
    expect(sessionStart(bare, claudeSessionStart(bare)).status).toBe(0);
    const [noFile] = usageLines(bare);
    expect(noFile!.cerebrum).toBe(false);
    expect(noFile!.cerebrumBullets).toBeNull();
    expect(noFile!.ids).toEqual([]);

    const template = makeCrankProject();
    expect(sessionStart(template, claudeSessionStart(template)).status).toBe(0);
    const [blank] = usageLines(template);
    expect(blank!.cerebrum).toBe(false);
    expect(blank!.cerebrumBullets).toEqual({ shown: 0, total: 0 });
  });

  test("a session id that is not a string records a null session", () => {
    const root = makeCrankProject();
    const payload = { ...claudeSessionStart(root), session_id: 42, source: undefined };
    expect(sessionStart(root, payload).status).toBe(0);
    const [line] = usageLines(root);
    expect(line!.session).toBeNull();
    expect(line!.source).toBeNull();
  });

  test("a Codex SessionStart records agent codex", () => {
    const root = makeCrankProject();
    const payload = codexSessionStart(root) as Record<string, unknown>;
    expect(payload.turn_id).toBeUndefined();
    expect(sessionStart(root, payload).status).toBe(0);
    const [line] = usageLines(root);
    expect(line!.agent).toBe("codex");
    expect(line!.session).toBe("019f6e07-aaaa-bbbb-cccc-ddddeeeeffff");
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

function additionalContext(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
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
    const ctx = additionalContext(run.stdout);
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

    const untyped = makeCrankProject();
    const payload = claudeSubagentStart(untyped) as Record<string, unknown>;
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
    const ctx = additionalContext(first.stdout);
    const again = postRead(root, claudePostRead(root, path.join(root, "a.ts"), TRANSCRIPT), home);
    expect(again.stdout).toBe("");
    const bash = postRead(root, claudePostBash(root, "cat b.ts", TRANSCRIPT), home);
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
  });
});

describe("usage capture: the file-history cap", () => {
  test("the paths the 1,536-byte cap stopped are recorded as cut, in command order", () => {
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
    expect(line!.bytes).toBe(Buffer.byteLength(additionalContext(run.stdout), "utf-8"));
  });
});

describe("usage capture: the 100-entry list cap", () => {
  test("a line keeps the first 100 entries of a list, in order", () => {
    const root = makeCrankProject();
    seedMemory(root, [{ title: "one", filesRead: ["other.ts"] }]);
    const paths = Array.from({ length: 150 }, (_, i) => `p${i}.ts`);
    const run = postRead(root, claudePostBash(root, `cat ${paths.join(" ")}`, TRANSCRIPT));
    expect(run.status).toBe(0);
    const [line] = usageLines(root);
    expect(line!.empty).toEqual(paths.slice(0, 100));
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
    const noStem = claudePostRead(root, path.join(root, "a.ts"), TRANSCRIPT) as Record<
      string,
      unknown
    >;
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

  test("a line that cannot be written changes neither output nor exit status", () => {
    const root = makeCrankProject({ "src/a.ts": "export const a = 1;\n" });
    const home = makeCrankHome();
    const stdin = JSON.stringify(claudeSessionStart(root));
    runHook(HOOK, stdin, root, { CRANK_HOME: home });
    const a = runHook(HOOK, stdin, root, { CRANK_HOME: home });
    fs.rmSync(path.join(root, ".crank/usage.jsonl"), { force: true });
    fs.mkdirSync(path.join(root, ".crank/usage.jsonl"));
    const b = runHook(HOOK, stdin, root, { CRANK_HOME: home });
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(b.stdout).toBe(a.stdout);
    expect(b.stderr).toBe(a.stderr);
  });

  test("a usage line that cannot be written changes neither SubagentStart's nor post-read's output", () => {
    const root = makeCrankProject({ "a.ts": "export const a = 1;\n" });
    seedMemory(root, [{ title: "one", filesRead: ["a.ts"] }]);
    const usage = path.join(root, ".crank/usage.jsonl");
    const both = () => [
      subagentStart(root, claudeSubagentStart(root, "Explore")),
      postRead(root, claudePostRead(root, path.join(root, "a.ts"), TRANSCRIPT)),
    ];
    const written = both();
    expect(usageLines(root)).toHaveLength(2);
    fs.rmSync(usage);
    fs.mkdirSync(usage);
    const unwritable = both();
    for (const [i, a] of written.entries()) {
      const b = unwritable[i]!;
      expect([a.status, b.status]).toEqual([0, 0]);
      expect(a.stdout).not.toBe("");
      expect(b.stdout).toBe(a.stdout);
      expect(b.stderr).toBe(a.stderr);
    }
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
    for (const [i, a] of written.entries()) {
      const b = unwritable[i]!;
      expect([a.status, b.status]).toEqual([0, 0]);
      expect(a.stdout).not.toBe("");
      expect(b.stdout).toBe(a.stdout);
      expect(b.stderr).toBe(a.stderr);
    }
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
    expect(claudeCli(root, ["search", "zzz-none"]).stdout).toBe("");
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

const THREE = "export function one() {}\nexport function two() {}\nexport function three() {}\n";

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
        env: { ...process.env, ...CLAUDE_SHELL, CRANK_HOME: makeCrankHome() },
      },
    );
    expect(result.status).toBe(1);
    expect(usageLines(root).map((l) => [l.path, l.matches, l.outcome])).toEqual([
      ["a.ts", 0, "no-reader"],
    ]);
  }, 30_000);
});

const D = 86_400_000;
const X = 999_999;
const CHANNELS = [
  "file-history",
  "get",
  "outline",
  "search",
  "session-start",
  "subagent-start",
  "timeline",
  "unfold",
];
const SEARCH = {
  limit: 10,
  type: null,
  since: null,
  file: null,
  stale: false,
  ms: 1,
  mode: "keyword",
};

function searchLine(
  ts: number,
  agent: string,
  session: string | null,
  query: string,
  ids: number[],
) {
  return { v: 1, ts, agent, session, channel: "search", ...SEARCH, query, ids };
}

/** Write `entries` to the project's usage file, objects as JSON lines and strings as they are. */
function writeLog(root: string, entries: Array<object | string>, file = "usage.jsonl"): void {
  const text = entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e)) + "\n").join("");
  fs.writeFileSync(path.join(root, ".crank", file), text);
}

/** The window journey's lines, from `now`, over the ids A, B and C. */
function windowLines(now: number, [A, B, C]: number[]) {
  const L1 = { ...searchLine(now - 3 * D, "claude", "s1", "Foo  Bar ", [A!, B!]), mode: "hybrid" };
  const L2 = {
    v: 1,
    ts: now - 3 * D + 300_000,
    agent: "claude",
    session: "s1",
    channel: "get",
    requested: [B],
    found: [B],
  };
  const L3 = searchLine(now - 3 * D + 60_000, "manual", null, "manual q", [A!]);
  const L4 = searchLine(now - 20 * D, "claude", "s2", "foo bar", []);
  const L5 = {
    v: 1,
    ts: now - 20 * D,
    agent: "claude",
    session: "s2",
    channel: "session-start",
    source: "startup",
    ids: [A, C, X],
    nextSteps: false,
    cerebrum: false,
    adrs: false,
    cerebrumBullets: null,
    bytes: 1,
    budget: 8192,
    notes: 0,
    recallPointer: false,
  };
  const L6 = searchLine(now - 60 * D, "claude", "s3", "baz", [C!]);
  const L7 = {
    v: 1,
    ts: now - 60 * D,
    agent: "claude",
    session: "s3",
    channel: "file-history",
    tool: "Read",
    shown: [{ path: "a.ts", ids: [A] }],
    empty: ["b.ts"],
    seen: [],
    cut: [],
    bytes: 1,
  };
  const L8 = searchLine(now - 100 * D, "claude", "s4", "old", [A!]);
  return {
    L1,
    L2,
    L3,
    L4,
    L5,
    L6,
    L7,
    L8,
    log: [L1, L2, L3, L4, L5, L6, L7, L8, "not json", { ...L1, v: 2 }],
  };
}

const TITLES = ["Alpha one", "Bravo two", "Charlie three", "Delta four"];

/** A registered project on `home` with four observations and the window journey's log. */
function windowProject(home: string) {
  const root = registeredProject(home);
  const ids = seedMemory(
    root,
    TITLES.map((title) => ({ title })),
  );
  const lines = windowLines(Date.now(), ids);
  writeLog(root, lines.log);
  return { root, ids, lines };
}

type Dashboard = Awaited<ReturnType<typeof startDashboard>>;

async function usageOf(dash: Dashboard, root: string, query: string): Promise<Record<string, any>> {
  const res = await dash.get(`/api/projects/${projectId(root)}/usage?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

/** Each channel's count summed over `perDay`. */
function totals(body: Record<string, any>): Record<string, number> {
  const sum: Record<string, number> = {};
  for (const day of body.perDay) {
    for (const [channel, n] of Object.entries(day.counts as Record<string, number>)) {
      sum[channel] = (sum[channel] ?? 0) + n;
    }
  }
  return sum;
}

function channelCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(CHANNELS.map((c) => [c, counts[c] ?? 0]));
}

describe("usage window: the usage endpoint aggregates the log", () => {
  for (const zone of ZONES) {
    test(`days 7, 30 and 90, agent runs only and with manual runs, in ${zone}`, async () => {
      const home = makeCrankHome();
      const { root, ids, lines } = windowProject(home);
      const [A, B, C] = ids as [number, number, number];
      const { L1, L2, L3, L4 } = lines;
      const title = (id: number) => TITLES[ids.indexOf(id)]!;
      const dash = await startDashboard(home, ["--port", "0"], { env: { TZ: zone } });
      const local = new Intl.DateTimeFormat("en-CA", { timeZone: zone });

      const week = await usageOf(dash, root, "days=7&manual=0");
      expect(week.perDay).toHaveLength(7);
      const dates: string[] = week.perDay.map((d: { date: string }) => d.date);
      expect(dates.at(-1)).toBe(local.format(Date.now()));
      expect([...new Set(dates)].sort()).toEqual(dates);
      for (const day of week.perDay) expect(Object.keys(day.counts).sort()).toEqual(CHANNELS);
      const on = (ts: number) =>
        week.perDay.find((d: { date: string }) => d.date === local.format(ts));
      expect(on(L1.ts).counts.search).toBe(1);
      expect(on(L2.ts).counts.get).toBe(1);
      expect(totals(week)).toEqual(channelCounts({ search: 1, get: 1 }));
      expect(week).toMatchObject({
        days: 7,
        searches: 1,
        zeroResultShare: 0,
        keywordShare: 0,
        followThrough: 1,
        topQueries: [
          {
            query: "foo bar",
            count: 1,
            lastMs: L1.ts,
            meanResults: 2,
            runs: [{ ts: L1.ts, ids: [A, B] }],
          },
        ],
        neverSurfacedShare: 0.5,
        observationCount: 4,
        sessionStarts: 0,
      });
      expect(week.surfaced).toEqual([
        { id: B, count: 2, title: title(B) },
        { id: A, count: 1, title: title(A) },
      ]);

      const manual = await usageOf(dash, root, "days=7&manual=1");
      expect(manual).toMatchObject({ searches: 2, keywordShare: 0.5, followThrough: 1 });
      expect(manual.topQueries).toEqual([
        {
          query: "manual q",
          count: 1,
          lastMs: L3.ts,
          meanResults: 1,
          runs: [{ ts: L3.ts, ids: [A] }],
        },
        week.topQueries[0],
      ]);
      expect(manual.surfaced).toEqual([
        { id: B, count: 2, title: title(B) },
        { id: A, count: 2, title: title(A) },
      ]);

      const month = await usageOf(dash, root, "days=30&manual=0");
      expect(month.perDay).toHaveLength(30);
      expect(month).toMatchObject({
        searches: 2,
        zeroResultShare: 0.5,
        keywordShare: 0.5,
        followThrough: 1,
        sessionStarts: 1,
        neverSurfacedShare: 0.25,
      });
      expect(month.topQueries).toEqual([
        {
          query: "foo bar",
          count: 2,
          lastMs: L1.ts,
          meanResults: 1,
          runs: [
            { ts: L1.ts, ids: [A, B] },
            { ts: L4.ts, ids: [] },
          ],
        },
      ]);
      expect(month.surfaced).toEqual([
        { id: B, count: 2, title: title(B) },
        { id: A, count: 2, title: title(A) },
        { id: X, count: 1, title: "(deleted)" },
        { id: C, count: 1, title: title(C) },
      ]);

      const quarter = await usageOf(dash, root, "days=90&manual=0");
      expect(quarter.perDay).toHaveLength(90);
      expect(quarter.searches).toBe(3);
      expect(quarter.zeroResultShare).toBeCloseTo(1 / 3);
      expect(quarter.keywordShare).toBeCloseTo(2 / 3);
      expect(quarter.followThrough).toBe(0.5);
      expect(
        quarter.topQueries.map((q: { query: string; count: number }) => [q.query, q.count]),
      ).toEqual([
        ["foo bar", 2],
        ["baz", 1],
      ]);
      expect(quarter.surfaced.map((s: { id: number; count: number }) => [s.id, s.count])).toEqual([
        [A, 3],
        [C, 2],
        [B, 2],
        [X, 1],
      ]);
      expect(quarter.neverSurfacedShare).toBe(0.25);
      expect(quarter.topFiles).toEqual([{ path: "a.ts", count: 1 }]);
      expect(quarter.filesWithoutMemory).toEqual([{ path: "b.ts", count: 1 }]);
      expect(totals(quarter)).toEqual(
        channelCounts({ search: 3, get: 1, "session-start": 1, "file-history": 1 }),
      );
    }, 30_000);
  }

  test("a bad days or manual gets 400, and a missing manual means 0", async () => {
    const home = makeCrankHome();
    const { root } = windowProject(home);
    const dash = await startDashboard(home, ["--port", "0"]);
    const id = projectId(root);
    for (const query of [
      "manual=0",
      "days=5",
      "days=abc",
      "days=toString",
      "days=7&manual=2",
      "days=7&manual=x",
    ]) {
      expect([query, (await dash.get(`/api/projects/${id}/usage?${query}`)).status]).toEqual([
        query,
        400,
      ]);
    }
    expect(await usageOf(dash, root, "days=7")).toEqual(
      await usageOf(dash, root, "days=7&manual=0"),
    );
  }, 20_000);

  test("a missing usage log answers zero counts and null shares", async () => {
    const home = makeCrankHome();
    const root = registeredProject(home);
    seedMemory(
      root,
      TITLES.map((title) => ({ title })),
    );
    const dash = await startDashboard(home, ["--port", "0"]);
    const body = await usageOf(dash, root, "days=7");
    expect(body.perDay).toHaveLength(7);
    for (const day of body.perDay) expect(day.counts).toEqual(channelCounts({}));
    expect(body).toEqual({
      days: 7,
      manual: false,
      perDay: body.perDay,
      searches: 0,
      zeroResultShare: null,
      keywordShare: null,
      followThrough: null,
      topQueries: [],
      surfaced: [],
      neverSurfacedShare: 1,
      observationCount: 4,
      topFiles: [],
      filesWithoutMemory: [],
      sessionStarts: 0,
      subagentStarts: 0,
      outlines: 0,
      unfolds: 0,
      cappedShare: null,
    });
  }, 20_000);

  test("a store that does not open still answers the log's metrics, with no titles", async () => {
    const home = makeCrankHome();
    const { root } = windowProject(home);
    const newer = registeredProject(home);
    plantMemory(newer, "newer");
    const missing = registeredProject(home);
    for (const other of [newer, missing]) {
      fs.copyFileSync(
        path.join(root, ".crank/usage.jsonl"),
        path.join(other, ".crank/usage.jsonl"),
      );
    }
    const dash = await startDashboard(home, ["--port", "0"]);
    const good = await usageOf(dash, root, "days=90&manual=0");
    const expected = {
      ...good,
      observationCount: 0,
      neverSurfacedShare: null,
      surfaced: good.surfaced.map((s: object) => ({ ...s, title: "(deleted)" })),
    };
    expect(await usageOf(dash, newer, "days=90&manual=0")).toEqual(expected);
    expect(await usageOf(dash, missing, "days=90&manual=0")).toEqual(expected);
  }, 20_000);

  test("the rotated file is read too, and a changed file is read again", async () => {
    const home = makeCrankHome();
    const { root, lines } = windowProject(home);
    const dash = await startDashboard(home, ["--port", "0"]);
    const whole = await usageOf(dash, root, "days=30&manual=0");
    expect(whole.searches).toBe(2);
    writeLog(root, [lines.L4], "usage.1.jsonl");
    writeLog(
      root,
      lines.log.filter((l) => l !== lines.L4),
    );
    expect(await usageOf(dash, root, "days=30&manual=0")).toEqual(whole);
    fs.appendFileSync(
      path.join(root, ".crank/usage.jsonl"),
      JSON.stringify(searchLine(Date.now() - 1000, "claude", "s5", "later", [])) + "\n",
    );
    expect((await usageOf(dash, root, "days=30&manual=0")).searches).toBe(3);
  }, 20_000);

  test("follow-through needs the same session within 30 minutes, and a query keeps its last 10 runs", async () => {
    const home = makeCrankHome();
    const root = registeredProject(home);
    const T = Date.now() - D;
    const actor = (session: string) => ({ v: 1, agent: "claude", session });
    writeLog(root, [
      searchLine(T, "claude", "s1", "one", [1]),
      { ...actor("s2"), ts: T + 60_000, channel: "get", requested: [1], found: [1] },
      searchLine(T + 7_200_000, "claude", "s1", "two", [2]),
      { ...actor("s1"), ts: T + 9_060_000, channel: "get", requested: [2], found: [2] },
      searchLine(T + 14_400_000, "claude", "s1", "three", [3]),
      { ...actor("s1"), ts: T + 16_140_000, channel: "timeline", anchor: 3, depth: 5, ids: [3] },
      ...Array.from({ length: 11 }, (_, i) =>
        searchLine(T + 18_000_000 + i, "claude", null, "again", []),
      ),
    ]);
    const dash = await startDashboard(home, ["--port", "0"]);
    const body = await usageOf(dash, root, "days=7&manual=0");
    expect(body.followThrough).toBeCloseTo(1 / 3);
    const again = body.topQueries.find((q: { query: string }) => q.query === "again");
    expect(again.count).toBe(11);
    expect(again.runs.map((r: { ts: number }) => r.ts)).toEqual(
      Array.from({ length: 10 }, (_, i) => T + 18_000_010 - i),
    );
  }, 20_000);
});

describe("usage capture: the journey's lines reach the usage endpoint", () => {
  test("every channel counts once, and a dashboard search records no line", async () => {
    const home = makeCrankHome();
    const root = registeredProject(home);
    fs.writeFileSync(path.join(root, "code.ts"), THREE);
    const hit = seedMemory(root, [{ title: "Epsilon finding", filesRead: ["a.ts"] }])[0]!;
    const hook = (file: string, payload: object) =>
      runHook(file, JSON.stringify(payload), root, { CRANK_HOME: home });
    expect(hook(HOOK, claudeSessionStart(root)).status).toBe(0);
    expect(hook(SUBAGENT_HOOK, claudeSubagentStart(root, "Explore")).status).toBe(0);
    expect(hook(READ_HOOK, claudePostRead(root, path.join(root, "a.ts"), TRANSCRIPT)).status).toBe(
      0,
    );
    const claude = (args: string[]) => claudeCli(root, args, { CRANK_HOME: home });
    expect(printedIds(claude(["search", "epsilon"]).stdout)).toEqual([hit]);
    expect(claude(["search", "zzz-none"]).stdout).toBe("");
    expect(claude(["timeline", String(hit)]).status).toBe(0);
    expect(claude(["get", String(hit)]).status).toBe(0);
    expect(claude(["outline", "code.ts"]).status).toBe(0);
    expect(claude(["unfold", "code.ts", "one"]).status).toBe(0);
    const manual = runCli(root, ["search", "epsilon"], {
      CLAUDECODE: "",
      CLAUDE_CODE_SESSION_ID: "",
      CRANK_HOME: home,
    });
    expect(printedIds(manual.stdout)).toEqual([hit]);

    const lines = usageLines(root);
    const actor = { v: 1, ts: Date.now(), agent: "claude", session: "s1" };
    const malformed = [
      { channel: "session-start" },
      { channel: "search", query: "q" },
      { channel: "search", query: 7, ids: [] },
      { channel: "timeline", anchor: hit, ids: "1" },
      { channel: "get", requested: [hit], found: null },
      { channel: "file-history", empty: [] },
      { channel: "file-history", shown: [null], empty: [] },
      { channel: "bogus", ids: [hit] },
    ];
    fs.appendFileSync(
      path.join(root, ".crank", "usage.jsonl"),
      malformed.map((m) => JSON.stringify({ ...actor, ...m }) + "\n").join(""),
    );
    const dash = await startDashboard(home, ["--port", "0"]);
    const all = await usageOf(dash, root, "days=7&manual=1");
    expect(totals(all)).toEqual(
      channelCounts({
        "session-start": 1,
        "subagent-start": 1,
        "file-history": 1,
        search: 3,
        timeline: 1,
        get: 1,
        outline: 1,
        unfold: 1,
      }),
    );
    expect(all).toMatchObject({
      sessionStarts: 1,
      subagentStarts: 1,
      outlines: 1,
      unfolds: 1,
      cappedShare: 0,
    });
    expect(all.zeroResultShare).toBeCloseTo(1 / 3);
    const lists = (l: Record<string, any>): number[][] =>
      [l.ids, l.found, ...(l.shown ?? []).map((s: { ids: number[] }) => s.ids)].filter(
        Array.isArray,
      );
    const listing = lines.filter((l) => lists(l).some((ids) => ids.includes(hit)));
    expect(all.surfaced.find((s: { id: number }) => s.id === hit).count).toBe(listing.length);

    const agents = await usageOf(dash, root, "days=7&manual=0");
    expect(agents).toMatchObject({ searches: 2, zeroResultShare: 0.5, followThrough: 1 });

    const before = lineCount(root);
    const res = await dash.get(`/api/projects/${projectId(root)}/observations?q=epsilon`);
    expect(res.status).toBe(200);
    const found = (await res.json()) as { lines: { id: number }[] };
    expect(found.lines.map((l) => l.id)).toEqual([hit]);
    expect(lineCount(root)).toBe(before);
  }, 60_000);
});

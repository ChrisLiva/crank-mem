import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  git,
  gitCommit,
  makeCrankHome,
  makeCrankProject,
  plantMemory,
  runCli,
  runHook,
  seedMemory,
} from "./helpers.ts";
import { RECALL_BULLET } from "../src/hooks/lib/injection.ts";
import {
  claudePostBash,
  claudePostRead,
  claudeSessionStart,
  claudeSubagentStart,
  codexSessionStart,
} from "./fixtures/payloads.ts";

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

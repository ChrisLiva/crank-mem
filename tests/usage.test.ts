import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  git,
  gitCommit,
  makeCrankHome,
  makeCrankProject,
  runCli,
  runHook,
  seedMemory,
} from "./helpers.ts";
import { RECALL_BULLET } from "../src/hooks/lib/injection.ts";
import { claudeSessionStart, codexSessionStart } from "./fixtures/payloads.ts";

const HOOK = "src/hooks/session-start.ts";

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

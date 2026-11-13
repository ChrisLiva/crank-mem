import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { claudeSessionStart } from "./fixtures/payloads.ts";
import { CRANK_DIR, defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { runCli, runHook, seedMemory, tempDir } from "./helpers.ts";
import { workspace } from "./workspace.ts";

const HOOK = "src/hooks/session-start.ts";

function sessionStart(cwd: string, home: string) {
  return runHook(HOOK, JSON.stringify(claudeSessionStart(cwd)), undefined, { CRANK_HOME: home });
}

function context(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

describe("ownership", () => {
  test("session start resolves its project by the walk rule", () => {
    const ws = workspace();
    expect(context(sessionStart(ws.H, ws.home).stdout)).toContain("project H.");
    const clone = sessionStart(ws.clone, ws.home);
    expect(clone).toMatchObject({ status: 0, stdout: "" });
    expect(context(sessionStart(ws.submodule, ws.home).stdout)).toContain("project H.");
    expect(context(sessionStart(ws.worktree, ws.home).stdout)).toContain("project payments-api.");
    expect(sessionStart(ws.scratch, ws.home)).toMatchObject({ status: 0, stdout: "" });
    expect(fs.existsSync(path.join(ws.worktree, ".crank"))).toBe(false);

    fs.writeFileSync(
      path.join(ws.worktree, ".git"),
      "gitdir: ../payments-api/.git/worktrees/payments-api-wt\n",
    );
    expect(context(sessionStart(ws.worktree, ws.home).stdout)).toContain("project payments-api.");
  });

  test("a nested clone is not its enclosing project's", () => {
    const ws = workspace();
    expect(runCli(ws.clone, ["search", "x"], { CRANK_HOME: ws.home })).toEqual({
      status: 1,
      stdout: "",
      stderr: "crank-mem: not initialized here — run `crank-mem init` first.\n",
    });
  });

  test("a worktree with its own config reads the main store without git", () => {
    const ws = workspace();
    const crankDir = path.join(ws.worktree, CRANK_DIR);
    fs.mkdirSync(crankDir);
    saveConfig(crankDir, defaultConfig());
    seedMemory(ws.payments, [{ title: "Main store fact" }]);
    const bin = tempDir("crank-nogit-");
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const run = runCli(ws.worktree, ["search", "Main store fact"], {
      CRANK_HOME: ws.home,
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(run.stdout).toContain("Main store fact");
  });
});

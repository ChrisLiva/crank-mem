import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { claudeSessionStart } from "./fixtures/payloads.ts";
import { CRANK_DIR, defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { projectName } from "../src/hooks/lib/owner.ts";
import { installedStores, registerProject, rootOfName } from "../src/hooks/lib/registry.ts";
import {
  makeCrankHome,
  makeCrankProject,
  runCli,
  runHook,
  seedMemory,
  tempDir,
  withEnv,
} from "./helpers.ts";
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

  test("project names come from config, else the sanitized basename", () => {
    const root = path.join(tempDir("crank-name-"), "My App!");
    const crankDir = path.join(root, CRANK_DIR);
    fs.mkdirSync(crankDir, { recursive: true });
    expect(projectName(root)).toBe("My-App-");
    saveConfig(crankDir, defaultConfig());
    expect(projectName(root)).toBe("My-App-");
    saveConfig(crankDir, { ...defaultConfig(), name: "storefront" });
    expect(projectName(root)).toBe("storefront");
    saveConfig(crankDir, { ...defaultConfig(), name: "bad name" });
    expect(projectName(root)).toBe("My-App-");
  });

  test("a name maps to the newest root among distinct stores", () => {
    const named = (root: string, name: string) =>
      saveConfig(path.join(root, CRANK_DIR), { ...defaultConfig(), name });
    const a = makeCrankProject();
    const b = makeCrankProject();
    named(a, "dup");
    named(b, "dup");
    withEnv({ CRANK_HOME: makeCrankHome() }, () => {
      registerProject(a);
      Bun.sleepSync(2);
      registerProject(b);
      expect(rootOfName("dup")).toBe(b);
      named(b, "other");
      expect(rootOfName("dup")).toBe(a);
      expect(rootOfName("other")).toBe(b);
      expect(rootOfName("missing")).toBeNull();
    });

    const ws = workspace();
    fs.mkdirSync(path.join(ws.worktree, CRANK_DIR));
    named(ws.worktree, "payments-api");
    withEnv({ CRANK_HOME: ws.home }, () => {
      registerProject(ws.worktree);
      expect(rootOfName("payments-api")).toBe(ws.payments);
      const main = installedStores().filter(
        (s) => s.storeDir === path.join(ws.payments, CRANK_DIR),
      );
      expect(main).toHaveLength(1);
      expect(main[0]!.root).toBe(ws.payments);
      expect(installedStores()).toHaveLength(3);
    });
  });
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { claudePostRead, claudePostWrite, claudeSessionStart } from "./fixtures/payloads.ts";
import { readUntouched } from "../src/hooks/lib/untouched.ts";
import { localDate, memoryPath } from "../src/hooks/lib/memory.ts";
import {
  makeCrankHome,
  plantMemory,
  runCli,
  runHook,
  seedMemory,
  setMtime,
  withEnv,
} from "./helpers.ts";
import { workspace } from "./workspace.ts";

const SESSION = "a46b6073-1111-2222-3333-444455556666";
const TRANSCRIPT = "/u/.claude/projects/-proj/551be959.jsonl";
const HOUR = 3_600_000;

function usageLines(root: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(path.dirname(memoryPath(root)), "usage.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function additionalContext(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

describe("cross-repo memory", () => {
  test("journey 1: a session started in H captures across projects", () => {
    const ws = workspace();
    const hook = (name: string, payload: object) =>
      runHook(`src/hooks/${name}.ts`, JSON.stringify(payload), undefined, { CRANK_HOME: ws.home });
    const scratchSessions = () =>
      withEnv({ CRANK_HOME: ws.home }, readUntouched).find((r) => r.root === ws.scratch)?.sessions;

    expect(hook("session-start", claudeSessionStart(ws.H)).status).toBe(0);

    const storefrontFile = path.join(ws.storefront, "src/a.ts");
    expect(hook("post-write", claudePostWrite(ws.H, storefrontFile)).status).toBe(0);
    expect(fs.readFileSync(path.join(ws.storefront, ".crank/anatomy.md"), "utf-8")).toContain(
      "src/a.ts",
    );

    const scratchFile = path.join(ws.scratch, "a.ts");
    expect(hook("post-write", claudePostWrite(ws.H, scratchFile)).status).toBe(0);
    expect(scratchSessions()).toEqual([SESSION]);

    const numericId = { ...claudePostWrite(ws.H, scratchFile), session_id: 7 };
    expect(hook("post-write", numericId).status).toBe(0);
    expect(scratchSessions()).toEqual([SESSION]);

    const r = withEnv({ CRANK_HOME: ws.home }, readUntouched).find((e) => e.root === ws.scratch)!;
    const stats = runCli(ws.H, ["stats"], { CRANK_HOME: ws.home, TZ: "UTC" });
    expect(stats.stdout).toContain(
      `  not installed:    1\n    ${ws.scratch}  last seen ${localDate(r.lastSeenMs)}\n`,
    );
  });

  test("journey 2: recall from the other side", () => {
    const ws = workspace();
    const read = (file: string) =>
      runHook(
        "src/hooks/post-read.ts",
        JSON.stringify(claudePostRead(ws.H, file, TRANSCRIPT)),
        ws.H,
        { CRANK_HOME: ws.home },
      );

    const storefrontFile = path.join(ws.storefront, "src/a.ts");
    const [storefrontId] = seedMemory(ws.storefront, [
      { title: "Storefront fact", filesRead: ["src/a.ts"] },
    ]);
    setMtime(storefrontFile, Date.now() - HOUR);
    const first = read(storefrontFile);
    expect(first.status).toBe(0);
    const ctx = additionalContext(first.stdout);
    expect(ctx).toStartWith("History of src/a.ts (open one: `crank-mem get <id>`):\nstorefront#");
    expect(ctx).toMatch(/^storefront#\d+ \d{4}-\d\d-\d\d discovery Storefront fact$/m);
    const actor = { agent: "claude", session: "551be959-1111-2222-3333-444455556666" };
    expect(usageLines(ws.storefront)).toEqual([
      expect.objectContaining({
        ...actor,
        channel: "file-history",
        shown: [{ path: "src/a.ts", ids: [storefrontId] }],
      }),
    ]);
    expect(usageLines(ws.H)).toEqual([
      expect.objectContaining({
        ...actor,
        channel: "file-history",
        shown: [],
        empty: [],
        seen: [],
        cut: [],
      }),
    ]);
    const marker = fs.readFileSync(path.join(ws.home, "seen/551be959-main.seen"), "utf-8");
    expect(marker.split("\n")).toContain(storefrontFile);
    expect(read(storefrontFile).stdout).toBe("");

    seedMemory(ws.payments, [{ title: "Payments fact", filesRead: ["src/a.ts"] }]);
    const worktreeRead = read(path.join(ws.worktree, "src/a.ts"));
    expect(worktreeRead.status).toBe(0);
    const worktreeCtx = additionalContext(worktreeRead.stdout);
    expect(worktreeCtx).toContain("History of src/a.ts");
    expect(worktreeCtx).toMatch(/^payments-api#\d+ .* Payments fact$/m);

    const scratchRead = read(path.join(ws.scratch, "a.ts"));
    expect([scratchRead.status, scratchRead.stdout]).toEqual([0, ""]);
    const untouched = withEnv({ CRANK_HOME: ws.home }, readUntouched);
    expect(untouched.find((r) => r.root === ws.scratch)?.sessions).toEqual([
      "551be959-1111-2222-3333-444455556666",
    ]);

    const freshHome = makeCrankHome();
    const usageFile = path.join(ws.storefront, ".crank/usage.jsonl");
    const usageBefore = fs.readFileSync(usageFile, "utf-8");
    const fromScratch = runHook(
      "src/hooks/post-read.ts",
      JSON.stringify(claudePostRead(ws.scratch, storefrontFile, TRANSCRIPT)),
      ws.scratch,
      { CRANK_HOME: freshHome },
    );
    expect([fromScratch.status, fromScratch.stdout]).toEqual([0, ""]);
    expect(fs.existsSync(path.join(freshHome, "untouched.json"))).toBe(false);
    expect(fs.readFileSync(usageFile, "utf-8")).toBe(usageBefore);
  });

  test("post-read stays silent when another project's store cannot be read", () => {
    const ws = workspace();
    const storefrontFile = path.join(ws.storefront, "src/a.ts");
    const read = () =>
      runHook(
        "src/hooks/post-read.ts",
        JSON.stringify(claudePostRead(ws.H, storefrontFile, TRANSCRIPT)),
        ws.H,
        { CRANK_HOME: makeCrankHome() },
      );

    plantMemory(ws.storefront, "unreadable");
    const garbage = read();
    expect([garbage.status, garbage.stderr]).toEqual([0, ""]);
    expect(garbage.stdout).not.toContain("History of");

    const db = memoryPath(ws.storefront);
    fs.rmSync(db);
    seedMemory(ws.storefront, [{ title: "Hidden fact", filesRead: ["src/a.ts"] }]);
    fs.chmodSync(db, 0o000);
    try {
      const locked = read();
      expect([locked.status, locked.stderr]).toEqual([0, ""]);
      expect(locked.stdout).not.toContain("History of");
    } finally {
      fs.chmodSync(db, 0o644);
    }
  });
});

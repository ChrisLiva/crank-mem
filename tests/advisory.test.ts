import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeCrankHome, runHook, tempDir } from "./helpers.ts";
import {
  claudePostRead,
  claudePostWrite,
  claudeSessionEnd,
  claudeSessionStart,
  claudeStop,
  claudeSubagentStart,
} from "./fixtures/payloads.ts";

const HOOKS: Array<[string, (bare: string) => Record<string, unknown>]> = [
  ["session-start", (bare) => claudeSessionStart(bare)],
  ["subagent-start", (bare) => claudeSubagentStart(bare)],
  ["post-write", (bare) => claudePostWrite(bare, "a.ts")],
  ["post-read", (bare) => claudePostRead(bare, "a.ts", path.join(bare, "t.jsonl"))],
  ["stop", (bare) => claudeStop(bare)],
  ["session-end", (bare) => claudeSessionEnd(bare, path.join(bare, "t.jsonl"))],
];

describe.each(HOOKS)("%s hook stays advisory", (hook, payload) => {
  test.each([
    ["garbage stdin", () => "]]garbage"],
    ["empty stdin", () => ""],
    ["a cwd outside any project", (bare: string) => JSON.stringify(payload(bare))],
  ])("%s: exit 0, no output, no spool", (_name, stdin) => {
    const bare = tempDir("crank-bare-");
    const home = makeCrankHome();
    const run = runHook(`src/hooks/${hook}.ts`, stdin(bare), bare, { CRANK_HOME: home });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    expect(fs.existsSync(path.join(home, "spool"))).toBe(false);
  });
});

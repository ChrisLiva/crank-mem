import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git, gitCommit, runCli } from "./helpers.ts";
import { defaultConfig } from "../src/hooks/lib/config.ts";
import {
  STOP_FILE, clearStopState, crankHome, digestRunning, ensureCrankHome, readStopState, writeJsonAtomic,
  writeStopState, type StopState,
} from "../src/hooks/lib/user-state.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readConfig(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, ".crank/config.json"), "utf-8"));
}

describe("digest config", () => {
  test("init writes digest: false", () => {
    const root = tempDir("crank-digest-");
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    expect(runCli(root, ["init", "--yes"]).status).toBe(0);
    expect(readConfig(root).digest).toBe(false);
  });
});

function initedProject(): string {
  const root = tempDir("crank-digest-");
  fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
  expect(runCli(root, ["init", "--yes", "--codex", "skip"]).status).toBe(0);
  return root;
}

const ON = "crank-mem: digests on. They run on your Claude login through `claude -p`.\n";
const OFF = "crank-mem: digests off. Stored memory stays readable.\n";
const USAGE = "Usage: crank-mem digest on|off|resume\n";

describe("digest on|off", () => {
  test("on and off flip the config from the project root and print the exact line", () => {
    const root = initedProject();
    const on = runCli(root, ["digest", "on"]);
    expect(on.status).toBe(0);
    expect(on.stdout).toBe(ON);
    expect(readConfig(root).digest).toBe(true);
    const off = runCli(root, ["digest", "off"]);
    expect(off.status).toBe(0);
    expect(off.stdout).toBe(OFF);
    expect(readConfig(root).digest).toBe(false);
  });

  test("works from a subdirectory, keeps other config keys and leaves the store untouched", () => {
    const root = initedProject();
    const sub = path.join(root, "src/deep");
    fs.mkdirSync(sub, { recursive: true });
    const before = readConfig(root);
    const db = path.join(root, ".crank/memory.db");
    const bytes = Buffer.from([0, 1, 2, 0xff, 0xfe, 0x53, 0x51, 0x4c]);
    fs.writeFileSync(db, bytes);
    expect(runCli(sub, ["digest", "on"]).stdout).toBe(ON);
    expect(readConfig(root)).toEqual({ ...before, digest: true });
    expect(fs.existsSync(path.join(sub, ".crank"))).toBe(false);
    expect(runCli(sub, ["digest", "off"]).stdout).toBe(OFF);
    expect(readConfig(root)).toEqual(before);
    expect(fs.readFileSync(db).equals(bytes)).toBe(true);
  });

  test("any other subcommand, or none, prints usage and exits 1 without touching config", () => {
    const root = initedProject();
    const before = fs.readFileSync(path.join(root, ".crank/config.json"), "utf-8");
    for (const args of [["digest"], ["digest", "maybe"], ["digest", "ON"]]) {
      const run = runCli(root, args);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe(USAGE);
      expect(run.stdout).toBe("");
    }
    expect(fs.readFileSync(path.join(root, ".crank/config.json"), "utf-8")).toBe(before);
  });
});

describe("digest in git projects", () => {
  test("commit mode: digest on is a tracked edit, and a linked worktree keeps its own copy", () => {
    const root = tempDir("crank-digest-git-");
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    git(root, "init", "-q");
    expect(runCli(root, ["init", "--git", "commit", "--yes", "--codex", "skip"]).status).toBe(0);
    gitCommit(root, "init");
    const worktree = path.join(tempDir("crank-digest-wt-"), "wt");
    git(root, "worktree", "add", "-q", worktree);
    expect(runCli(root, ["digest", "on"]).status).toBe(0);
    expect(git(root, "status", "--short")).toBe(" M .crank/config.json\n");
    expect(readConfig(worktree).digest).toBe(false);
  });
});

describe("digest outside a project", () => {
  test("on and off print the init hint and exit 1", () => {
    const bare = tempDir("crank-digest-bare-");
    for (const sub of ["on", "off"]) {
      const run = runCli(bare, ["digest", sub]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("not initialized here");
      expect(fs.existsSync(path.join(bare, ".crank"))).toBe(false);
    }
  });
});

describe("user state under the crank home", () => {
  const saved = process.env.CRANK_HOME;
  let home: string;
  beforeEach(() => {
    home = path.join(tempDir("crank-userstate-"), "home");
    process.env.CRANK_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CRANK_HOME;
    else process.env.CRANK_HOME = saved;
  });

  test("crankHome is CRANK_HOME when set, otherwise ~/.crank, and an empty value counts as unset", () => {
    expect(crankHome()).toBe(home);
    process.env.CRANK_HOME = "";
    expect(crankHome()).toBe(path.join(os.homedir(), ".crank"));
    delete process.env.CRANK_HOME;
    expect(crankHome()).toBe(path.join(os.homedir(), ".crank"));
  });

  test("digestRunning needs digest on, a Claude session and no stop file", () => {
    const on = { ...defaultConfig(), digest: true };
    expect(digestRunning({ ...defaultConfig(), digest: false }, false)).toBe(false);
    expect(digestRunning(on, true)).toBe(false);
    expect(digestRunning(on, false)).toBe(true);
    const stop: StopState = { reason: "login", atMs: 1_730_000_000_123.456, detail: "Not logged in · ünïcode" };
    writeStopState(stop);
    expect(readStopState()).toEqual(stop);
    expect(digestRunning(on, false)).toBe(false);
    clearStopState();
    expect(digestRunning(on, false)).toBe(true);
    writeStopState(stop);
    fs.writeFileSync(path.join(home, STOP_FILE), "not json");
    expect(digestRunning(on, false)).toBe(true);
    fs.writeFileSync(path.join(home, STOP_FILE), "");
    expect(digestRunning(on, false)).toBe(true);
  });

  test("ensureCrankHome and writeJsonAtomic create a 0700 home and leave no temp file", () => {
    expect(ensureCrankHome()).toBe(home);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);

    const other = path.join(tempDir("crank-userstate-"), "home");
    const target = path.join(other, "state.json");
    const value = { at: 1_730_000_000_123.456, text: "ünïcode — ✓", list: [0, -1, null] };
    writeJsonAtomic(target, value);
    writeJsonAtomic(target, value);
    expect(fs.statSync(other).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual(value);
    expect(fs.readdirSync(other).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("help", () => {
  test("usage lists the digest command", () => {
    expect(runCli(tempDir("crank-digest-help-"), ["--help"]).stdout).toContain("digest     Turn background digests on or off, or resume them\n");
  });
});

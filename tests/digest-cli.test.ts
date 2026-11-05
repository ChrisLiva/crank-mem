import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git, gitCommit, makeCrankHome, runCli, runHook, spoolFiles } from "./helpers.ts";
import { claudeStop } from "./fixtures/payloads.ts";
import { defaultConfig } from "../src/hooks/lib/config.ts";
import {
  STOP_FILE,
  clearStopState,
  crankHome,
  ensureCrankHome,
  readStopState,
  writeJsonAtomic,
  writeTextAtomic,
  writeStopState,
  type StopState,
} from "../src/hooks/lib/user-state.ts";
import { digestGate } from "../src/hooks/lib/spool.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readConfig(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, ".crank/config.json"), "utf-8"));
}

function localConfigPath(root: string): string {
  return path.join(root, ".crank/config.local.json");
}

describe("digest config", () => {
  test("init writes no digest key and no local config", () => {
    const root = tempDir("crank-digest-");
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    expect(runCli(root, ["init", "--yes"]).status).toBe(0);
    expect("digest" in readConfig(root)).toBe(false);
    expect(fs.existsSync(localConfigPath(root))).toBe(false);
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
    const shared = fs.readFileSync(path.join(root, ".crank/config.json"));
    const on = runCli(root, ["digest", "on"]);
    expect(on.status).toBe(0);
    expect(on.stdout).toBe(ON);
    expect(JSON.parse(fs.readFileSync(localConfigPath(root), "utf-8"))).toEqual({ digest: true });
    expect(fs.readFileSync(path.join(root, ".crank/config.json")).equals(shared)).toBe(true);
    const off = runCli(root, ["digest", "off"]);
    expect(off.status).toBe(0);
    expect(off.stdout).toBe(OFF);
    expect(fs.existsSync(localConfigPath(root))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".crank/config.json")).equals(shared)).toBe(true);
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
    expect(readConfig(root)).toEqual(before);
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
  test("commit mode: digest on leaves git status clean, and a linked worktree stays off", () => {
    const root = tempDir("crank-digest-git-");
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    git(root, "init", "-q");
    expect(runCli(root, ["init", "--git", "commit", "--yes", "--codex", "skip"]).status).toBe(0);
    gitCommit(root, "init");
    const worktree = path.join(tempDir("crank-digest-wt-"), "wt");
    git(root, "worktree", "add", "-q", worktree);
    expect(runCli(root, ["digest", "on"]).status).toBe(0);
    expect(git(root, "status", "--short")).toBe("");
    const home = makeCrankHome();
    const payload = { ...claudeStop(worktree), transcript_path: "/x/wt-1.jsonl" };
    expect(
      runHook("src/hooks/stop.ts", JSON.stringify(payload), worktree, { CRANK_HOME: home }).status,
    ).toBe(0);
    expect(spoolFiles(home)).toEqual([]);
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

  test("the digest gate runs only with digest on, a Claude session and no stop file", () => {
    const on = { ...defaultConfig(), digest: true };
    const root = "/project";
    expect(digestGate({ ...defaultConfig(), digest: false }, false, root).running).toBe(false);
    expect(digestGate(on, true, root).running).toBe(false);
    expect(digestGate(on, false, root).running).toBe(true);
    const stop: StopState = {
      reason: "login",
      atMs: 1_730_000_000_123.456,
      detail: "Not logged in · ünïcode",
    };
    writeStopState(stop);
    expect(readStopState()).toEqual(stop);
    expect(digestGate(on, false, root).running).toBe(false);
    clearStopState();
    expect(digestGate(on, false, root).running).toBe(true);
    writeStopState(stop);
    fs.writeFileSync(path.join(home, STOP_FILE), "not json");
    expect(digestGate(on, false, root).running).toBe(true);
    fs.writeFileSync(path.join(home, STOP_FILE), "");
    expect(digestGate(on, false, root).running).toBe(true);
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

  test("writeTextAtomic writes atomically and refuses a file that changed", () => {
    const dir = path.join(tempDir("crank-text-"), "d");
    const file = path.join(dir, "cerebrum.md");
    const temps = () => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(writeTextAtomic(file, "a", null)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("a");
    expect(temps()).toEqual([]);
    expect(writeTextAtomic(file, "b", "a")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("b");
    expect(writeTextAtomic(file, "c", "zzz")).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("b");
    expect(temps()).toEqual([]);
    expect(writeTextAtomic(file, "ünïcode — ✓\n", "b")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("ünïcode — ✓\n");

    const missing = path.join(dir, "gone.md");
    expect(writeTextAtomic(missing, "x", "a")).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(["cerebrum.md"]);
  });
});

describe("help", () => {
  test("usage lists the digest command", () => {
    expect(runCli(tempDir("crank-digest-help-"), ["--help"]).stdout).toContain(
      "digest          Turn background digests on or off, or resume them\n",
    );
  });
});

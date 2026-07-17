import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "./helpers.ts";

const MAIN = path.join(REPO_ROOT, "src/cli/main.ts");

function cli(cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "crank-ch-"));
  const res = spawnSync("bun", [MAIN, ...args], {
    cwd, encoding: "utf-8", timeout: 30_000,
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function initedProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-cli-"));
  fs.writeFileSync(path.join(root, "a.ts"), "/** Alpha. */\nexport const a = 1;\n");
  expect(cli(root, "init", "--yes", "--codex", "skip").status).toBe(0);
  return root;
}

describe("scan", () => {
  test("rebuilds the index and picks up new files", () => {
    const root = initedProject();
    fs.writeFileSync(path.join(root, "b.ts"), "export const b = 2;\n");
    const run = cli(root, "scan");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("2 files indexed");
    const index = JSON.parse(fs.readFileSync(path.join(root, ".crank/anatomy-index.json"), "utf-8"));
    expect(index.files["b.ts"]).toBeDefined();
  });
  test("errors when not initialized", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "crank-bare-"));
    expect(cli(bare, "scan").status).toBe(1);
  });
});

describe("stats", () => {
  test("reports counts, coverage, runtime", () => {
    const root = initedProject();
    const run = cli(root, "stats");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("files indexed:    1");
    expect(run.stdout).toContain("coverage 100%");
    expect(run.stdout).toMatch(/runtime: {10}(bun|node)/);
  });
});

describe("upgrade", () => {
  test("same version is a no-op", () => {
    const root = initedProject();
    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("nothing to do");
  });

  test("stale stamp: re-vendors, updates stamp, preserves config/cerebrum/index", () => {
    const root = initedProject();
    const crankDir = path.join(root, ".crank");
    // Simulate an old vendored version + user data.
    const configPath = path.join(crankDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config.vendored_version = "0.0.1";
    config.injection_budget_tokens = 1234; // user-tuned value must survive
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    fs.appendFileSync(path.join(crankDir, "cerebrum.md"), "- custom memory\n");
    fs.writeFileSync(path.join(crankDir, "hooks/session-start.ts"), "// stale vendored copy\n");
    const indexBefore = fs.readFileSync(path.join(crankDir, "anatomy-index.json"), "utf-8");

    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("upgraded vendored hooks 0.0.1");

    const after = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(after.injection_budget_tokens).toBe(1234);
    expect(after.vendored_version).not.toBe("0.0.1");
    expect(fs.readFileSync(path.join(crankDir, "hooks/session-start.ts"), "utf-8")).not.toContain("stale vendored copy");
    expect(fs.readFileSync(path.join(crankDir, "cerebrum.md"), "utf-8")).toContain("custom memory");
    expect(fs.readFileSync(path.join(crankDir, "anatomy-index.json"), "utf-8")).toBe(indexBefore);
    // old hooks were backed up
    const backups = fs.readdirSync(path.join(crankDir, "backups")).sort();
    const latest = backups[backups.length - 1]!;
    expect(fs.readFileSync(path.join(crankDir, "backups", latest, "hooks/session-start.ts"), "utf-8")).toContain("stale vendored copy");
  });
});

describe("vendored hooks run standalone", () => {
  test("vendored session-start works from .crank/hooks/", () => {
    const root = initedProject();
    const res = spawnSync("bun", [path.join(root, ".crank/hooks/session-start.ts")], {
      input: JSON.stringify({ hook_event_name: "SessionStart", cwd: root, source: "startup" }),
      encoding: "utf-8", timeout: 15_000,
    });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).hookSpecificOutput.additionalContext).toContain("`a.ts`");
  });
});

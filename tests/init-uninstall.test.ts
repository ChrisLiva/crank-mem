import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "./helpers.ts";

// Non-negotiable smoke (plan task 7): init into a temp project → verify
// wiring → uninstall → byte-identical restore, zero crank residue.

const MAIN = path.join(REPO_ROOT, "src/cli/main.ts");

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

function cli(cwd: string, codexHome: string, ...args: string[]): CliRun {
  const res = spawnSync("bun", [MAIN, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function makeProject(extra: Record<string, string> = {}): { root: string; codexHome: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-init-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "crank-codexhome-"));
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.6"\n');
  fs.writeFileSync(path.join(root, "app.ts"), "/** The app. */\nexport const app = 1;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Test project\n");
  for (const [rel, content] of Object.entries(extra)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  spawnSync("git", ["init", "-q"], { cwd: root });
  return { root, codexHome };
}

/** Recursive listing + contents of everything except .git and crank. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      const rel = path.relative(root, full);
      if (rel === ".git" || rel === "crank") continue;
      if (item.isDirectory()) walk(full);
      else out[rel] = fs.readFileSync(full, "utf-8");
    }
  };
  walk(root);
  return out;
}

describe("init → uninstall round-trip", () => {
  test("default (exclude mode): wiring present, restore byte-identical, zero residue", () => {
    const { root, codexHome } = makeProject();
    const before = snapshot(root);
    const beforeCodexHome = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");

    const init = cli(root, codexHome, "init", "--yes", "--codex", "merge");
    expect(init.status).toBe(0);

    // wiring
    const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.local.json"), "utf-8"));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("crank/hooks/session-start.ts");
    const codexHooks = JSON.parse(fs.readFileSync(path.join(root, ".codex/hooks.json"), "utf-8"));
    expect(codexHooks.hooks.PostToolUse[0].matcher).toBe("apply_patch");
    expect(fs.readFileSync(path.join(root, ".codex/config.toml"), "utf-8")).toContain("hooks = true");
    expect(fs.readFileSync(path.join(root, ".git/info/exclude"), "utf-8")).toContain("crank/");
    // data dir
    expect(fs.existsSync(path.join(root, "crank/anatomy-index.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "crank/cerebrum.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "crank/hooks/lib/scanner.ts"))).toBe(true);
    const index = JSON.parse(fs.readFileSync(path.join(root, "crank/anatomy-index.json"), "utf-8"));
    expect(index.meta.fileCount).toBeGreaterThanOrEqual(2);

    const un = cli(root, codexHome, "uninstall", "--yes", "--restore", "--delete-crank");
    expect(un.status).toBe(0);

    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, "crank"))).toBe(false);
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8")).toBe(beforeCodexHome);
  });

  test("ignore mode: .gitignore gains and loses our lines", () => {
    const { root, codexHome } = makeProject({ ".gitignore": "dist/\n" });
    cli(root, codexHome, "init", "--yes", "--git", "ignore", "--codex", "skip");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe("dist/\n# crank-mem\ncrank/\n");
    expect(fs.existsSync(path.join(root, ".codex"))).toBe(false);
    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe("dist/\n");
    expect(fs.existsSync(path.join(root, "crank/cerebrum.md"))).toBe(true); // kept
  });

  test("commit mode: shared settings.json used, crank/.gitignore covers backups", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    expect(fs.existsSync(path.join(root, ".claude/settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "crank/.gitignore"), "utf-8")).toContain("backups/");
    // exclude file untouched in commit mode
    const excl = path.join(root, ".git/info/exclude");
    if (fs.existsSync(excl)) expect(fs.readFileSync(excl, "utf-8")).not.toContain("crank/");
  });

  test("codex-trust write: entries land in CODEX_HOME config and are removed on uninstall", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--codex", "merge", "--codex-trust", "write");
    const toml = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
    expect(toml).toContain('[hooks.state."' + path.join(fs.realpathSync(root), ".codex/hooks.json"));
    expect(toml).toMatch(/trusted_hash = "sha256:[0-9a-f]{64}"/);
    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8")).toBe('model = "gpt-5.6"\n');
  });

  test("pre-existing user settings survive surgical uninstall byte-identical", () => {
    const userSettings = JSON.stringify(
      { permissions: { allow: ["Bash(ls:*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } },
      null, 2
    ) + "\n";
    const { root, codexHome } = makeProject({ ".claude/settings.local.json": userSettings });
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    const merged = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.local.json"), "utf-8"));
    expect(merged.hooks.Stop[0].hooks[0].command).toBe("echo done");
    expect(merged.hooks.SessionStart[0].hooks[0].command).toContain("crank/hooks/");
    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(fs.readFileSync(path.join(root, ".claude/settings.local.json"), "utf-8")).toBe(userSettings);
  });

  test("pre-existing literal {} settings file survives surgical uninstall", () => {
    const { root, codexHome } = makeProject({ ".claude/settings.local.json": "{}" });
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.local.json"), "utf-8"))).toEqual({});
  });

  test("invalid --codex value exits 1 and leaves the project untouched", () => {
    const { root, codexHome } = makeProject();
    const before = snapshot(root);
    const res = cli(root, codexHome, "init", "--yes", "--codex", "bogus");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("invalid --codex bogus");
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, "crank"))).toBe(false);
  });

  test("double init refuses", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    const second = cli(root, codexHome, "init", "--yes", "--codex", "skip");
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("already initialized");
  });
});

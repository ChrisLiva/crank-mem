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
      if (rel === ".git" || rel === ".crank") continue;
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
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(".crank/hooks/session-start.ts");
    const codexHooks = JSON.parse(fs.readFileSync(path.join(root, ".codex/hooks.json"), "utf-8"));
    expect(codexHooks.hooks.PostToolUse[0].matcher).toBe("apply_patch");
    expect(fs.readFileSync(path.join(root, ".codex/config.toml"), "utf-8")).toContain("hooks = true");
    expect(fs.readFileSync(path.join(root, ".git/info/exclude"), "utf-8")).toContain(".crank/");
    // data dir
    expect(fs.existsSync(path.join(root, ".crank/anatomy-index.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".crank/cerebrum.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".crank/hooks/lib/scanner.ts"))).toBe(true);
    const index = JSON.parse(fs.readFileSync(path.join(root, ".crank/anatomy-index.json"), "utf-8"));
    expect(index.meta.fileCount).toBeGreaterThanOrEqual(2);

    const un = cli(root, codexHome, "uninstall", "--yes", "--restore", "--delete-crank");
    expect(un.status).toBe(0);

    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, ".crank"))).toBe(false);
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8")).toBe(beforeCodexHome);
  });

  test("ignore mode: .gitignore gains and loses our lines", () => {
    const { root, codexHome } = makeProject({ ".gitignore": "dist/\n" });
    cli(root, codexHome, "init", "--yes", "--git", "ignore", "--codex", "skip");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe("dist/\n# crank-mem\n.crank/\n");
    expect(fs.existsSync(path.join(root, ".codex"))).toBe(false);
    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe("dist/\n");
    expect(fs.existsSync(path.join(root, ".crank/cerebrum.md"))).toBe(true); // kept
  });

  test("commit mode: shared settings.json used, .crank/.gitignore covers backups", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    expect(fs.existsSync(path.join(root, ".claude/settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".crank/.gitignore"), "utf-8")).toContain("backups/");
    // exclude file untouched in commit mode
    const excl = path.join(root, ".git/info/exclude");
    if (fs.existsSync(excl)) expect(fs.readFileSync(excl, "utf-8")).not.toContain(".crank/");
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
    expect(merged.hooks.SessionStart[0].hooks[0].command).toContain(".crank/hooks/");
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

  test("upgrade's newer backup does not disable the empty-settings cleanup", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    // Force a version mismatch so upgrade re-vendors and adds a newer backup dir.
    const cfgPath = path.join(root, ".crank/config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    cfg.vendored_version = "0.0.1";
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    expect(cli(root, codexHome, "upgrade").status).toBe(0);
    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    // Init created settings.local.json, so uninstall must still delete the {} husk.
    expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(false);
  });

  test("invalid --codex value exits 1 and leaves the project untouched", () => {
    const { root, codexHome } = makeProject();
    const before = snapshot(root);
    const res = cli(root, codexHome, "init", "--yes", "--codex", "bogus");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("invalid --codex bogus");
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, ".crank"))).toBe(false);
  });

  test("double init refuses", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    const second = cli(root, codexHome, "init", "--yes", "--codex", "skip");
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("already initialized");
  });
});

// Uninstall sweeps residue from a pre-rename (non-dotted crank/) install:
// legacy hook entries, its Codex trust hashes, ignore lines, and the dir — no
// prompting, and even when the current .crank/ install isn't present.
describe("uninstall sweeps legacy crank/ installs", () => {
  /** Plant a full pre-rename install's residue into a fresh project. */
  function plantLegacy(root: string, codexHome: string): void {
    fs.mkdirSync(path.join(root, "crank", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(root, "crank", "config.json"), "{}\n");
    fs.writeFileSync(path.join(root, "crank", "hooks", "session-start.ts"), "// hook\n");

    // A user's own hook group beside our legacy one — the user's must survive.
    const claude = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "myOwnTool" }] },
          { hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/crank/hooks/session-start.ts' }] },
        ],
      },
    };
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify(claude, null, 2) + "\n");

    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n# crank-mem\ncrank/\n");

    const codexHooks = {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "crank/hooks/session-start.ts" }] }] },
    };
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "hooks.json"), JSON.stringify(codexHooks, null, 2) + "\n");
    // Trust keys are position-based, hash-independent — a matching key is enough.
    // The child derives the path from its cwd, which has symlinks resolved.
    const trustKey = `${path.join(fs.realpathSync(root), ".codex", "hooks.json")}:SessionStart:0:0`;
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      `model = "gpt-5.6"\n[hooks.state."${trustKey}"]\ntrusted_hash = "sha256:deadbeef"\n`,
    );
  }

  test("pure-legacy leftover (no .crank/) is fully swept", () => {
    const { root, codexHome } = makeProject();
    plantLegacy(root, codexHome);

    const un = cli(root, codexHome, "uninstall", "--yes");
    expect(un.status).toBe(0);

    expect(fs.existsSync(path.join(root, "crank"))).toBe(false);
    const claude = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf-8"));
    expect(claude.hooks.SessionStart).toHaveLength(1);
    expect(claude.hooks.SessionStart[0].hooks[0].command).toBe("myOwnTool");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe("node_modules\n");
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8")).not.toContain("hooks.state");
  });

  test("migrated project: legacy residue swept alongside the current install", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    // Re-init on an old checkout left the pre-rename dir and its hook wiring behind.
    fs.mkdirSync(path.join(root, "crank", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(root, "crank", "config.json"), "{}\n");
    const settingsPath = path.join(root, ".claude", "settings.local.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    settings.hooks.SessionStart.push({
      hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/crank/hooks/session-start.ts' }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

    const un = cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(un.status).toBe(0);

    expect(fs.existsSync(path.join(root, "crank"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".crank"))).toBe(true);
    // No crank hook commands survive — current or legacy.
    const settingsAfter = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf-8") : "";
    expect(settingsAfter).not.toContain("crank/hooks/");
  });
});

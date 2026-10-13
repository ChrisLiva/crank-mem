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
/** True when git ignores `rel` in `root`. */
function ignored(root: string, rel: string): boolean {
  return spawnSync("git", ["check-ignore", "-q", "--", rel], { cwd: root }).status === 0;
}

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
    // The audit-skill pointer sits on the closing guidance block, after "Next:".
    const pointer = "Optional: install the audit skill — npx skills add ChrisLiva/crank-mem";
    expect(init.stdout).toContain(pointer);
    expect(init.stdout.indexOf(pointer)).toBeGreaterThan(init.stdout.indexOf("Next: start a Claude Code session"));

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
    expect(fs.readFileSync(path.join(root, ".crank/journal.md"), "utf-8")).toContain("# Journal");
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

  test("commit mode: shared settings.json used, .crank/.gitignore admits only crank-mem's files", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    expect(fs.existsSync(path.join(root, ".claude/settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(false);
    for (const rel of [".crank/cerebrum.md", ".crank/cerebrum-archive.md", ".crank/journal.md", ".crank/config.json", ".crank/hooks/stop.ts"]) {
      expect(ignored(root, rel)).toBe(false);
    }
    for (const rel of [
      ".crank/backups/x/manifest.json", ".crank/backups/cerebrum/c.md", ".crank/debug.log", ".crank/anatomy-index.lock",
      ".crank/cerebrum-dedup.json", ".crank/efforts/e1/plan.md",
    ]) {
      expect(ignored(root, rel)).toBe(true);
    }
    // exclude file untouched in commit mode
    const excl = path.join(root, ".git/info/exclude");
    if (fs.existsSync(excl)) expect(fs.readFileSync(excl, "utf-8")).not.toContain(".crank/");
  });

  test("init backs up another tool's .crank/.gitignore and restore brings it back", () => {
    const { root, codexHome } = makeProject({ ".crank/.gitignore": "*\n", ".crank/efforts/e1/plan.md": "plan\n" });
    expect(cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip").status).toBe(0);
    expect(fs.readFileSync(path.join(root, ".crank/.gitignore"), "utf-8")).toStartWith("/*\n");
    cli(root, codexHome, "uninstall", "--yes", "--restore", "--delete-crank");
    expect(fs.readFileSync(path.join(root, ".crank/.gitignore"), "utf-8")).toBe("*\n");
    expect(fs.readFileSync(path.join(root, ".crank/efforts/e1/plan.md"), "utf-8")).toBe("plan\n");
  });

  test("commit-mode init strips crank-mem's own ignore block that hides cerebrum", () => {
    const { root, codexHome } = makeProject({ ".gitignore": "dist/\n# crank-mem\n.crank/\n" });
    const init = cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("removed the crank-mem .crank/ ignore block from .gitignore");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe("dist/\n");
    expect(ignored(root, ".crank/cerebrum.md")).toBe(false);
  });

  test("commit-mode init warns about a foreign rule that hides cerebrum and leaves it alone", () => {
    const { root, codexHome } = makeProject({ ".gitignore": ".crank\n" });
    const init = cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    expect(init.status).toBe(0);
    expect(init.stderr).toContain("git ignores .crank/cerebrum.md via .gitignore:1 (.crank)");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe(".crank\n");
  });

  test("commit-mode upgrade strips an ignore block left by an earlier exclude-mode init", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    const exclude = path.join(root, ".git/info/exclude");
    fs.appendFileSync(exclude, "# crank-mem\n.crank/\n");
    expect(ignored(root, ".crank/cerebrum.md")).toBe(true);
    const up = cli(root, codexHome, "upgrade");
    expect(up.status).toBe(0);
    expect(up.stdout).toContain("removed the crank-mem .crank/ ignore block from .git/info/exclude");
    expect(fs.readFileSync(exclude, "utf-8")).not.toContain(".crank/");
    expect(ignored(root, ".crank/cerebrum.md")).toBe(false);
  });

  test("upgrade replaces a pre-allowlist .crank/.gitignore, and restore brings the old one back", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    const crankGitignore = path.join(root, ".crank/.gitignore");
    // What 0.6.0 init wrote: a denylist that misses later state files and other tools' files.
    const denylist = "backups/\nanatomy-index.lock\ncerebrum-nudge.json\ndebug.log\n*.tmp\n";
    fs.writeFileSync(crankGitignore, denylist);
    expect(ignored(root, ".crank/cerebrum-dedup.json")).toBe(false);
    const up = cli(root, codexHome, "upgrade");
    expect(up.status).toBe(0);
    expect(up.stdout).toContain("wrote the allowlist .crank/.gitignore");
    for (const rel of [".crank/cerebrum-dedup.json", ".crank/efforts/run1/data.bin"]) expect(ignored(root, rel)).toBe(true);
    expect(ignored(root, ".crank/cerebrum.md")).toBe(false);
    expect(cli(root, codexHome, "upgrade").stdout).not.toContain(".crank/.gitignore");
    cli(root, codexHome, "uninstall", "--yes", "--restore", "--keep-crank");
    expect(fs.readFileSync(crankGitignore, "utf-8")).toBe(denylist);
  });

  test("restore keeps the allowlist init wrote where no .crank/.gitignore was", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    fs.writeFileSync(path.join(root, ".crank/debug.log"), "x");
    const un = cli(root, codexHome, "uninstall", "--yes", "--restore", "--keep-crank");
    expect(un.status).toBe(0);
    expect(un.stdout).not.toContain(".gitignore");
    for (const rel of [".crank/debug.log", ".crank/cerebrum-nudge.json"]) expect(ignored(root, rel)).toBe(true);
  });

  test("--delete-crank deletes only crank-mem's files and keeps another tool's", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    const crank = path.join(root, ".crank");
    for (const name of ["debug.log", "cerebrum-nudge.json", "cerebrum-dedup.json", "cerebrum-archive.md", "anatomy-index.lock", "journal.md.tmp"]) {
      fs.writeFileSync(path.join(crank, name), "x");
    }
    fs.mkdirSync(path.join(crank, "backups/cerebrum"), { recursive: true });
    fs.writeFileSync(path.join(crank, "backups/cerebrum/2026-10-13T00-00-00-000Z.md"), "x");
    fs.mkdirSync(path.join(crank, "efforts/e1"), { recursive: true });
    fs.writeFileSync(path.join(crank, "efforts/e1/plan.md"), "plan\n");
    fs.writeFileSync(path.join(crank, "backups/plugin-note.md"), "note\n");
    // The audit skill's backup: plain copies, no manifest.
    fs.mkdirSync(path.join(crank, "backups/20260814-165019"));
    for (const name of ["cerebrum.md", "journal.md"]) fs.writeFileSync(path.join(crank, "backups/20260814-165019", name), "x");
    // Another tool's dir under backups/ without a manifest.
    fs.mkdirSync(path.join(crank, "backups/plugin-run"));
    fs.writeFileSync(path.join(crank, "backups/plugin-run/state.json"), "{}");

    const un = cli(root, codexHome, "uninstall", "--yes", "--delete-crank");
    expect(un.status).toBe(0);
    expect(un.stdout).toContain("kept what other tools wrote: backups, efforts");
    expect(fs.readdirSync(crank).sort()).toEqual([".gitignore", "backups", "efforts"]);
    expect(fs.readdirSync(path.join(crank, "backups")).sort()).toEqual(["plugin-note.md", "plugin-run"]);
    expect(fs.readFileSync(path.join(crank, "efforts/e1/plan.md"), "utf-8")).toBe("plan\n");
  });

  test("--delete-crank removes .crank/ when only crank-mem's audit backup is left", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    const audit = path.join(root, ".crank/backups/2026-10-01T12-00-00");
    fs.mkdirSync(audit);
    fs.writeFileSync(path.join(audit, "cerebrum.md"), "# Cerebrum\n");
    const un = cli(root, codexHome, "uninstall", "--yes", "--delete-crank");
    expect(un.status).toBe(0);
    expect(un.stdout).toContain("  deleted .crank/\n");
    expect(fs.existsSync(path.join(root, ".crank"))).toBe(false);
  });

  test("commit-mode init moves crank hooks out of a pre-seeded settings.local.json", () => {
    const local = JSON.stringify({
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'bun "$CLAUDE_PROJECT_DIR"/.crank/hooks/session-start.ts' }] }] },
    }, null, 2) + "\n";
    const { root, codexHome } = makeProject({ ".claude/settings.local.json": local });
    const before = snapshot(root);
    const init = cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("removed duplicate crank hooks from .claude/settings.local.json");
    const crankStarts = [".claude/settings.json", ".claude/settings.local.json"].flatMap((rel) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, rel), "utf-8"));
      return (parsed.hooks?.SessionStart ?? []).filter((g: any) => g.hooks.some((h: any) => h.command.includes(".crank/hooks/")));
    });
    expect(crankStarts.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.local.json"), "utf-8")).permissions)
      .toEqual({ allow: ["Bash(ls:*)"] });
    // Restore brings back the backed-up local file; uninstall then strips every crank hook.
    cli(root, codexHome, "uninstall", "--yes", "--restore", "--delete-crank");
    expect(snapshot(root)).toEqual({
      ...before,
      ".claude/settings.local.json": JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2) + "\n",
    });
  });

  test("codex-trust write: entries land in CODEX_HOME config and are removed on uninstall", () => {
    const { root, codexHome } = makeProject();
    const codexConfig = path.join(codexHome, "config.toml");
    const hooksJson = path.join(fs.realpathSync(root), ".codex/hooks.json");
    // An older crank release's PascalCase orphan for THIS project, plus an
    // entry codex wrote for another project: init sweeps the first, never the
    // second, and uninstall leaves the second alone too.
    const codexOwn =
      '[hooks.state."/other/project/.codex/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:beef"\n';
    fs.writeFileSync(
      codexConfig,
      `model = "gpt-5.6"\n[hooks.state."${hooksJson}:SessionStart:0:0"]\ntrusted_hash = "sha256:stale"\n${codexOwn}`,
    );

    cli(root, codexHome, "init", "--yes", "--codex", "merge", "--codex-trust", "write");
    const toml = fs.readFileSync(codexConfig, "utf-8");
    expect(toml).toContain(`[hooks.state."${hooksJson}:session_start:0:0"]`);
    expect(toml).toMatch(/trusted_hash = "sha256:[0-9a-f]{64}"/);
    expect(toml).not.toContain("SessionStart");
    expect(toml).toContain(codexOwn);

    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(fs.readFileSync(codexConfig, "utf-8")).toBe('model = "gpt-5.6"\n' + codexOwn);
  });

  test("uninstall sweeps a PascalCase orphan an older release left behind", () => {
    const { root, codexHome } = makeProject();
    const codexConfig = path.join(codexHome, "config.toml");
    cli(root, codexHome, "init", "--yes", "--codex", "merge", "--codex-trust", "write");
    // As if this project had been init'd by a release that keyed on the raw event.
    const hooksJson = path.join(fs.realpathSync(root), ".codex/hooks.json");
    fs.appendFileSync(codexConfig, `[hooks.state."${hooksJson}:SessionStart:0:0"]\ntrusted_hash = "sha256:stale"\n`);
    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(fs.readFileSync(codexConfig, "utf-8")).toBe('model = "gpt-5.6"\n');
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
    // Both spellings are planted: the snake_case key codex looks up, and the
    // PascalCase orphan older releases wrote. The sweep takes both.
    const keyPrefix = path.join(fs.realpathSync(root), ".codex", "hooks.json");
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      `model = "gpt-5.6"\n` +
        `[hooks.state."${keyPrefix}:session_start:0:0"]\ntrusted_hash = "sha256:deadbeef"\n` +
        `[hooks.state."${keyPrefix}:SessionStart:0:0"]\ntrusted_hash = "sha256:deadbeef"\n`,
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

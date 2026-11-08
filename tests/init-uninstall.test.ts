import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  makeCrankHome,
  makeProject,
  runCli,
  runHook,
  setMtime,
  snapshot,
  type CliRun,
} from "./helpers.ts";
import { claudeSessionStart, claudeStop, codexApplyPatch } from "./fixtures/payloads.ts";

// Smoke: init into a temp project, check the wiring, uninstall, then expect a
// byte-identical restore and no crank residue.

function cli(cwd: string, codexHome: string, ...args: string[]): CliRun {
  return runCli(cwd, args, { CODEX_HOME: codexHome });
}

const SNAPSHOT_BYTES = "snapshot \u00e9\u0000bytes";

/** Plants one daily memory snapshot in .crank/backups/memory/ and returns its path. */
function plantSnapshot(root: string): string {
  const file = path.join(root, ".crank/backups/memory/2026-11-04T00-00-00-000Z.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SNAPSHOT_BYTES);
  return file;
}

const STORE_FILES = ["memory.db", "memory.db-wal", "memory.db-shm"];

/** True when git ignores `rel` in `root`. */
function ignored(root: string, rel: string): boolean {
  return spawnSync("git", ["check-ignore", "-q", "--", rel], { cwd: root }).status === 0;
}

/** The real path of the one dir under `<root>/.crank/backups/`; expects exactly one. */
function onlyBackupDir(root: string): string {
  const dirs = fs.readdirSync(path.join(root, ".crank", "backups"));
  expect(dirs).toHaveLength(1);
  return path.join(fs.realpathSync(root), ".crank", "backups", dirs[0]!);
}

/** Writes `text` as `<root>/.crank/backups/2999-01-01T00-00-00-000Z/manifest.json`, creating the dir, and returns the dir's real path. */
function plantLaterManifest(root: string, text: string): string {
  const dir = path.join(fs.realpathSync(root), ".crank", "backups", "2999-01-01T00-00-00-000Z");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), text);
  return dir;
}

/** The original paths the manifest in the one backup dir under `<root>/.crank/backups/` lists. */
function manifestOriginals(root: string): string[] {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(onlyBackupDir(root), "manifest.json"), "utf-8"),
  );
  return manifest.entries.map((e: { original: string }) => e.original);
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
    expect(init.stdout.indexOf(pointer)).toBeGreaterThan(
      init.stdout.indexOf("Next: start a Claude Code session"),
    );

    // wiring
    const settings = JSON.parse(
      fs.readFileSync(path.join(root, ".claude/settings.local.json"), "utf-8"),
    );
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
      ".crank/hooks/session-start.ts",
    );
    expect(settings.permissions.allow).toEqual([
      "Bash(crank-mem search *)",
      "Bash(crank-mem timeline *)",
      "Bash(crank-mem get *)",
      "Bash(crank-mem outline *)",
      "Bash(crank-mem unfold *)",
    ]);
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain(".crank/hooks/session-end.ts");
    const fileHistory = settings.hooks.PostToolUse.find(
      (g: { matcher?: string }) => g.matcher === "Read|Bash",
    );
    expect(fileHistory.hooks[0].command).toContain(".crank/hooks/post-read.ts");
    for (const hook of ["session-end.ts", "post-read.ts"])
      expect(fs.existsSync(path.join(root, ".crank/hooks", hook))).toBe(true);
    const codexHooks = JSON.parse(fs.readFileSync(path.join(root, ".codex/hooks.json"), "utf-8"));
    expect(codexHooks.hooks.PostToolUse[0].matcher).toBe("apply_patch");
    expect(fs.readFileSync(path.join(root, ".codex/config.toml"), "utf-8")).toContain(
      "hooks = true",
    );
    expect(fs.readFileSync(path.join(root, ".git/info/exclude"), "utf-8")).toContain(".crank/");
    // data dir
    expect(fs.existsSync(path.join(root, ".crank/anatomy-index.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".crank/cerebrum.md"))).toBe(true);
    expect(fs.readFileSync(path.join(root, ".crank/cerebrum.md"), "utf-8")).toBe(
      "# Cerebrum\n\n## User Preferences\n\n## Memory\n",
    );
    expect(fs.existsSync(path.join(root, ".crank/journal.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".crank/hooks/lib/scanner.ts"))).toBe(true);
    const index = JSON.parse(
      fs.readFileSync(path.join(root, ".crank/anatomy-index.json"), "utf-8"),
    );
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
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe(
      "dist/\n# crank-mem\n.crank/\n",
    );
    expect(fs.existsSync(path.join(root, ".codex"))).toBe(false);
    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe("dist/\n");
    expect(fs.existsSync(path.join(root, ".crank/cerebrum.md"))).toBe(true); // kept
  });

  test("commit mode: shared settings.json used, .crank/.gitignore admits only crank-mem's files", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(false);
    const shared = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf-8"));
    expect(shared.permissions.allow).toEqual([
      "Bash(crank-mem search *)",
      "Bash(crank-mem timeline *)",
      "Bash(crank-mem get *)",
      "Bash(crank-mem outline *)",
      "Bash(crank-mem unfold *)",
    ]);
    for (const rel of [
      ".crank/cerebrum.md",
      ".crank/cerebrum-archive.md",
      ".crank/journal.md",
      ".crank/config.json",
      ".crank/hooks/stop.ts",
    ]) {
      expect(ignored(root, rel)).toBe(false);
    }
    for (const rel of [
      ".crank/backups/x/manifest.json",
      ".crank/backups/cerebrum/c.md",
      ".crank/debug.log",
      ".crank/anatomy-index.lock",
      ".crank/cerebrum-dedup.json",
      ".crank/efforts/e1/plan.md",
    ]) {
      expect(ignored(root, rel)).toBe(true);
    }
    // exclude file untouched in commit mode
    const excl = path.join(root, ".git/info/exclude");
    if (fs.existsSync(excl)) expect(fs.readFileSync(excl, "utf-8")).not.toContain(".crank/");
  });

  test("init backs up another tool's .crank/.gitignore and restore brings it back", () => {
    const { root, codexHome } = makeProject({
      ".crank/.gitignore": "*\n",
      ".crank/efforts/e1/plan.md": "plan\n",
    });
    expect(cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip").status).toBe(
      0,
    );
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
    expect(up.stdout).toContain(
      "removed the crank-mem .crank/ ignore block from .git/info/exclude",
    );
    expect(fs.readFileSync(exclude, "utf-8")).not.toContain(".crank/");
    expect(ignored(root, ".crank/cerebrum.md")).toBe(false);
  });

  test("ignore-mode upgrade adds back a missing ignore block, once", () => {
    const { root, codexHome } = makeProject({ ".gitignore": "dist/\n" });
    cli(root, codexHome, "init", "--yes", "--git", "ignore", "--codex", "skip");
    const gitignore = path.join(root, ".gitignore");
    fs.writeFileSync(gitignore, "dist/\n");
    expect(ignored(root, ".crank/cerebrum.md")).toBe(false);
    const up = cli(root, codexHome, "upgrade");
    expect(up.status).toBe(0);
    expect(up.stdout).toContain("added the crank-mem .crank/ ignore block to .gitignore");
    expect(fs.readFileSync(gitignore, "utf-8")).toBe("dist/\n# crank-mem\n.crank/\n");
    expect(ignored(root, ".crank/cerebrum.md")).toBe(true);
    expect(cli(root, codexHome, "upgrade").stdout).not.toContain("ignore block");
    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(fs.readFileSync(gitignore, "utf-8")).toBe("dist/\n");
  });

  test("exclude-mode upgrade adds back a missing ignore block and leaves .gitignore alone", () => {
    const { root, codexHome } = makeProject({ ".gitignore": "dist/\n" });
    cli(root, codexHome, "init", "--yes", "--git", "exclude", "--codex", "skip");
    const exclude = path.join(root, ".git/info/exclude");
    fs.writeFileSync(exclude, "");
    const up = cli(root, codexHome, "upgrade");
    expect(up.status).toBe(0);
    expect(up.stdout).toContain("added the crank-mem .crank/ ignore block to .git/info/exclude");
    expect(ignored(root, ".crank/cerebrum.md")).toBe(true);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe("dist/\n");
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
    for (const rel of [".crank/cerebrum-dedup.json", ".crank/efforts/run1/data.bin"])
      expect(ignored(root, rel)).toBe(true);
    expect(ignored(root, ".crank/cerebrum.md")).toBe(false);
    expect(cli(root, codexHome, "upgrade").stdout).not.toContain(".crank/.gitignore");
    cli(root, codexHome, "uninstall", "--yes", "--restore", "--keep-crank");
    expect(fs.readFileSync(crankGitignore, "utf-8")).toBe(denylist);
  });

  test("restore keeps a cerebrum edited after upgrade replaced its template preamble", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    const cerebrum = path.join(root, ".crank/cerebrum.md");
    const preamble = fs.readFileSync(
      path.join(import.meta.dir, "../src/templates/cerebrum-preamble-0.8.1.md"),
    );
    fs.writeFileSync(cerebrum, Buffer.concat([preamble, Buffer.from("## Memory\n")]));
    const up = cli(root, codexHome, "upgrade");
    expect(up.status).toBe(0);
    expect(up.stdout).toContain("replaced the template preamble of .crank/cerebrum.md");
    fs.appendFileSync(cerebrum, "- **Kept**: added after upgrade (2026-11-05)\n");
    const un = cli(root, codexHome, "uninstall", "--yes", "--restore", "--keep-crank");
    expect(un.status).toBe(0);
    expect(fs.readFileSync(cerebrum, "utf-8")).toContain("**Kept**: added after upgrade");
  });

  test("restore keeps the allowlist init wrote where no .crank/.gitignore was", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    fs.writeFileSync(path.join(root, ".crank/debug.log"), "x");
    for (const name of STORE_FILES) fs.writeFileSync(path.join(root, ".crank", name), "x");
    const un = cli(root, codexHome, "uninstall", "--yes", "--restore", "--keep-crank");
    expect(un.status).toBe(0);
    expect(un.stdout).not.toContain(".gitignore");
    for (const name of STORE_FILES)
      expect(fs.existsSync(path.join(root, ".crank", name))).toBe(true);
    for (const rel of [".crank/debug.log", ".crank/cerebrum-nudge.json"])
      expect(ignored(root, rel)).toBe(true);
  });

  test("--delete-crank deletes only crank-mem's files and keeps another tool's", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    const crank = path.join(root, ".crank");
    for (const name of [
      "debug.log",
      "cerebrum-nudge.json",
      "cerebrum-dedup.json",
      "cerebrum-archive.md",
      "anatomy-index.lock",
      "journal.md.tmp",
    ]) {
      fs.writeFileSync(path.join(crank, name), "x");
    }
    fs.mkdirSync(path.join(crank, "backups/cerebrum"), { recursive: true });
    fs.writeFileSync(path.join(crank, "backups/cerebrum/2026-10-13T00-00-00-000Z.md"), "x");
    fs.mkdirSync(path.join(crank, "efforts/e1"), { recursive: true });
    fs.writeFileSync(path.join(crank, "efforts/e1/plan.md"), "plan\n");
    fs.writeFileSync(path.join(crank, "backups/plugin-note.md"), "note\n");
    // The audit skill's backup: plain copies, no manifest.
    fs.mkdirSync(path.join(crank, "backups/20260814-165019"));
    for (const name of ["cerebrum.md", "journal.md"])
      fs.writeFileSync(path.join(crank, "backups/20260814-165019", name), "x");
    // Another tool's dir under backups/ without a manifest.
    fs.mkdirSync(path.join(crank, "backups/plugin-run"));
    fs.writeFileSync(path.join(crank, "backups/plugin-run/state.json"), "{}");

    const un = cli(root, codexHome, "uninstall", "--yes", "--delete-crank");
    expect(un.status).toBe(0);
    expect(un.stdout).toContain("kept what other tools wrote: backups, efforts");
    expect(fs.readdirSync(crank).sort()).toEqual([".gitignore", "backups", "efforts"]);
    expect(fs.readdirSync(path.join(crank, "backups")).sort()).toEqual([
      "plugin-note.md",
      "plugin-run",
    ]);
    expect(fs.readFileSync(path.join(crank, "efforts/e1/plan.md"), "utf-8")).toBe("plan\n");
  });

  test("hooks leave the old upkeep files untouched, and --delete-crank still removes them", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    const crank = path.join(root, ".crank");
    const old = {
      "journal.md": "# Journal\n\n- 2026-10-01: did a; NEXT: do b\n",
      "cerebrum-nudge.json": JSON.stringify({ cerebrumMtimeMs: 1, nudgedAtChanged: 0 }),
      "cerebrum-dedup.json": JSON.stringify({ cerebrumMtimeMs: 1, bulletHashes: [] }),
    };
    const ONE_DAY_AGO = Date.now() - 86_400_000;
    for (const [name, text] of Object.entries(old)) {
      fs.writeFileSync(path.join(crank, name), text);
      setMtime(path.join(crank, name), ONE_DAY_AGO);
    }
    const before = Object.keys(old).map((name) => fs.statSync(path.join(crank, name)).mtimeMs);

    const env = { CRANK_HOME: makeCrankHome() };
    const patch = "*** Begin Patch\n*** Update File: app.ts\n+x\n*** End Patch";
    for (const [hook, payload] of [
      ["session-start", claudeSessionStart(root)],
      ["stop", claudeStop(root)],
      ["post-write", codexApplyPatch(root, patch)],
    ] as const) {
      expect(runHook(`src/hooks/${hook}.ts`, JSON.stringify(payload), root, env).status).toBe(0);
    }
    for (const [name, text] of Object.entries(old))
      expect(fs.readFileSync(path.join(crank, name), "utf-8")).toBe(text);
    expect(Object.keys(old).map((name) => fs.statSync(path.join(crank, name)).mtimeMs)).toEqual(
      before,
    );

    expect(cli(root, codexHome, "uninstall", "--yes", "--delete-crank").status).toBe(0);
    for (const name of Object.keys(old)) expect(fs.existsSync(path.join(crank, name))).toBe(false);
  });

  test("--delete-crank removes .crank/ when only crank-mem's audit backup is left", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    const audit = path.join(root, ".crank/backups/2026-10-01T12-00-00");
    fs.mkdirSync(audit);
    fs.writeFileSync(path.join(audit, "cerebrum.md"), "# Cerebrum\n");
    for (const name of STORE_FILES) fs.writeFileSync(path.join(root, ".crank", name), "x");
    plantSnapshot(root);
    const un = cli(root, codexHome, "uninstall", "--yes", "--delete-crank");
    expect(un.status).toBe(0);
    expect(un.stdout).toContain("  deleted .crank/\n");
    expect(fs.existsSync(path.join(root, ".crank"))).toBe(false);
  });

  for (const flags of [["--keep-crank"], ["--restore", "--keep-crank"]]) {
    test(`uninstall ${flags.join(" ")} keeps the memory snapshots`, () => {
      const { root, codexHome } = makeProject();
      cli(root, codexHome, "init", "--yes", "--codex", "skip");
      const snapshot = plantSnapshot(root);
      expect(cli(root, codexHome, "uninstall", "--yes", ...flags).status).toBe(0);
      expect(fs.readFileSync(snapshot, "utf8")).toBe(SNAPSHOT_BYTES);
    });
  }

  test("uninstall deletes the local digest switch", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    expect(cli(root, codexHome, "digest", "on").status).toBe(0);
    const un = cli(root, codexHome, "uninstall", "--yes", "--delete-crank");
    expect(un.status).toBe(0);
    expect(un.stdout).toContain("  deleted .crank/\n");
    expect(fs.existsSync(path.join(root, ".crank"))).toBe(false);
  });

  test("commit-mode init moves crank hooks out of a pre-seeded settings.local.json", () => {
    const local =
      JSON.stringify(
        {
          permissions: { allow: ["Bash(ls:*)"] },
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: 'bun "$CLAUDE_PROJECT_DIR"/.crank/hooks/session-start.ts',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + "\n";
    const { root, codexHome } = makeProject({ ".claude/settings.local.json": local });
    const before = snapshot(root);
    const init = cli(root, codexHome, "init", "--yes", "--git", "commit", "--codex", "skip");
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("removed duplicate crank hooks from .claude/settings.local.json");
    const crankStarts = [".claude/settings.json", ".claude/settings.local.json"].flatMap((rel) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, rel), "utf-8"));
      return (parsed.hooks?.SessionStart ?? []).filter((g: any) =>
        g.hooks.some((h: any) => h.command.includes(".crank/hooks/")),
      );
    });
    expect(crankStarts.length).toBe(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.local.json"), "utf-8"))
        .permissions,
    ).toEqual({ allow: ["Bash(ls:*)"] });
    // Restore brings back the backed-up local file; uninstall then strips every crank hook.
    cli(root, codexHome, "uninstall", "--yes", "--restore", "--delete-crank");
    expect(snapshot(root)).toEqual({
      ...before,
      ".claude/settings.local.json":
        JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2) + "\n",
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
    fs.appendFileSync(
      codexConfig,
      `[hooks.state."${hooksJson}:SessionStart:0:0"]\ntrusted_hash = "sha256:stale"\n`,
    );
    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(fs.readFileSync(codexConfig, "utf-8")).toBe('model = "gpt-5.6"\n');
  });

  test("pre-existing user settings survive surgical uninstall byte-identical", () => {
    const userSettings =
      JSON.stringify(
        {
          permissions: { allow: ["Bash(ls:*)"] },
          hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
        },
        null,
        2,
      ) + "\n";
    const { root, codexHome } = makeProject({ ".claude/settings.local.json": userSettings });
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    const merged = JSON.parse(
      fs.readFileSync(path.join(root, ".claude/settings.local.json"), "utf-8"),
    );
    expect(merged.hooks.Stop[0].hooks[0].command).toBe("echo done");
    expect(merged.hooks.SessionStart[0].hooks[0].command).toContain(".crank/hooks/");
    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(fs.readFileSync(path.join(root, ".claude/settings.local.json"), "utf-8")).toBe(
      userSettings,
    );
  });

  test("pre-existing literal {} settings file survives surgical uninstall", () => {
    const { root, codexHome } = makeProject({ ".claude/settings.local.json": "{}" });
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    cli(root, codexHome, "uninstall", "--yes", "--keep-crank");
    expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.local.json"), "utf-8")),
    ).toEqual({});
  });

  test("surgical uninstall deletes the settings file init created, allow rule and all", () => {
    const { root, codexHome } = makeProject();
    cli(root, codexHome, "init", "--yes", "--codex", "skip");
    expect(cli(root, codexHome, "uninstall", "--yes", "--keep-crank").status).toBe(0);
    expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(false);
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

  for (const shape of ["plain upgrade", "upgrade with a repair copy"]) {
    test(`restore after a version-changing upgrade returns the project byte-identical (${shape})`, () => {
      const { root, codexHome } = makeProject({
        ".claude/settings.local.json": '{"permissions":{"allow":["Bash(ls:*)"]}}\n',
      });
      const before = snapshot(root);
      expect(cli(root, codexHome, "init", "--yes", "--codex", "merge").status).toBe(0);

      const settings = path.join(root, ".claude/settings.local.json");
      if (shape === "upgrade with a repair copy") {
        const obj = JSON.parse(fs.readFileSync(settings, "utf-8"));
        delete obj.hooks.SessionEnd;
        fs.writeFileSync(settings, JSON.stringify(obj, null, 2) + "\n");
      }
      const cfgPath = path.join(root, ".crank/config.json");
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      cfg.vendored_version = "0.0.1";
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
      const upgrade = cli(root, codexHome, "upgrade");
      expect(upgrade.status).toBe(0);

      const r = fs.realpathSync(root);
      const backups = path.join(root, ".crank", "backups");
      const manifestDirs = fs
        .readdirSync(backups)
        .filter((d) => fs.existsSync(path.join(backups, d, "manifest.json")))
        .sort();
      expect(manifestDirs).toHaveLength(2);
      if (shape === "upgrade with a repair copy") {
        expect(upgrade.stdout).toContain(
          "re-wired Claude Code hooks in .claude/settings.local.json",
        );
        const later = JSON.parse(
          fs.readFileSync(path.join(backups, manifestDirs[1]!, "manifest.json"), "utf-8"),
        );
        expect(later.entries.map((e: { original: string }) => e.original)).toContain(
          path.join(r, ".claude/settings.local.json"),
        );
      }

      const un = cli(root, codexHome, "uninstall", "--yes", "--restore", "--delete-crank");
      expect(un.status).toBe(0);
      expect(snapshot(root)).toEqual(before);
      expect(fs.existsSync(path.join(root, ".crank"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".codex"))).toBe(false);
      expect(un.stdout).toContain(`  restored ${r}/.claude/settings.local.json\n`);
      expect(un.stdout).toContain(`  removed ${r}/.codex/hooks.json (crank-mem created it)\n`);
    }, 20_000);
  }

  test("restore replays a planted later record: inside copies only, never cerebrum or outside paths", () => {
    const { root, codexHome } = makeProject();
    expect(cli(root, codexHome, "init", "--yes", "--codex", "skip").status).toBe(0);
    const r = fs.realpathSync(root);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crank-outside-"));
    fs.writeFileSync(path.join(outside, "z"), "keep\n");
    const entries = [
      { original: path.join(r, ".crank/cerebrum.md"), backupFile: "0-cerebrum.md" },
      { original: "rel/x", backupFile: "1-x" },
      { original: path.join(r, "sub/dir/y.txt"), backupFile: "2-y.txt" },
      { original: path.join(r, "gone.txt"), backupFile: null },
      { original: path.join(r, "made.txt"), backupFile: null },
      { original: path.join(outside, "z"), backupFile: null },
      { original: path.join(outside, "never"), backupFile: null },
    ];
    const dir = plantLaterManifest(
      root,
      JSON.stringify({ createdAt: "2999-01-01T00-00-00-000Z", entries }),
    );
    fs.writeFileSync(path.join(dir, "0-cerebrum.md"), "# Old cerebrum\n");
    fs.writeFileSync(path.join(dir, "1-x"), "old x\n");
    fs.writeFileSync(path.join(dir, "2-y.txt"), "y\n");
    fs.writeFileSync(path.join(root, "made.txt"), "made\n");
    const cerebrumBefore = fs.readFileSync(path.join(root, ".crank/cerebrum.md"), "utf-8");

    const un = cli(root, codexHome, "uninstall", "--yes", "--restore", "--keep-crank");
    expect(un.status).toBe(0);
    expect(fs.readFileSync(path.join(root, ".crank/cerebrum.md"), "utf-8")).toBe(cerebrumBefore);
    expect(un.stdout).not.toContain("cerebrum.md");
    expect(un.stdout).toContain("  left rel/x as is (outside this project)\n");
    expect(fs.existsSync(path.join(root, "rel/x"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "sub/dir/y.txt"), "utf-8")).toBe("y\n");
    expect(un.stdout).toContain(`  restored ${r}/sub/dir/y.txt\n`);
    expect(un.stdout).not.toContain("gone.txt");
    expect(fs.existsSync(path.join(root, "made.txt"))).toBe(false);
    expect(un.stdout).toContain(`  removed ${r}/made.txt (crank-mem created it)\n`);
    expect(un.stdout).toContain(`  left ${path.join(outside, "z")} as is (outside this project)\n`);
    expect(fs.readFileSync(path.join(outside, "z"), "utf-8")).toBe("keep\n");
    expect(un.stdout).toContain(
      `  left ${path.join(outside, "never")} as is (outside this project)\n`,
    );
  });

  test("surgical uninstall deletes a now-empty .gitignore and .codex/config.toml crank-mem created", () => {
    const { root, codexHome } = makeProject();
    const before = snapshot(root);
    expect(
      cli(root, codexHome, "init", "--yes", "--git", "ignore", "--codex", "merge").status,
    ).toBe(0);
    const r = fs.realpathSync(root);
    // A later record saying both files existed: only the earliest entry may decide.
    plantLaterManifest(
      root,
      JSON.stringify({
        createdAt: "2999-01-01T00-00-00-000Z",
        entries: [
          { original: path.join(r, ".gitignore"), backupFile: "0-.gitignore" },
          { original: path.join(r, ".codex/config.toml"), backupFile: "1-config.toml" },
        ],
      }),
    );
    const un = cli(root, codexHome, "uninstall", "--yes", "--delete-crank");
    expect(un.status).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(un.stdout).toContain("  deleted now-empty .gitignore\n");
    expect(un.stdout).toContain("  deleted now-empty .codex/config.toml\n");
  }, 20_000);

  test("surgical uninstall keeps a blank .gitignore and .codex/config.toml that existed before install", () => {
    const { root, codexHome } = makeProject({ ".gitignore": "\n", ".codex/config.toml": "\n" });
    expect(
      cli(root, codexHome, "init", "--yes", "--git", "ignore", "--codex", "merge").status,
    ).toBe(0);
    const un = cli(root, codexHome, "uninstall", "--yes", "--delete-crank");
    expect(un.status).toBe(0);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe("\n");
    expect(fs.readFileSync(path.join(root, ".codex/config.toml"), "utf-8")).toBe("\n");
    expect(un.stdout).not.toContain("deleted now-empty .gitignore");
    expect(un.stdout).not.toContain("deleted now-empty .codex/config.toml");
  }, 20_000);

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

  const notAManifest = (manifest: string): string =>
    `crank-mem: could not read ${manifest} (not a crank-mem manifest) — falling back to surgical removal.`;
  const rewriteInitManifest = (initManifest: string, edit: (m: any) => void): void => {
    const m = JSON.parse(fs.readFileSync(initManifest, "utf-8"));
    edit(m);
    fs.writeFileSync(initManifest, JSON.stringify(m, null, 2));
  };
  const expectEmptySettingsKept = (root: string): void => {
    const settings = path.join(root, ".claude/settings.local.json");
    expect(fs.existsSync(settings)).toBe(true);
    expect(JSON.parse(fs.readFileSync(settings, "utf-8"))).toEqual({});
  };
  const unreadableCases: {
    name: string;
    plant: (root: string, initManifest: string) => void;
    check: (un: CliRun, root: string, r: string, initManifest: string) => void;
  }[] = [
    {
      name: "init's manifest is invalid JSON",
      plant: (_root, initManifest) => fs.writeFileSync(initManifest, "{not json"),
      check: (un, root, _r, initManifest) => {
        expect(un.stderr).toContain(`crank-mem: could not read ${initManifest} (`);
        expect(un.stderr).toContain(" — falling back to surgical removal.");
        expectEmptySettingsKept(root);
      },
    },
    {
      name: "a later manifest is invalid JSON",
      plant: (root) => plantLaterManifest(root, "{not json"),
      check: (un, root, r) => {
        expect(un.stderr).toContain(
          `crank-mem: could not read ${r}/.crank/backups/2999-01-01T00-00-00-000Z/manifest.json (`,
        );
        expectEmptySettingsKept(root);
      },
    },
    {
      name: "init's manifest cannot be read",
      plant: (_root, initManifest) => {
        fs.rmSync(initManifest);
        fs.mkdirSync(initManifest);
      },
      check: (un, _root, _r, initManifest) => {
        expect(un.stderr).toContain(
          `crank-mem: could not read ${initManifest} (EISDIR: illegal operation on a directory, read) — falling back to surgical removal.`,
        );
      },
    },
    ...["../x", "", "a\\b", ".", ".."].map((v) => ({
      name: `backupFile is ${JSON.stringify(v)}`,
      plant: (_root: string, initManifest: string) =>
        rewriteInitManifest(initManifest, (m) => {
          m.entries[0].backupFile = v;
        }),
      check: (un: CliRun, _root: string, _r: string, initManifest: string) => {
        expect(un.stderr).toContain(notAManifest(initManifest));
      },
    })),
    {
      name: "an entry's original is not a string",
      plant: (_root, initManifest) =>
        rewriteInitManifest(initManifest, (m) => {
          m.entries[0].original = 5;
        }),
      check: (un, _root, _r, initManifest) => {
        expect(un.stderr).toContain(notAManifest(initManifest));
      },
    },
    {
      name: "the manifest has no entries",
      plant: (root, initManifest) => {
        fs.writeFileSync(initManifest, '{"createdAt":"x"}');
        plantLaterManifest(root, "{not json");
      },
      check: (un, _root, _r, initManifest) => {
        expect(un.stderr).toContain(notAManifest(initManifest));
        expect(un.stderr).not.toContain("2999-01-01");
      },
    },
    {
      name: "no backups",
      plant: (root) =>
        fs.rmSync(path.join(root, ".crank/backups"), { recursive: true, force: true }),
      check: (un) => {
        expect(un.status).toBe(0);
        expect(un.stderr).toContain(
          "crank-mem: no backups found — falling back to surgical removal.",
        );
      },
    },
  ];
  for (const c of unreadableCases) {
    test(`restore refuses an unreadable record: ${c.name}`, () => {
      const { root, codexHome } = makeProject();
      expect(cli(root, codexHome, "init", "--yes", "--codex", "skip").status).toBe(0);
      const r = fs.realpathSync(root);
      const initManifest = path.join(onlyBackupDir(root), "manifest.json");
      c.plant(root, initManifest);
      const un = cli(root, codexHome, "uninstall", "--yes", "--restore", "--keep-crank");
      c.check(un, root, r, initManifest);
      expect(un.stdout).toContain("  removed crank hooks from .claude/settings.local.json\n");
      if (c.name !== "no backups") {
        expect(un.status).toBe(1);
        expect(un.stdout).toContain("crank-mem: uninstalled.");
        expect(un.stdout).not.toMatch(/^  restored /m);
        expect(un.stdout).not.toMatch(/^  removed .* \(crank-mem created it\)$/m);
      }
    });
  }

  test("restore reports each path it cannot restore and restores the rest", () => {
    const { root, codexHome } = makeProject({
      ".claude/settings.local.json": '{"permissions":{"allow":["Bash(ls:*)"]}}\n',
    });
    const excludeBefore = fs.readFileSync(path.join(root, ".git/info/exclude"));
    expect(cli(root, codexHome, "init", "--yes", "--codex", "skip").status).toBe(0);
    const r = fs.realpathSync(root);
    const dir = onlyBackupDir(root);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
    const entry = manifest.entries.find(
      (e: { original: string }) => e.original === `${r}/.claude/settings.local.json`,
    );
    fs.rmSync(path.join(dir, entry.backupFile));
    plantLaterManifest(
      root,
      JSON.stringify({
        createdAt: "x",
        entries: [{ original: path.join(r, "plain-dir"), backupFile: null }],
      }),
    );
    fs.mkdirSync(path.join(root, "plain-dir"));

    const un = cli(root, codexHome, "uninstall", "--yes", "--restore", "--keep-crank");
    expect(un.status).toBe(1);
    expect(un.stderr).toContain(
      `crank-mem: could not restore ${r}/.claude/settings.local.json (ENOENT)`,
    );
    expect(un.stderr).toContain(`crank-mem: could not restore ${r}/plain-dir (`);
    expect(un.stderr).toMatch(/\/plain-dir \((EPERM|EISDIR)\)$/m);
    expect(un.stdout).toContain(`  restored ${r}/.git/info/exclude\n`);
    expect(fs.readFileSync(path.join(root, ".git/info/exclude"))).toEqual(excludeBefore);
    expect(fs.existsSync(path.join(root, "plain-dir"))).toBe(true);
    expect(un.stdout).toContain("crank-mem: uninstalled.");
  });

  test("two projects share one CODEX_HOME: --restore in one leaves the other's trust entries", () => {
    const A = makeProject();
    const B = makeProject();
    const codexConfig = path.join(A.codexHome, "config.toml");
    const seed = 'model = "gpt-5.6"\n';
    expect(fs.readFileSync(codexConfig, "utf-8")).toBe(seed);
    const beforeA = snapshot(A.root);
    const trustInit = ["init", "--yes", "--codex", "merge", "--codex-trust", "write"];

    expect(cli(A.root, A.codexHome, ...trustInit).status).toBe(0);
    const dir = onlyBackupDir(A.root);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
    const entry = manifest.entries.find((e: { original: string }) => e.original === codexConfig);
    expect(entry).toBeDefined();
    expect(fs.readFileSync(path.join(dir, entry.backupFile), "utf-8")).toBe(seed);
    const afterA = fs.readFileSync(codexConfig, "utf-8");

    expect(cli(B.root, A.codexHome, ...trustInit).status).toBe(0);
    const full = fs.readFileSync(codexConfig, "utf-8");
    expect(full.startsWith(afterA)).toBe(true);
    const bBlocks = full.slice(afterA.length);
    expect(bBlocks).toContain(`[hooks.state."${fs.realpathSync(B.root)}/.codex/hooks.json:`);

    const unA = cli(A.root, A.codexHome, "uninstall", "--yes", "--restore", "--delete-crank");
    expect(unA.status).toBe(0);
    expect(fs.readFileSync(codexConfig, "utf-8")).toBe(seed + bBlocks);
    expect(snapshot(A.root)).toEqual(beforeA);
    expect(unA.stdout).toContain(`  left ${codexConfig} as is (outside this project)\n`);

    const unB = cli(B.root, A.codexHome, "uninstall", "--yes", "--restore", "--delete-crank");
    expect(unB.status).toBe(0);
    expect(fs.readFileSync(codexConfig, "utf-8")).toBe(seed);
  }, 20_000);

  test("a backup manifest lists only the files init wrote", () => {
    const { root, codexHome } = makeProject({ ".gitignore": ".crank/\n" });
    const init = cli(
      root,
      codexHome,
      "init",
      "--yes",
      "--git",
      "ignore",
      "--codex",
      "skip",
      "--codex-trust",
      "write",
    );
    expect(init.status).toBe(0);

    const originals = manifestOriginals(root);
    const realRoot = fs.realpathSync(root);
    expect(originals).toContain(path.join(realRoot, ".claude/settings.local.json"));
    expect(originals).not.toContain(path.join(realRoot, ".gitignore"));
    expect(originals).not.toContain(path.join(codexHome, "config.toml"));
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8")).toBe(
      'model = "gpt-5.6"\n',
    );
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
          {
            hooks: [
              { type: "command", command: '"$CLAUDE_PROJECT_DIR"/crank/hooks/session-start.ts' },
            ],
          },
        ],
      },
    };
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude", "settings.json"),
      JSON.stringify(claude, null, 2) + "\n",
    );

    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n# crank-mem\ncrank/\n");

    const codexHooks = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "crank/hooks/session-start.ts" }] }],
      },
    };
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codex", "hooks.json"),
      JSON.stringify(codexHooks, null, 2) + "\n",
    );
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
    const claude = JSON.parse(
      fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf-8"),
    );
    expect(claude.hooks.SessionStart).toHaveLength(1);
    expect(claude.hooks.SessionStart[0].hooks[0].command).toBe("myOwnTool");
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf-8")).toBe("node_modules\n");
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8")).not.toContain(
      "hooks.state",
    );
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

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "./helpers.ts";
import { crankHooks } from "../src/cli/settings.ts";
import { trustEntriesFromFile } from "../src/cli/codex-trust.ts";

const MAIN = path.join(REPO_ROOT, "src/cli/main.ts");

function cli(cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  return cliWithCodexHome(fs.mkdtempSync(path.join(os.tmpdir(), "crank-ch-")), cwd, ...args);
}

function cliWithCodexHome(codexHome: string, cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
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

  test("counts every indexable file past the cap, so coverage shows what the cap left out", () => {
    const root = initedProject();
    const configPath = path.join(root, ".crank/config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    fs.writeFileSync(configPath, JSON.stringify({ ...config, max_files: 1 }, null, 2));
    fs.writeFileSync(path.join(root, "b.ts"), "export const b = 2;\n");
    expect(cli(root, "scan").status).toBe(0);
    const run = cli(root, "stats");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("files indexed:    1 (capped at max_files 1)");
    expect(run.stdout).toContain("indexable files:  2 (coverage 50%)");
  });
});

// brew-pg's excerpt showed 20 of 35 bullets, 3 of 7 paths OrcaSlicer's
// cerebrum cites are gone, and OrcaSlicer was never audited; stats said none of it.
describe("stats: memory health", () => {
  const DAY = 86_400_000;
  const memory = Array.from({ length: 10 }, (_, i) => `- **m${i}**: note ${i} (2026-09-${String(10 + i)})`);
  const CEREBRUM = [
    "# Cerebrum",
    "",
    "## User Preferences",
    "- prefers tabs (2026-08-01)",
    "",
    "## Memory",
    "- undated note",
    ...memory,
    "- `src/gone.ts` and `docs/kept.md` and `a.ts` and `-Werror=x` (2026-09-30)",
    "- `foo_bar_baz` breaks under `--strict-mode` (2026-10-01)",
    "- again `foo_bar_baz` with `--strict-mode` (2026-10-02)",
  ].join("\n");

  function memoryProject(): string {
    const root = initedProject();
    const crankDir = path.join(root, ".crank");
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs/kept.md"), "# kept\n");
    fs.writeFileSync(path.join(crankDir, "cerebrum.md"), CEREBRUM);
    fs.writeFileSync(
      path.join(crankDir, "journal.md"),
      "# Journal\n\n- 2026-10-01: did a; NEXT: do b\n- 2026-10-02: did b\n- 2026-10-03: did c;\n  NEXT: do d\n",
    );
    return root;
  }

  test("reports what the excerpt leaves out, cited paths, overlaps and unhanded journal entries", () => {
    const run = cli(memoryProject(), "stats");
    expect(run.status).toBe(0);
    // 15 bullets: the 1 preference and the 7 newest memory bullets shown, 7 left to the index.
    expect(run.stdout).toContain("cerebrum bullets: 8 of 15 injected\n");
    expect(run.stdout).toContain("prefs dropped:    0 of 1\n");
    expect(run.stdout).toMatch(/oldest hidden: {4}2026-09-10 \(\d+d ago\), 1 undated\n/);
    expect(run.stdout).toContain("cited paths:      1 of 2 exist\n");
    expect(run.stdout).toContain("overlaps:         1 bullet pair(s) share 2+ identifiers\n");
    expect(run.stdout).toContain("journal no NEXT:  1 of 3 entries\n");
  });

  test("dates the last audit by its manifest-less backup dir and says when the skill is missing", () => {
    const root = memoryProject();
    const fresh = cli(root, "stats").stdout;
    expect(fresh).toMatch(/last audit: {7}never \(installed \d+s ago\); audit skill not installed\n/);

    const audit = path.join(root, ".crank/backups/20260814-165019");
    fs.mkdirSync(audit);
    fs.writeFileSync(path.join(audit, "cerebrum.md"), CEREBRUM);
    fs.utimesSync(audit, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
    // Newer, but not audits: the prune nudge's copies.
    fs.mkdirSync(path.join(root, ".crank/backups/cerebrum"));
    fs.mkdirSync(path.join(root, ".claude/skills/crank-mem-audit"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude/skills/crank-mem-audit/SKILL.md"), "");
    expect(cli(root, "stats").stdout).toContain("last audit:       3d ago\n");
  });

  test("counts nudge parts from debug.log, and says n/a with debug off", () => {
    const root = memoryProject();
    expect(cli(root, "stats").stdout).toContain("nudges:           n/a (debug off)\n");

    const record = (events: object[]) => JSON.stringify({ ts: "2026-09-01T10:00:00.000Z", hook: "stop", events });
    fs.writeFileSync(
      path.join(root, ".crank/debug.log"),
      [
        record([{ event: "nudge-emitted", recordDue: true, journalDue: true, pruneDue: false, auditDue: true }]),
        record([{ event: "nudge-skipped" }, { event: "overlap-checked", added: 1, pairs: 1 }]),
        record([{ event: "nudge-emitted", recordDue: false, journalDue: false, pruneDue: true }]),
        "not json",
      ].join("\n"),
    );
    expect(cli(root, "stats").stdout).toContain(
      "nudges:           record 1, journal 1, prune 1, audit 1, overlap 1 since 2026-09-01\n",
    );
  });
});

describe("stats: codex wiring", () => {
  // A rollout file as Codex writes it: session_meta first, then the thread's records (ADR 0006).
  function rollout(codexHome: string, name: string, meta: Record<string, unknown>, records: object[]): void {
    const ts = String(meta.timestamp);
    const dir = path.join(codexHome, "sessions", ts.slice(0, 4), ts.slice(5, 7), ts.slice(8, 10));
    fs.mkdirSync(dir, { recursive: true });
    const lines = [{ timestamp: ts, type: "session_meta", payload: meta }, ...records].map((r) => JSON.stringify(r));
    fs.writeFileSync(path.join(dir, `rollout-${name}.jsonl`), lines.join("\n") + "\n");
  }
  const turn = { type: "turn_context", payload: {} };
  const injection = {
    type: "response_item",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "## crank-mem (project memory)\n\nThis project keeps" }] },
  };

  function wiredProject(): { root: string; codexHome: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-cli-"));
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "crank-ch-"));
    expect(cliWithCodexHome(codexHome, root, "init", "--yes").status).toBe(0);
    // The CLI sees the resolved cwd (/private/var/... on macOS), so rollouts must too.
    return { root: fs.realpathSync(root), codexHome };
  }

  // OrcaSlicer: 3 of 4 root threads after install got no injection, and
  // nothing in crank-mem reported it.
  test("counts root threads since install that got no injection", () => {
    const { root, codexHome } = wiredProject();
    const later = new Date(Date.now() + 60_000).toISOString();
    rollout(codexHome, "injected", { cwd: root, timestamp: later, thread_source: "user" }, [turn, injection]);
    rollout(codexHome, "missed", { cwd: root, timestamp: later, thread_source: "user" }, [turn]);
    // Not counted: a thread with no turn, a sub-agent, another project, a thread before install.
    rollout(codexHome, "aborted", { cwd: root, timestamp: later, thread_source: "code_review" }, []);
    rollout(codexHome, "sub", { cwd: root, timestamp: later, parent_thread_id: "p", thread_source: "subagent" }, [turn]);
    rollout(codexHome, "other", { cwd: "/elsewhere", timestamp: later }, [turn]);
    rollout(codexHome, "old", { cwd: root, timestamp: "2020-01-01T00:00:00.000Z" }, [turn]);

    const run = cliWithCodexHome(codexHome, root, "stats");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("codex sessions:   1 of 2 root threads since install got no injection");
  });

  test("reports stale and missing hook hashes with the review remediation", () => {
    const { root, codexHome } = wiredProject();
    const [first] = trustEntriesFromFile(path.join(root, ".codex/hooks.json"));
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      `[projects."${root}"]\ntrust_level = "trusted"\n\n[hooks.state."${first!.key}"]\ntrusted_hash = "sha256:${"0".repeat(64)}"\n`
    );
    const run = cliWithCodexHome(codexHome, root, "stats");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("codex hook trust: 0 of 2 hashes current, 1 stale, 1 missing");
    expect(run.stdout).toContain("open codex once in this project and accept the hooks review");
    expect(run.stdout).not.toContain("codex project:");
    expect(run.stdout).not.toContain("--codex-trust write");
  });

  test("current hashes print no remediation; a missing exact-path trust_level is not called untrusted", () => {
    const { root, codexHome } = wiredProject();
    const entries = trustEntriesFromFile(path.join(root, ".codex/hooks.json"));
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      entries.map((e) => `[hooks.state."${e.key}"]\ntrusted_hash = "${e.hash}"\n`).join("\n")
    );
    const run = cliWithCodexHome(codexHome, root, "stats");
    expect(run.stdout).toContain("codex hook trust: 2 of 2 hashes current\n");
    expect(run.stdout).toContain("codex sessions:   no root threads since install");
    expect(run.stdout).toContain("no exact-path trust_level");
    expect(run.stdout).not.toContain("untrusted");
    expect(run.stdout).not.toContain("accept the hooks review");
  });

  test("an exact-path trust_level other than trusted is reported as blocking the hooks", () => {
    const { root, codexHome } = wiredProject();
    fs.writeFileSync(path.join(codexHome, "config.toml"), `[projects."${root}"]\ntrust_level = "untrusted"\n`);
    const run = cliWithCodexHome(codexHome, root, "stats");
    expect(run.stdout).toContain(`codex project:    trust_level = "untrusted", so codex loads no .codex/ hooks here`);
  });

  test("an install without Codex wiring says so and reads no rollouts", () => {
    const run = cli(initedProject(), "stats");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("codex:            not wired");
    expect(run.stdout).not.toContain("codex sessions:");
  });
});

describe("upgrade", () => {
  test("same version is a no-op", () => {
    const root = initedProject();
    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("nothing else to do");
  });

  test("stale stamp: re-vendors, updates stamp, preserves config/cerebrum/index", () => {
    const root = initedProject();
    const crankDir = path.join(root, ".crank");
    // Simulate an old vendored version + user data.
    const configPath = path.join(crankDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config.vendored_version = "0.0.1";
    config.injection_budget_bytes = 1234; // user-tuned value must survive
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    fs.appendFileSync(path.join(crankDir, "cerebrum.md"), "- custom memory\n");
    fs.appendFileSync(path.join(crankDir, "journal.md"), "- 2026-07-29: shipped the thing\n");
    fs.writeFileSync(path.join(crankDir, "hooks/session-start.ts"), "// stale vendored copy\n");
    const indexBefore = fs.readFileSync(path.join(crankDir, "anatomy-index.json"), "utf-8");

    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("upgraded vendored hooks 0.0.1");

    const after = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(after.injection_budget_bytes).toBe(1234);
    expect(after.vendored_version).not.toBe("0.0.1");
    expect(fs.readFileSync(path.join(crankDir, "hooks/session-start.ts"), "utf-8")).not.toContain("stale vendored copy");
    expect(fs.readFileSync(path.join(crankDir, "cerebrum.md"), "utf-8")).toContain("custom memory");
    expect(fs.readFileSync(path.join(crankDir, "journal.md"), "utf-8")).toContain("shipped the thing");
    expect(fs.readFileSync(path.join(crankDir, "anatomy-index.json"), "utf-8")).toBe(indexBefore);
    // old hooks were backed up
    const backups = fs.readdirSync(path.join(crankDir, "backups")).sort();
    const latest = backups[backups.length - 1]!;
    expect(fs.readFileSync(path.join(crankDir, "backups", latest, "hooks/session-start.ts"), "utf-8")).toContain("stale vendored copy");
  });

  // OrcaSlicer: bare commands in settings.local.json from an earlier init,
  // plus wiring in the file the git mode uses, ran every hook twice.
  test("re-wires an install at the current version and drops duplicate wiring", () => {
    const root = initedProject(); // exclude mode: wired into settings.local.json
    const local = path.join(root, ".claude/settings.local.json");
    const shared = path.join(root, ".claude/settings.json");
    const bare = (agent: "claude" | "codex") => {
      const hooks = crankHooks("bun", agent);
      for (const groups of Object.values(hooks)) for (const g of groups) for (const h of g.hooks) h.command = h.command.split(" || ")[1]!;
      return { hooks };
    };
    fs.writeFileSync(local, JSON.stringify(bare("claude")));
    fs.writeFileSync(shared, JSON.stringify(bare("claude")));
    fs.mkdirSync(path.join(root, ".codex"));
    fs.writeFileSync(path.join(root, ".codex/hooks.json"), JSON.stringify(bare("codex")));

    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("removed duplicate crank hooks from .claude/settings.json");
    expect(run.stdout).toContain("accept the hooks review");
    expect(run.stdout).toContain("nothing else to do");
    expect(JSON.parse(fs.readFileSync(local, "utf-8")).hooks).toEqual(crankHooks("bun", "claude"));
    expect(JSON.parse(fs.readFileSync(shared, "utf-8"))).toEqual({});
    expect(JSON.parse(fs.readFileSync(path.join(root, ".codex/hooks.json"), "utf-8")).hooks).toEqual(crankHooks("bun", "codex"));

    // Converged: a second run changes nothing and leaves no new backup.
    const backups = fs.readdirSync(path.join(root, ".crank/backups")).length;
    expect(cli(root, "upgrade").stdout).not.toContain("re-wired");
    expect(fs.readdirSync(path.join(root, ".crank/backups")).length).toBe(backups);
  });

  test("adds SubagentStart to an install wired before it existed and keeps the user's edits", () => {
    const root = initedProject();
    const local = path.join(root, ".claude/settings.local.json");
    const settings = JSON.parse(fs.readFileSync(local, "utf-8"));
    delete settings.hooks.SubagentStart;
    settings.hooks.Stop[0].hooks[0].command = 'bun "$CLAUDE_PROJECT_DIR"/.crank/hooks/stop.ts # mine';
    fs.writeFileSync(local, JSON.stringify(settings));

    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("re-wired Claude Code hooks in .claude/settings.local.json");
    const after = JSON.parse(fs.readFileSync(local, "utf-8")).hooks;
    expect(after.SubagentStart).toEqual(crankHooks("bun", "claude").SubagentStart);
    expect(after.Stop[0].hooks[0].command).toContain("# mine");
  });

  test("leaves a hooks.json without crank entries alone", () => {
    const root = initedProject();
    fs.mkdirSync(path.join(root, ".codex"));
    const own = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } });
    fs.writeFileSync(path.join(root, ".codex/hooks.json"), own);
    expect(cli(root, "upgrade").status).toBe(0);
    expect(fs.readFileSync(path.join(root, ".codex/hooks.json"), "utf-8")).toBe(own);
  });

  // The version stamp gates re-vendoring, not the journal: a deleted journal
  // at the current version would otherwise never come back.
  test("reseeds a deleted journal.md even when the version is current", () => {
    const root = initedProject();
    fs.rmSync(path.join(root, ".crank/journal.md"));

    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("nothing else to do");
    expect(fs.readFileSync(path.join(root, ".crank/journal.md"), "utf-8")).toContain("# Journal");
  });

  test("seeds journal.md on an install that predates it", () => {
    const root = initedProject();
    const crankDir = path.join(root, ".crank");
    const configPath = path.join(crankDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config.vendored_version = "0.0.1";
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    fs.rmSync(path.join(crankDir, "journal.md")); // pre-journal install

    expect(cli(root, "upgrade").status).toBe(0);
    expect(fs.readFileSync(path.join(crankDir, "journal.md"), "utf-8")).toContain("# Journal");
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
    expect(JSON.parse(res.stdout).hookSpecificOutput.additionalContext).toContain("`.crank/anatomy.md` indexes 1 file(s)");
  });
});

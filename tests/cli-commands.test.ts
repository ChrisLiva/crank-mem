import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  initedCopy,
  makeCrankHome,
  makeCrankProject,
  makeModelHome,
  plantMemory,
  runCli,
  runHook,
  seedMemory,
  spoolEntry,
  stopDigests,
  type CliRun,
} from "./helpers.ts";
import { claudeSessionStart } from "./fixtures/payloads.ts";
import { crankHooks } from "../src/cli/settings.ts";
import { crankTrust } from "../src/cli/codex-trust.ts";
import { memoryPath, openMemory } from "../src/hooks/lib/memory.ts";
import { unknownFlag } from "../src/cli/args.ts";
import { COMMANDS, commandHelp, commandSpec } from "../src/cli/commands.ts";
import { cliVersion } from "../src/cli/version.ts";

function cli(cwd: string, ...args: string[]): CliRun {
  return cliWithCodexHome(fs.mkdtempSync(path.join(os.tmpdir(), "crank-ch-")), cwd, ...args);
}

function cliWithCodexHome(codexHome: string, cwd: string, ...args: string[]): CliRun {
  return runCli(cwd, args, { CODEX_HOME: codexHome });
}

const ALPHA = { "a.ts": "/** Alpha. */\nexport const a = 1;\n" };
const LINKED = {
  "src/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
  "src/b.ts": "export const b = 1;\n",
};
const V1_INDEX = '{"version":1,"meta":{"lastScanned":null,"fileCount":0},"files":{}}';
const SCAN_LINE = /^crank-mem: full scan complete — \d+ files indexed → \.crank\/anatomy\.md$/m;

/** A project inited on its own, for a test that reads the install time. */
function initedProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-cli-"));
  fs.writeFileSync(path.join(root, "a.ts"), ALPHA["a.ts"]);
  expect(cli(root, "init", "--yes", "--codex", "skip").status).toBe(0);
  return root;
}

describe("scan", () => {
  test("rebuilds the index and picks up new files", () => {
    const root = initedCopy(ALPHA);
    fs.writeFileSync(path.join(root, "b.ts"), "export const b = 2;\n");
    const run = cli(root, "scan");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("2 files indexed");
    const index = JSON.parse(
      fs.readFileSync(path.join(root, ".crank/anatomy-index.json"), "utf-8"),
    );
    expect(index.files["b.ts"]).toBeDefined();
  });
  test("errors when not initialized", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "crank-bare-"));
    expect(cli(bare, "scan").status).toBe(1);
  });
});

describe("stats", () => {
  test("counts every indexable file past the cap, so coverage shows what the cap left out", () => {
    const root = initedCopy(ALPHA);
    const uncapped = cli(root, "stats");
    expect(uncapped.status).toBe(0);
    expect(uncapped.stdout).toContain("files indexed:    1\n");
    expect(uncapped.stdout).toContain("indexable files:  1 (coverage 100%)");
    expect(uncapped.stdout).toMatch(/runtime: {10}(bun|node)/);
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

describe("stats: memory health", () => {
  const DAY = 86_400_000;
  const memory = Array.from(
    { length: 10 },
    (_, i) => `- **m${i}**: note ${i} (2026-09-${String(10 + i)})`,
  );
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

  function memoryProject(root = initedCopy(ALPHA)): string {
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

  test("reports what the excerpt leaves out and cited paths", () => {
    const run = cli(memoryProject(), "stats");
    expect(run.status).toBe(0);
    // 15 bullets: the 1 preference and the 7 newest memory bullets shown, 7 left to the index.
    expect(run.stdout).toContain("cerebrum bullets: 8 of 15 injected\n");
    expect(run.stdout).toContain("prefs dropped:    0 of 1\n");
    expect(run.stdout).toMatch(/oldest hidden: {4}2026-09-10 \(\d+d ago\), 1 undated\n/);
    expect(run.stdout).toContain("cited paths:      1 of 2 exist\n");
    // No upkeep rows: nothing writes the journal, flags overlaps or nudges any more.
    expect(run.stdout).not.toMatch(/^ {2}(?:journal|overlaps:|nudges:)/m);
    expect(run.stdout).toContain("  last audit:");
  });

  test("a hidden bullet whose only date does not parse counts as undated", () => {
    const root = memoryProject();
    const file = path.join(root, ".crank/cerebrum.md");
    fs.writeFileSync(
      file,
      CEREBRUM.replace("- undated note", "- MySQL zero date `0000-00-00` breaks the importer"),
    );
    const run = cli(root, "stats");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/oldest hidden: {4}2026-09-10 \(\d+d ago\), 1 undated\n/);
  });

  test("counts the excerpt the session's usage line records when a drift note costs it a bullet, and writes no debug line", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;\n" });
    const crankDir = path.join(root, ".crank");
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "crank-clone-"));
    fs.writeFileSync(
      path.join(clone, "package.json"),
      JSON.stringify({ name: "crank-mem", version: "0.5.0" }),
    );
    const configFile = path.join(crankDir, "config.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(configFile, "utf-8")),
        vendored_version: "0.3.2",
        clone_root: clone,
        injection_budget_bytes: 1340,
        debug: true,
      }),
    );
    const mem = Array.from(
      { length: 6 },
      (_, i) => `- **m${i}**: a memory note about thing ${i} (2026-09-1${i})`,
    );
    const cerebrum = path.join(crankDir, "cerebrum.md");
    fs.writeFileSync(
      cerebrum,
      `# Cerebrum\n\n## User Preferences\n- prefers tabs\n\n## Memory\n${mem.join("\n")}\n`,
    );

    const hook = runHook(
      "src/hooks/session-start.ts",
      JSON.stringify(claudeSessionStart(root)),
      root,
      {
        CRANK_HOME: makeCrankHome(),
      },
    );
    expect(hook.status).toBe(0);
    const line = JSON.parse(
      fs.readFileSync(path.join(crankDir, "usage.jsonl"), "utf-8").split("\n")[0]!,
    );
    const { shown, total } = line.cerebrumBullets;
    expect(shown).toBeLessThan(total); // the drift note costs the excerpt a bullet

    const logFile = path.join(crankDir, "debug.log");
    const log = fs.readFileSync(logFile, "utf-8");
    const stats = cli(root, "stats");
    expect(stats.status).toBe(0);
    expect(stats.stdout).toContain(`cerebrum bullets: ${shown} of ${total} injected\n`);
    expect(fs.readFileSync(logFile, "utf-8")).toBe(log);

    fs.rmSync(cerebrum);
    const missing = cli(root, "stats").stdout;
    expect(missing).toContain("  cerebrum:         missing\n");
    expect(missing).not.toContain("cerebrum bullets:");
    fs.writeFileSync(cerebrum, "");
    const empty = cli(root, "stats").stdout;
    expect(empty).toContain("  cerebrum:         empty\n");
    expect(empty).not.toContain("cerebrum bullets:");
  }, 20_000);

  test("dates the last audit by its manifest-less backup dir and says when the skill is missing", () => {
    // The copy keeps the template's install time, which can pass the 60 s this line prints as seconds.
    const root = memoryProject(initedProject());
    const fresh = cli(root, "stats").stdout;
    expect(fresh).toMatch(
      /last audit: {7}never \(installed \d+s ago\); audit skill not installed\n/,
    );

    const audit = path.join(root, ".crank/backups/20260814-165019");
    fs.mkdirSync(audit);
    fs.writeFileSync(path.join(audit, "cerebrum.md"), CEREBRUM);
    fs.utimesSync(audit, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
    // Newer, but not an audit: backups/cerebrum/ holds timestamped cerebrum copies.
    fs.mkdirSync(path.join(root, ".crank/backups/cerebrum"));
    fs.mkdirSync(path.join(root, ".claude/skills/crank-mem-audit"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude/skills/crank-mem-audit/SKILL.md"), "");
    expect(cli(root, "stats").stdout).toContain("last audit:       3d ago\n");
  });
});

describe("stats: capture health", () => {
  // The capture rows in their order, each label padded to the value column.
  const CAPTURE_ROWS =
    /\n {2}status: .*\n {2}digest: .*\n {2}daemon: .*\n {2}spool: .*\n(?: {2}(?:observations|unembedded|last digest|month cost|proposals|stale|consolidation|memory|last snapshot): .*\n)+ {2}embedder: /;

  function digestOn(root: string): void {
    expect(runCli(root, ["digest", "on"]).status).toBe(0);
  }

  test("reports digest state, daemon, user-wide spool, the store's counts and month cost, and the embedder", () => {
    const root = initedCopy(ALPHA);
    digestOn(root);
    seedMemory(root, [{ title: "first a" }, { title: "first b" }], { costUsd: 0.01 });
    seedMemory(root, [{ title: "second a" }], { costUsd: 0.02 });
    const home = makeCrankHome();
    stopDigests(home);
    spoolEntry(home, "waiting", "/elsewhere", Date.now());
    spoolEntry(home, "stuck", root, Date.now(), true);
    fs.writeFileSync(path.join(home, "spool", "null.json"), "null");
    fs.writeFileSync(path.join(home, "spool", "array.json"), "[]");
    fs.writeFileSync(path.join(home, "spool", "number.json"), "42");

    const run = runCli(root, ["stats"], { CRANK_HOME: home });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(CAPTURE_ROWS);
    expect(run.stdout).toContain("  digest:           stopped (login)\n");
    expect(run.stdout).toContain("  daemon:           not running\n");
    expect(run.stdout).toContain("  spool:            1 waiting, 1 parked\n");
    expect(run.stdout).toContain("  observations:     3\n");
    // Seeded rows carry no vector.
    expect(run.stdout).toContain("  unembedded:       3\n");
    expect(run.stdout).toMatch(/ {2}last digest: {6}\d+s ago\n/);
    expect(run.stdout).toContain("  month cost:       $0.03 (list price)\n");
    expect(run.stdout).toContain("  proposals:        0\n");
    expect(run.stdout).toContain("  stale:            0\n");
    expect(run.stdout).toContain("  embedder:         not ready (run crank-mem setup)\n");

    fs.writeFileSync(
      path.join(home, "daemon.json"),
      JSON.stringify({ pid: process.pid, version: "0.8.0", heartbeatMs: Date.now() }),
    );
    expect(runCli(root, ["stats"], { CRANK_HOME: home }).stdout).toContain(
      "  daemon:           alive\n",
    );

    const ready = runCli(root, ["stats"], { CRANK_HOME: makeModelHome() }).stdout;
    expect(ready).toContain("  embedder:         ready\n");
    expect(ready).toContain("  digest:           on\n");
    expect(ready).toContain("  spool:            0 waiting, 0 parked\n");
  });

  test("counts pending proposals and stale rows after the month cost", () => {
    const root = initedCopy(ALPHA);
    const [a] = seedMemory(root, [
      { title: "Lock retry is two seconds" },
      { title: "Lock files live in .crank" },
    ]) as [number];
    seedMemory(root, [], { stale: [{ id: a, reason: "retry is 5 s now" }] });
    seedMemory(root, [], { proposals: [{ kind: "memory", bullet: "- **P**: x" }] });
    const out = cli(root, "stats").stdout;
    expect(out).toMatch(CAPTURE_ROWS);
    expect(out).toContain("  month cost:       $0.00 (list price)\n");
    expect(out).toMatch(
      /\n {2}month cost: .*\n {2}proposals: {8}1\n {2}stale: {12}1\n {2}consolidation: {4}never\n {2}last snapshot: {4}never\n {2}embedder: /,
    );
  });

  test("shows the last consolidation after the stale row, and counts its cost in the month", () => {
    const root = initedCopy(ALPHA);
    seedMemory(root, [{ title: "one digest" }], { costUsd: 0.002152 });
    const before = cli(root, "stats").stdout;
    expect(before).toContain("\n  consolidation:    never\n");
    expect(before).toContain("  month cost:       $0.0022 (list price)\n");
    const opened = openMemory(memoryPath(root), "write");
    if (opened.status !== "open") throw new Error(`store is ${opened.status}`);
    try {
      opened.memory.recordConsolidation({
        outcome: "ok",
        startedMs: Date.now(),
        model: "m",
        costUsd: 0.003,
        sent: [],
        decided: [],
        verdicts: [],
      });
    } finally {
      opened.memory.close();
    }
    const out = cli(root, "stats").stdout;
    expect(out).toMatch(CAPTURE_ROWS);
    expect(out).toMatch(/\n {2}stale: .*\n {2}consolidation: {4}\d+s ago \(ok\)\n/);
    expect(out).toMatch(/^  consolidation:    \d+s ago \(ok\)$/m);
    expect(out).toContain("  month cost:       $0.0052 (list price)\n");
  });

  test("digest off by default, and one memory row stands in for a store that is missing, newer or unreadable", () => {
    const root = initedCopy(ALPHA);
    const fresh = cli(root, "stats").stdout;
    expect(fresh).toMatch(CAPTURE_ROWS);
    expect(fresh).toContain("  digest:           off\n");
    expect(fresh).toContain("\n  memory:           none yet\n  last snapshot:    never\n");
    expect(fresh).not.toContain("observations:");
    expect(fresh).not.toContain("month cost:");

    plantMemory(root, "newer");
    expect(cli(root, "stats").stdout).toContain(
      "  memory:           newer than this version; run crank-mem upgrade\n",
    );

    fs.rmSync(path.join(root, ".crank/memory.db"));
    plantMemory(root, "unreadable");
    const bad = cli(root, "stats");
    expect(bad.status).toBe(0);
    expect(bad.stdout).toContain("  memory:           unreadable\n");
  });
});

describe("stats: codex wiring", () => {
  // A rollout file as Codex writes it: session_meta first, then the thread's records (ADR 0006).
  function rollout(
    codexHome: string,
    name: string,
    meta: Record<string, unknown>,
    records: object[],
  ): void {
    const ts = String(meta.timestamp);
    const dir = path.join(codexHome, "sessions", ts.slice(0, 4), ts.slice(5, 7), ts.slice(8, 10));
    fs.mkdirSync(dir, { recursive: true });
    const lines = [{ timestamp: ts, type: "session_meta", payload: meta }, ...records].map((r) =>
      JSON.stringify(r),
    );
    fs.writeFileSync(path.join(dir, `rollout-${name}.jsonl`), lines.join("\n") + "\n");
  }
  const turn = { type: "turn_context", payload: {} };
  const injection = {
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [
        { type: "input_text", text: "## crank-mem (project memory)\n\nThis project keeps" },
      ],
    },
  };

  function wiredProject(): { root: string; codexHome: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-cli-"));
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "crank-ch-"));
    expect(cliWithCodexHome(codexHome, root, "init", "--yes").status).toBe(0);
    // The CLI sees the resolved cwd (/private/var/... on macOS), so rollouts must too.
    return { root: fs.realpathSync(root), codexHome };
  }

  test("counts root threads since install that got no injection", () => {
    const { root, codexHome } = wiredProject();
    const later = new Date(Date.now() + 60_000).toISOString();
    rollout(codexHome, "injected", { cwd: root, timestamp: later, thread_source: "user" }, [
      turn,
      injection,
    ]);
    rollout(codexHome, "missed", { cwd: root, timestamp: later, thread_source: "user" }, [turn]);
    // Not counted: a thread with no turn, a sub-agent, another project, a thread before install.
    rollout(
      codexHome,
      "aborted",
      { cwd: root, timestamp: later, thread_source: "code_review" },
      [],
    );
    rollout(
      codexHome,
      "sub",
      { cwd: root, timestamp: later, parent_thread_id: "p", thread_source: "subagent" },
      [turn],
    );
    rollout(codexHome, "other", { cwd: "/elsewhere", timestamp: later }, [turn]);
    rollout(codexHome, "old", { cwd: root, timestamp: "2020-01-01T00:00:00.000Z" }, [turn]);

    const run = cliWithCodexHome(codexHome, root, "stats");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      "codex sessions:   1 of 2 root threads since install got no injection",
    );
    expect(run.stdout).toMatch(/\n {2}embedder: .*\n(?:.*\n)* {2}codex sessions: /);
  });

  test("reports stale and missing hook hashes with the review remediation", () => {
    const { root, codexHome } = wiredProject();
    const [first] = crankTrust(path.join(root, ".codex/hooks.json")).entries;
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      `[projects."${root}"]\ntrust_level = "trusted"\n\n[hooks.state."${first!.key}"]\ntrusted_hash = "sha256:${"0".repeat(64)}"\n`,
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
    const entries = crankTrust(path.join(root, ".codex/hooks.json")).entries;
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      entries.map((e) => `[hooks.state."${e.key}"]\ntrusted_hash = "${e.hash}"\n`).join("\n"),
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
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      `[projects."${root}"]\ntrust_level = "untrusted"\n`,
    );
    const run = cliWithCodexHome(codexHome, root, "stats");
    expect(run.stdout).toContain(
      `codex project:    trust_level = "untrusted", so codex loads no .codex/ hooks here`,
    );
  });

  test("an install without Codex wiring says so and reads no rollouts", () => {
    const run = cli(initedCopy(ALPHA), "stats");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("codex:            not wired");
    expect(run.stdout).toMatch(/\n {2}embedder: .*\n {2}codex: {12}not wired/);
    expect(run.stdout).not.toContain("codex sessions:");
  });
});

describe("upgrade", () => {
  test("stale stamp: re-vendors, updates stamp, preserves config/cerebrum/index", () => {
    const root = initedCopy(ALPHA);
    const crankDir = path.join(root, ".crank");
    // Simulate an old vendored version + user data.
    const configPath = path.join(crankDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config.vendored_version = "0.10.0";
    config.injection_budget_bytes = 1234; // user-tuned value must survive
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    fs.appendFileSync(path.join(crankDir, "cerebrum.md"), "- custom memory\n");
    fs.appendFileSync(path.join(crankDir, "journal.md"), "- 2026-07-29: shipped the thing\n");
    fs.writeFileSync(path.join(crankDir, "hooks/session-start.ts"), "// stale vendored copy\n");
    const indexBefore = fs.readFileSync(path.join(crankDir, "anatomy-index.json"), "utf-8");

    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd().split("\n").at(-1)).toBe(
      `crank-mem: upgraded vendored hooks 0.10.0 → ${cliVersion()}`,
    );
    expect(run.stdout).not.toContain("re-vendored");

    const after = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(after.injection_budget_bytes).toBe(1234);
    expect(after.vendored_version).toBe(cliVersion());
    expect(fs.readFileSync(path.join(crankDir, "hooks/session-start.ts"), "utf-8")).not.toContain(
      "stale vendored copy",
    );
    expect(fs.readFileSync(path.join(crankDir, "cerebrum.md"), "utf-8")).toContain("custom memory");
    expect(fs.readFileSync(path.join(crankDir, "journal.md"), "utf-8")).toContain(
      "shipped the thing",
    );
    expect(fs.readFileSync(path.join(crankDir, "anatomy-index.json"), "utf-8")).toBe(indexBefore);
    // old hooks were backed up
    const backups = fs.readdirSync(path.join(crankDir, "backups")).sort();
    const latest = backups[backups.length - 1]!;
    expect(
      fs.readFileSync(path.join(crankDir, "backups", latest, "hooks/session-start.ts"), "utf-8"),
    ).toContain("stale vendored copy");
  });

  test("scans an index that is not at version 2, and leaves a version-2 one alone", () => {
    const root = initedCopy(LINKED);
    const indexFile = path.join(root, ".crank/anatomy-index.json");
    fs.writeFileSync(indexFile, V1_INDEX);

    const first = cli(root, "upgrade");
    expect(first.status).toBe(0);
    expect(first.stdout.match(new RegExp(SCAN_LINE.source, "gm"))).toHaveLength(1);
    const lines = first.stdout.trimEnd().split("\n");
    const repairLast = lines.findLastIndex((l) =>
      /^crank-mem: (already at|upgraded vendored hooks) /.test(l),
    );
    expect(repairLast).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex((l) => SCAN_LINE.test(l))).toBeGreaterThan(repairLast);
    const rebuilt = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
    expect(rebuilt.version).toBe(2);
    expect(rebuilt.files["src/a.ts"].imports).toEqual(["src/b.ts"]);

    const current = fs.readFileSync(indexFile);
    const second = cli(root, "upgrade");
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain("full scan complete");
    expect(fs.readFileSync(indexFile)).toEqual(current);

    // A missing index is built under the project's own config.
    fs.rmSync(indexFile);
    const configFile = path.join(root, ".crank/config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    config.excludes.push("b.ts");
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    const missing = cli(root, "upgrade");
    expect(missing.status).toBe(0);
    expect(missing.stdout).toMatch(SCAN_LINE);
    const built = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
    expect(built.version).toBe(2);
    expect(Object.keys(built.files)).not.toContain("src/b.ts");
    expect(built.files["src/a.ts"]).not.toHaveProperty("imports");

    fs.writeFileSync(indexFile, "{not json");
    const unparsable = cli(root, "upgrade");
    expect(unparsable.status).toBe(0);
    expect(unparsable.stdout).toMatch(SCAN_LINE);
    expect(JSON.parse(fs.readFileSync(indexFile, "utf-8")).version).toBe(2);
  });

  test("a held anatomy lock skips the scan", () => {
    const root = initedCopy(LINKED);
    const indexFile = path.join(root, ".crank/anatomy-index.json");
    fs.writeFileSync(indexFile, V1_INDEX);
    fs.writeFileSync(
      path.join(root, ".crank/anatomy-index.lock"),
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() }),
    );
    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stderr.split("\n")).toContain("crank-mem: anatomy busy, scan skipped");
    expect(fs.readFileSync(indexFile, "utf-8")).toBe(V1_INDEX);
  }, 20_000);

  test("a scan that throws costs only the scan", () => {
    const root = initedCopy(LINKED);
    const indexFile = path.join(root, ".crank/anatomy-index.json");
    fs.rmSync(indexFile);
    fs.mkdirSync(indexFile);
    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("crank-mem: could not scan (");
    expect(run.stdout).not.toContain("full scan complete");
  });

  // Crank commands in the settings file the git mode does not use, plus wiring
  // in the one it does use, run every hook twice.
  test("re-wires an install at the current version and drops duplicate wiring", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-cli-"));
    fs.writeFileSync(path.join(root, "a.ts"), "/** Alpha. */\nexport const a = 1;\n");
    // exclude mode: wired into settings.local.json
    expect(cli(root, "init", "--yes", "--codex", "merge", "--codex-trust", "skip").status).toBe(0);
    const local = path.join(root, ".claude/settings.local.json");
    const shared = path.join(root, ".claude/settings.json");
    const bare = (agent: "claude" | "codex") => {
      const hooks = crankHooks("bun", agent);
      for (const groups of Object.values(hooks))
        for (const g of groups) for (const h of g.hooks) h.command = h.command.split(" || ")[1]!;
      return { hooks };
    };
    fs.writeFileSync(local, JSON.stringify(bare("claude")));
    fs.writeFileSync(shared, JSON.stringify(bare("claude")));
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex/hooks.json"), JSON.stringify(bare("codex")));

    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("removed duplicate crank hooks from .claude/settings.json");
    expect(run.stdout).toContain("accept the hooks review");
    expect(run.stdout).toContain("nothing else to do");
    expect(JSON.parse(fs.readFileSync(local, "utf-8")).hooks).toEqual(crankHooks("bun", "claude"));
    expect(JSON.parse(fs.readFileSync(shared, "utf-8"))).toEqual({});
    expect(
      JSON.parse(fs.readFileSync(path.join(root, ".codex/hooks.json"), "utf-8")).hooks,
    ).toEqual(crankHooks("bun", "codex"));

    // Converged: a second run changes nothing and leaves no new backup.
    const backups = fs.readdirSync(path.join(root, ".crank/backups")).length;
    expect(cli(root, "upgrade").stdout).not.toContain("re-wired");
    expect(fs.readdirSync(path.join(root, ".crank/backups")).length).toBe(backups);
  });

  test("upgrade swaps the legacy allow rule for the crank-mem rules, once, keeping the user's other rules", () => {
    const root = initedCopy(ALPHA);
    const local = path.join(root, ".claude/settings.local.json");
    const settings = JSON.parse(fs.readFileSync(local, "utf-8"));
    settings.permissions = { allow: ["Bash(ls:*)", "Bash(crank-mem *)"], deny: ["x"] };
    fs.writeFileSync(local, JSON.stringify(settings, null, 2) + "\n");
    const backups = fs.readdirSync(path.join(root, ".crank/backups")).length;

    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("  added the crank-mem rules to permissions.allow");
    const after = JSON.parse(fs.readFileSync(local, "utf-8"));
    expect(after.permissions).toEqual({
      allow: [
        "Bash(ls:*)",
        "Bash(crank-mem search *)",
        "Bash(crank-mem timeline *)",
        "Bash(crank-mem get *)",
        "Bash(crank-mem outline *)",
        "Bash(crank-mem unfold *)",
      ],
      deny: ["x"],
    });
    expect(after.hooks).toEqual(settings.hooks);

    const withRule = fs.readdirSync(path.join(root, ".crank/backups")).length;
    expect(withRule).toBe(backups + 1);
    const again = cli(root, "upgrade");
    expect(again.stdout).not.toContain("added the crank-mem rules");
    expect(fs.readdirSync(path.join(root, ".crank/backups")).length).toBe(withRule);

    // An install holding only the three recall rules gains the two code-reading rules.
    settings.permissions = {
      allow: [
        "Bash(ls:*)",
        "Bash(crank-mem search *)",
        "Bash(crank-mem timeline *)",
        "Bash(crank-mem get *)",
      ],
    };
    fs.writeFileSync(local, JSON.stringify(settings, null, 2) + "\n");
    const three = cli(root, "upgrade");
    expect(three.status).toBe(0);
    expect(three.stdout.split("  added the crank-mem rules to permissions.allow").length).toBe(2);
    expect(JSON.parse(fs.readFileSync(local, "utf-8")).permissions.allow).toEqual([
      "Bash(ls:*)",
      "Bash(crank-mem search *)",
      "Bash(crank-mem timeline *)",
      "Bash(crank-mem get *)",
      "Bash(crank-mem outline *)",
      "Bash(crank-mem unfold *)",
    ]);
    const converged = fs.readFileSync(local);
    expect(cli(root, "upgrade").stdout).not.toContain("added the crank-mem rules");
    expect(fs.readFileSync(local).equals(converged)).toBe(true);
  }, 20_000);

  test("wires SessionEnd and file history into an install from before 0.8.0 and leaves memory.db untouched", () => {
    const root = initedCopy(ALPHA);
    const crankDir = path.join(root, ".crank");
    const configPath = path.join(crankDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    config.vendored_version = "0.7.0";
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const local = path.join(root, ".claude/settings.local.json");
    const settings = JSON.parse(fs.readFileSync(local, "utf-8"));
    delete settings.hooks.SessionEnd;
    delete settings.hooks.SubagentStart;
    settings.hooks.Stop[0].hooks[0].command =
      'bun "$CLAUDE_PROJECT_DIR"/.crank/hooks/stop.ts # mine';
    settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
      (g: { matcher?: string }) => g.matcher !== "Read|Bash",
    );
    fs.writeFileSync(local, JSON.stringify(settings));
    fs.rmSync(path.join(crankDir, "hooks/post-read.ts"));
    seedMemory(root, [{ title: "Kept across upgrade" }]);
    const store = path.join(crankDir, "memory.db");
    const sha = () => crypto.createHash("sha256").update(fs.readFileSync(store)).digest("hex");
    const before = sha();

    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`upgraded vendored hooks 0.7.0 → ${cliVersion()}`);
    expect(run.stdout).toContain("re-wired Claude Code hooks in .claude/settings.local.json");
    const after = JSON.parse(fs.readFileSync(local, "utf-8")).hooks;
    const wired = crankHooks("bun", "claude");
    expect(after.SubagentStart).toEqual(wired.SubagentStart);
    expect(after.Stop[0].hooks[0].command).toContain("# mine");
    expect(after.SessionEnd).toHaveLength(1);
    expect(after.SessionEnd).toEqual(wired.SessionEnd);
    expect(after.PostToolUse.map((g: { matcher?: string }) => g.matcher)).toEqual([
      "Write|Edit|MultiEdit",
      "Read|Bash",
    ]);
    expect(after.PostToolUse).toEqual(wired.PostToolUse);
    expect(fs.existsSync(path.join(crankDir, "hooks/post-read.ts"))).toBe(true);
    expect(sha()).toBe(before);
  });

  test("leaves a hooks.json without crank entries alone", () => {
    const root = initedCopy(ALPHA);
    fs.mkdirSync(path.join(root, ".codex"));
    const own = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
    });
    fs.writeFileSync(path.join(root, ".codex/hooks.json"), own);
    expect(cli(root, "upgrade").status).toBe(0);
    expect(fs.readFileSync(path.join(root, ".codex/hooks.json"), "utf-8")).toBe(own);
  });

  test("seeds no journal.md and keeps an existing one byte for byte", () => {
    const root = initedCopy(ALPHA);
    const journal = path.join(root, ".crank/journal.md");
    expect(fs.existsSync(journal)).toBe(false);

    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("nothing else to do");
    expect(run.stdout).not.toContain("seeded .crank/journal.md");
    expect(fs.existsSync(journal)).toBe(false);

    const kept = "# Journal\n\n- 2026-10-01: did a; NEXT: do b — ünïcode\n";
    fs.writeFileSync(journal, kept);
    expect(cli(root, "upgrade").status).toBe(0);
    expect(fs.readFileSync(journal, "utf-8")).toBe(kept);
  });

  // 0.8.1 and earlier seeded the cerebrum with a protocol preamble; frozen here.
  function frozenPreamble(): string {
    const text = fs.readFileSync(
      path.join(import.meta.dir, "../src/templates/cerebrum-preamble-0.8.1.md"),
      "utf-8",
    );
    expect(Buffer.byteLength(text)).toBe(375);
    expect(crypto.createHash("sha256").update(text).digest("hex")).toBe(
      "3439e3f1b33c1c6286c0f1537a324567e5515a1a0d63e3f05c414de73452850d",
    );
    return text;
  }

  test("replaces an unedited template preamble once, after backing up the cerebrum", () => {
    const root = initedCopy(ALPHA);
    const crankDir = path.join(root, ".crank");
    const cerebrum = path.join(crankDir, "cerebrum.md");
    const old = Buffer.concat([
      Buffer.from(frozenPreamble()),
      Buffer.from("## Memory\n- x "),
      Buffer.from([0xff]),
      Buffer.from("\n"),
    ]);
    fs.writeFileSync(cerebrum, old);

    const run = cli(root, "upgrade");
    expect(run.status).toBe(0);
    expect(run.stdout.split("\n")).toContain(
      "  replaced the template preamble of .crank/cerebrum.md",
    );
    expect(
      fs
        .readFileSync(cerebrum)
        .equals(
          Buffer.concat([
            Buffer.from("# Cerebrum\n\n## Memory\n- x "),
            Buffer.from([0xff]),
            Buffer.from("\n"),
          ]),
        ),
    ).toBe(true);

    const copies = path.join(crankDir, "backups/cerebrum");
    const names = fs.readdirSync(copies).filter((f) => f.endsWith(".md"));
    expect(names).toHaveLength(1);
    expect(fs.readFileSync(path.join(copies, names[0]!)).equals(old)).toBe(true);

    const backups = path.join(crankDir, "backups");
    for (const dir of fs.readdirSync(backups)) {
      const file = path.join(backups, dir, "manifest.json");
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, "utf-8"));
      expect(
        manifest.entries.some((e: { original: string }) =>
          e.original.endsWith("/.crank/cerebrum.md"),
        ),
      ).toBe(false);
    }

    const listing = fs.readdirSync(backups);
    const copyListing = fs.readdirSync(copies);
    const again = cli(root, "upgrade");
    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain("replaced the template preamble");
    expect(fs.readdirSync(backups)).toEqual(listing);
    expect(fs.readdirSync(copies)).toEqual(copyListing);
  });

  test("keeps an edited preamble, and a cerebrum whose backup fails, byte for byte", () => {
    const root = initedCopy(ALPHA);
    const crankDir = path.join(root, ".crank");
    const cerebrum = path.join(crankDir, "cerebrum.md");
    const edited = [
      "# Cerebrum\n\nMy own notes.\n\n## Memory\n",
      frozenPreamble() + "- no heading — ünïcode (2026-10-01)\n",
      "",
    ];
    for (const text of edited) {
      fs.writeFileSync(cerebrum, text);
      const run = cli(root, "upgrade");
      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain("replaced the template preamble");
      expect(fs.readFileSync(cerebrum, "utf-8")).toBe(text);
    }

    const unedited = frozenPreamble() + "## Memory\n";
    fs.writeFileSync(cerebrum, unedited);
    const backups = path.join(crankDir, "backups");
    fs.chmodSync(backups, 0o555);
    try {
      const run = cli(root, "upgrade");
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        "crank-mem: could not replace the template preamble of .crank/cerebrum.md (",
      );
      expect(fs.readFileSync(cerebrum, "utf-8")).toBe(unedited);
    } finally {
      fs.chmodSync(backups, 0o755);
    }
  }, 20_000);
});

const COMMAND_NAMES = [
  "init",
  "scan",
  "digest",
  "search",
  "timeline",
  "get",
  "outline",
  "unfold",
  "restore-memory",
  "setup",
  "stats",
  "dashboard",
  "upgrade",
  "uninstall",
  "daemon",
  "job",
];

describe("flags (in-process)", () => {
  test("every command has a spec whose help starts with its usage line and carries its summary", () => {
    for (const name of COMMAND_NAMES) {
      const spec = commandSpec(name);
      expect([name, spec !== undefined]).toEqual([name, true]);
      const help = commandHelp(spec!);
      expect([name, help.startsWith(`Usage: crank-mem ${name}`)]).toEqual([name, true]);
      if (spec!.summary) expect(help).toContain(spec!.summary);
      else expect([name, help]).toEqual([name, spec!.usage]);
    }
    expect(["daemon", "job"].map((name) => commandSpec(name)!.summary)).toEqual([
      undefined,
      undefined,
    ]);
    expect(commandSpec("toString")).toBeUndefined();
    expect(commandSpec("search")!.unknownIsText).toBe(true);
  });

  test("job --help hides the job's test flags", () => {
    const help = commandHelp(COMMANDS.job);
    expect(help).toBe("Usage: crank-mem job <stem> (internal: the daemon runs it)");
    for (const word of ["consolidate", "maintain", "stale"]) expect(help).not.toContain(word);
  });

  test("an unknown flag is named, and every known flag passes", () => {
    for (const [name, argv, flag] of [
      ["init", ["--yes", "--bogus"], "bogus"],
      ["uninstall", ["--yes", "--force"], "force"],
      ["upgrade", ["--dry-run"], "dry-run"],
      ["scan", ["--full"], "full"],
      ["init", ["--git=commit"], "git=commit"],
      ["job", ["s1", "--bogus"], "bogus"],
      ["job", ["s1", "--maintain-every-ms"], "maintain-every-ms"],
      ["job", ["s1", "--stale-keep-ms"], "stale-keep-ms"],
    ] as const) {
      const spec = commandSpec(name)!;
      expect([name, argv, unknownFlag([...argv], spec.value, spec.bool)]).toEqual([
        name,
        argv,
        flag,
      ]);
    }
    for (const name of COMMAND_NAMES) {
      const spec = commandSpec(name)!;
      const argv = [
        ...spec.value.flatMap((f) => [`--${f}`, "1"]),
        ...spec.bool.map((f) => `--${f}`),
      ];
      expect([name, unknownFlag(argv, spec.value, spec.bool)]).toEqual([name, null]);
    }
  });
});

describe("flags", () => {
  test("init --help and -h in a fresh directory install nothing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-help-"));
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    const home = makeCrankHome();
    for (const help of ["--help", "-h"]) {
      const run = runCli(root, ["init", help], { CRANK_HOME: home });
      expect([help, run.status]).toEqual([help, 0]);
      expect(run.stdout).toContain("--git commit|ignore|exclude");
    }
    expect(fs.readdirSync(root)).toEqual(["a.ts"]);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  test("an unknown flag exits 1 before anything is written", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "crank-flag-"));
    const init = cli(fresh, "init", "--yes", "--bogus");
    expect(init.status).toBe(1);
    expect(init.stderr).toContain("crank-mem: unknown flag --bogus\nUsage: crank-mem init ");
    expect(fs.readdirSync(fresh)).toEqual([]);
  });

  test("an unknown command prints the usage and exits 1; a bare call, help and --version exit 0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crank-cmd-"));
    const home = makeCrankHome();
    for (const [args, status] of [
      [["frobnicate"], 1],
      [["toString"], 1],
      [[], 0],
      [["help"], 0],
      [["--help"], 0],
    ] as const) {
      const run = runCli(dir, [...args], { CRANK_HOME: home });
      expect([
        args,
        run.status,
        run.stdout.includes("Usage: crank-mem <command> [flags]"),
        run.stdout.includes("Run `crank-mem <command> --help` for its flags."),
      ]).toEqual([args, status, true, true]);
    }
    for (const flag of ["--version", "-v"]) {
      const run = runCli(dir, [flag], { CRANK_HOME: home });
      expect(run.status).toBe(0);
      expect(run.stdout).toMatch(/^.+\n$/);
    }
  });
});

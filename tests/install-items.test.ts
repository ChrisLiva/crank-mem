import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  REPO_ROOT,
  makeCrankHome,
  makeProject,
  runCli,
  snapshot,
  withEnv,
  type CliRun,
} from "./helpers.ts";
import { cliVersion, REPO_ROOT as CLONE_ROOT } from "../src/cli/version.ts";
import { newBackupDir } from "../src/cli/backups.ts";
import { applyInstall, removeInstall, repairInstall, resolveCodex } from "../src/cli/install.ts";
import type { Report } from "../src/cli/install-support.ts";
import { defaultConfig, loadConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { CRANK_ALLOW_RULES, crankHooks } from "../src/cli/settings.ts";
import { V1_DDL } from "./fixtures/schema-v1.ts";

function cli(cwd: string, codexHome: string, crankHome: string, ...args: string[]): CliRun {
  return runCli(cwd, args, { CODEX_HOME: codexHome, CRANK_HOME: crankHome });
}

type GitMode = "commit" | "ignore" | "exclude";
type Choice = "skip" | "review" | "trust";

/** A temp project at its real path, as `process.cwd()` gives it to the spawned commands. */
type Project = { root: string; crankDir: string; codexHome: string; home: string };

function project(extra: Record<string, string> = {}): Project {
  const made = makeProject(extra);
  const root = fs.realpathSync(made.root);
  return {
    root,
    crankDir: path.join(root, ".crank"),
    codexHome: made.codexHome,
    home: makeCrankHome(),
  };
}

function inHomes<T>(p: Project, fn: () => T): T {
  return withEnv({ CRANK_HOME: p.home, CODEX_HOME: p.codexHome }, fn);
}

/** `init`'s steps after its choices, without the first scan; the `Report` it would print. */
function initIn(p: Project, git: GitMode = "exclude", codex: Choice = "review"): Report {
  return inHomes(p, () => {
    fs.mkdirSync(p.crankDir, { recursive: true });
    const dir = newBackupDir(p.crankDir);
    const config = {
      ...defaultConfig(),
      git,
      runtime: "bun" as const,
      vendored_version: cliVersion(),
      clone_root: CLONE_ROOT,
      codex,
    };
    saveConfig(p.crankDir, config);
    return applyInstall({ root: p.root, crankDir: p.crankDir, config, backupDir: () => dir });
  });
}

/** `upgrade`'s repair walk, with its backup dir created on first use. */
function upgradeIn(p: Project): Report {
  return inHomes(p, () => {
    const loaded = loadConfig(p.crankDir);
    let dir: string | null = null;
    return repairInstall({
      root: p.root,
      crankDir: p.crankDir,
      config: { ...loaded, codex: resolveCodex(p.root, loaded) },
      backupDir: () => (dir ??= newBackupDir(p.crankDir)),
    });
  });
}

/** `uninstall`'s surgical removal pass. */
function uninstallIn(p: Project): Report {
  return inHomes(p, () =>
    removeInstall({ root: p.root, crankDir: p.crankDir, config: loadConfig(p.crankDir) }),
  );
}

const CODEX_FLAGS: Record<Choice, string[]> = {
  skip: ["--codex", "skip"],
  review: ["--codex", "merge", "--codex-trust", "skip"],
  trust: ["--codex", "merge", "--codex-trust", "write"],
};

function codexLines(choice: Choice, codexHome: string): string[] {
  if (choice === "skip") return ["  Codex: skipped"];
  if (choice === "review")
    return [
      "  Codex: hooks wired into .codex/hooks.json",
      "  Codex trust: open codex once in this project and accept the hooks review",
      "  (or headless: codex --dangerously-bypass-hook-trust)",
    ];
  return [
    "  Codex: hooks wired into .codex/hooks.json",
    `  Codex trust: trusted_hash entries written to ${codexHome}/config.toml`,
  ];
}

function configPath(root: string): string {
  return path.join(root, ".crank/config.json");
}

function readConfig(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath(root), "utf-8")) as Record<string, unknown>;
}

function writeConfig(root: string, config: Record<string, unknown>): void {
  fs.writeFileSync(configPath(root), JSON.stringify(config, null, 2) + "\n");
}

const initCases: { git: GitMode; choice: Choice }[] = (
  ["commit", "ignore", "exclude"] as const
).flatMap((git) => (["skip", "review", "trust"] as const).map((choice) => ({ git, choice })));

function initItemLines(git: GitMode, choice: Choice, codexHome: string): string[] {
  const settings = git === "commit" ? ".claude/settings.json" : ".claude/settings.local.json";
  return [`  Claude Code: hooks wired into ${settings}`, ...codexLines(choice, codexHome)];
}

function expectInitRecorded(root: string, choice: Choice): void {
  const parsed = readConfig(root);
  expect(parsed.codex).toBe(choice);
  expect("codex_trust_written" in parsed).toBe(false);
  expect(
    fs
      .readFileSync(path.join(root, ".crank/cerebrum.md"))
      .equals(fs.readFileSync(path.join(REPO_ROOT, "src/templates/cerebrum.md"))),
  ).toBe(true);
}

describe("init records the Codex choice", () => {
  test("init records the Codex choice and prints today's lines: exclude / trust", () => {
    const { root, codexHome } = makeProject();
    const home = makeCrankHome();
    const run = cli(
      root,
      codexHome,
      home,
      "init",
      "--yes",
      "--git",
      "exclude",
      ...CODEX_FLAGS.trust,
    );
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      [
        `crank-mem ${cliVersion()} initialized (runtime: bun, git: exclude)`,
        "  indexed 2 files → .crank/anatomy.md",
        ...initItemLines("exclude", "trust", codexHome),
        "Next: start a Claude Code session here — project memory injects at session start.",
        "Optional: install the audit skill — npx skills add ChrisLiva/crank-mem",
      ].join("\n") + "\n",
    );
    expectInitRecorded(root, "trust");
  });

  for (const { git, choice } of initCases) {
    if (git === "exclude" && choice === "trust") continue;
    test(`init records the Codex choice and prints today's lines: ${git} / ${choice}`, () => {
      const p = project();
      expect(initIn(p, git, choice)).toEqual({
        lines: initItemLines(git, choice, p.codexHome),
        warnings: [],
        failed: false,
      });
      expectInitRecorded(p.root, choice);
    });
  }
});

test("init --yes defaults Codex to review, or skip when .codex/hooks.json exists", () => {
  const fresh = makeProject();
  expect(cli(fresh.root, fresh.codexHome, makeCrankHome(), "init", "--yes").status).toBe(0);
  expect(readConfig(fresh.root).codex).toBe("review");
  const wired = makeProject({ ".codex/hooks.json": "{}\n" });
  expect(cli(wired.root, wired.codexHome, makeCrankHome(), "init", "--yes").status).toBe(0);
  expect(readConfig(wired.root).codex).toBe("skip");
}, 20_000);

const legacyCases: { name: string; set: Record<string, unknown> }[] = [
  { name: "codex_trust_written false", set: { codex_trust_written: false } },
  { name: "codex bogus", set: { codex: "bogus" } },
  { name: "codex an object", set: { codex: {} } },
];

for (const c of legacyCases) {
  test(`digest on leaves a legacy config without a codex key: ${c.name}`, () => {
    const { root, codexHome } = makeProject();
    const home = makeCrankHome();
    expect(cli(root, codexHome, home, "init", "--yes", ...CODEX_FLAGS.review).status).toBe(0);
    const { codex: _codex, ...rest } = readConfig(root);
    writeConfig(root, { ...rest, ...c.set });
    expect(cli(root, codexHome, home, "digest", "on").status).toBe(0);
    const parsed = readConfig(root);
    expect("codex" in parsed).toBe(false);
    expect("codex_trust_written" in parsed).toBe(false);
  }, 20_000);
}

test("uninstall reads a legacy codex_trust_written config as trust", () => {
  const p = project();
  initIn(p, "exclude", "trust");
  const { codex: _codex, ...rest } = readConfig(p.root);
  writeConfig(p.root, { ...rest, codex_trust_written: true });
  const un = uninstallIn(p);
  expect(un.failed).toBe(false);
  expect(un.lines).toContain(`  removed trusted_hash entries from ${p.codexHome}/config.toml`);
  expect(fs.readFileSync(path.join(p.codexHome, "config.toml"), "utf-8")).toBe(
    'model = "gpt-5.6"\n',
  );
});

test("uninstall leaves trust entries when the config records review", () => {
  const p = project();
  initIn(p, "exclude", "trust");
  const trusted = fs.readFileSync(path.join(p.codexHome, "config.toml"), "utf-8");
  writeConfig(p.root, { ...readConfig(p.root), codex: "review" });
  const un = uninstallIn(p);
  expect(un.failed).toBe(false);
  expect(fs.readFileSync(path.join(p.codexHome, "config.toml"), "utf-8")).toBe(trusted);
  expect(un.lines.join("\n")).not.toContain("removed trusted_hash entries");
});

test("upgrade writes no trust entries when the config records review", () => {
  const p = project();
  initIn(p, "exclude", "trust");
  const toml = path.join(p.codexHome, "config.toml");
  fs.writeFileSync(toml, 'model = "gpt-5.6"\n');
  writeConfig(p.root, { ...readConfig(p.root), vendored_version: "0.0.1", codex: "review" });
  const up = upgradeIn(p);
  expect(up.failed).toBe(false);
  expect(up.lines.join("\n")).not.toContain("recomputed");
  expect(fs.readFileSync(toml, "utf-8")).toBe('model = "gpt-5.6"\n');
});

function registry(home: string): {
  version: number;
  projects: { root: string; addedAtMs: number }[];
} {
  return JSON.parse(fs.readFileSync(path.join(home, "projects.json"), "utf-8"));
}

function registeredRoots(home: string): string[] {
  return registry(home).projects.map((p) => p.root);
}

for (const git of ["commit", "ignore", "exclude"] as const) {
  test(`round trip returns the project to its pre-init state: ${git}`, () => {
    const { root, codexHome } = makeProject();
    const home = makeCrankHome();
    const exclude = path.join(root, ".git/info/exclude");
    const backups = path.join(root, ".crank/backups");
    const before = snapshot(root);
    const excludeBefore = fs.readFileSync(exclude);
    const init = cli(root, codexHome, home, "init", "--yes", "--git", git, ...CODEX_FLAGS.review);
    expect(init.status).toBe(0);
    const real = fs.realpathSync(root);
    expect(registeredRoots(home)).toContain(real);
    const backupsBefore = fs.readdirSync(backups);
    const up = cli(root, codexHome, home, "upgrade");
    expect(up.status).toBe(0);
    expect(up.stdout.split("\n").filter((l) => l.startsWith("  "))).toEqual([]);
    expect(fs.readdirSync(backups)).toEqual(backupsBefore);
    const registered = registry(home);
    expect(registered.version).toBe(1);
    expect(registered.projects.map((p) => p.root)).toEqual([real]);
    expect(typeof registered.projects[0]!.addedAtMs).toBe("number");
    const un = cli(root, codexHome, home, "uninstall", "--yes", "--delete-crank");
    expect(un.status).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, ".crank"))).toBe(false);
    expect(fs.readFileSync(exclude).equals(excludeBefore)).toBe(true);
    expect(registeredRoots(home)).not.toContain(real);
  }, 20_000);
}

for (const c of ["skip", "missing key"] as const) {
  test(`uninstall strips crank entries whatever codex records: ${c}`, () => {
    const p = project();
    const { root } = p;
    initIn(p, "exclude", "skip");
    const plant = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    plant(".codex/hooks.json", JSON.stringify({ hooks: crankHooks("bun", "codex") }));
    plant(".codex/config.toml", "\n# crank-mem\n[features]\nhooks = true\n");
    plant(
      ".claude/settings.json",
      JSON.stringify({
        hooks: crankHooks("bun", "claude"),
        permissions: { allow: [...CRANK_ALLOW_RULES] },
      }),
    );
    plant(".gitignore", "# crank-mem\n.crank/\n");
    if (c === "missing key") {
      const { codex: _codex, ...rest } = readConfig(root);
      writeConfig(root, rest);
    }
    expect(uninstallIn(p).failed).toBe(false);
    const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf-8");
    expect(JSON.parse(read(".codex/hooks.json"))).toEqual({});
    expect(read(".codex/config.toml")).toBe("");
    expect(JSON.parse(read(".claude/settings.json"))).toEqual({});
    expect(read(".gitignore")).toBe("");
    expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(false);
    expect(read(".git/info/exclude")).not.toContain("# crank-mem");
  });
}

test("a restore uninstall prints the trust line once", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  expect(cli(root, codexHome, home, "init", "--yes", ...CODEX_FLAGS.trust).status).toBe(0);
  const un = cli(root, codexHome, home, "uninstall", "--yes", "--restore", "--delete-crank");
  expect(un.status).toBe(0);
  const line = `  removed trusted_hash entries from ${codexHome}/config.toml`;
  expect(un.stdout.split("\n").filter((l) => l === line).length).toBe(1);
  expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8")).toBe('model = "gpt-5.6"\n');
}, 20_000);

const unparseableCases: { file: string; text: string; gone: string }[] = [
  {
    file: ".claude/settings.local.json",
    text: '{ "hooks": ".crank/hooks/ broken',
    gone: ".codex/hooks.json",
  },
  {
    file: ".claude/settings.json",
    text: '{"permissions": "Bash(crank-mem search *)"',
    gone: ".codex/hooks.json",
  },
  {
    file: ".codex/hooks.json",
    text: '{ ".crank/hooks/session-start.ts"',
    gone: ".claude/settings.local.json",
  },
];

function initExclude(root: string, codexHome: string, home: string): void {
  const init = cli(
    root,
    codexHome,
    home,
    "init",
    "--yes",
    "--git",
    "exclude",
    ...CODEX_FLAGS.review,
  );
  expect(init.status).toBe(0);
}

const unparseableWarning = (file: string): string =>
  `crank-mem: could not remove crank-mem's entries from ${file} (not valid JSON)`;

const [spawnedUnparseable, ...inProcessUnparseable] = unparseableCases;

test(`uninstall reports an unparseable file that holds crank entries: ${spawnedUnparseable!.file}`, () => {
  const c = spawnedUnparseable!;
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  initExclude(root, codexHome, home);
  fs.mkdirSync(path.dirname(path.join(root, c.file)), { recursive: true });
  fs.writeFileSync(path.join(root, c.file), c.text);
  const un = cli(root, codexHome, home, "uninstall", "--yes", "--delete-crank");
  expect(un.status).toBe(1);
  expect(un.stderr).toBe(unparseableWarning(c.file) + "\n");
  expect(fs.readFileSync(path.join(root, c.file), "utf-8")).toBe(c.text);
  expect(un.stdout.endsWith("crank-mem: uninstalled.\n")).toBe(true);
  expect(fs.readFileSync(path.join(root, ".git/info/exclude"), "utf-8")).not.toContain(
    "# crank-mem",
  );
  expect(fs.existsSync(path.join(root, c.gone))).toBe(false);
}, 20_000);

for (const c of inProcessUnparseable) {
  test(`uninstall reports an unparseable file that holds crank entries: ${c.file}`, () => {
    const p = project();
    const { root } = p;
    initIn(p);
    fs.mkdirSync(path.dirname(path.join(root, c.file)), { recursive: true });
    fs.writeFileSync(path.join(root, c.file), c.text);
    const un = uninstallIn(p);
    expect(un.failed).toBe(true);
    expect(un.warnings).toEqual([unparseableWarning(c.file)]);
    expect(fs.readFileSync(path.join(root, c.file), "utf-8")).toBe(c.text);
    expect(fs.readFileSync(path.join(root, ".git/info/exclude"), "utf-8")).not.toContain(
      "# crank-mem",
    );
    expect(fs.existsSync(path.join(root, c.gone))).toBe(false);
  });
}

test("uninstall leaves an unparseable file without crank strings alone", () => {
  const p = project();
  initIn(p);
  const file = path.join(p.root, ".claude/settings.json");
  fs.writeFileSync(file, "{ broken");
  const un = uninstallIn(p);
  expect(un.failed).toBe(false);
  expect(un.warnings).toEqual([]);
  expect(fs.readFileSync(file, "utf-8")).toBe("{ broken");
});

const GITIGNORE_EACCES = "crank-mem: could not remove crank-mem's entries from .gitignore (EACCES";

test("uninstall reports an unwritable .gitignore once and carries on", () => {
  const p = project();
  const { root } = p;
  initIn(p, "ignore", "review");
  const gitignore = path.join(root, ".gitignore");
  let un: Report;
  try {
    fs.chmodSync(gitignore, 0o000);
    un = uninstallIn(p);
  } finally {
    fs.chmodSync(gitignore, 0o644);
  }
  expect(un.failed).toBe(true);
  expect(un.warnings.length).toBe(1);
  expect(un.warnings[0]!.startsWith(GITIGNORE_EACCES)).toBe(true);
  expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(false);
  expect(fs.existsSync(path.join(root, ".codex/hooks.json"))).toBe(false);
});

test("a legacy-only uninstall reports an unreadable .gitignore and still sweeps crank/", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  fs.mkdirSync(path.join(root, "crank"));
  fs.writeFileSync(path.join(root, "crank/config.json"), "{}\n");
  const gitignore = path.join(root, ".gitignore");
  fs.writeFileSync(gitignore, "node_modules\n# crank-mem\ncrank/\n");
  let un: CliRun;
  try {
    fs.chmodSync(gitignore, 0o000);
    un = cli(root, codexHome, home, "uninstall", "--yes");
  } finally {
    fs.chmodSync(gitignore, 0o644);
  }
  expect(un.status).toBe(1);
  const lines = un.stderr.split("\n").filter((l) => l !== "");
  expect(lines.length).toBe(1);
  expect(lines[0]!.startsWith(GITIGNORE_EACCES)).toBe(true);
  expect(un.stdout.endsWith("crank-mem: removed legacy crank/ install.\n")).toBe(true);
  expect(fs.existsSync(path.join(root, "crank"))).toBe(false);
});

const ALREADY_AT = `crank-mem: already at ${cliVersion()} — nothing else to do.`;

function lastLine(text: string): string | undefined {
  return text
    .split("\n")
    .filter((l) => l !== "")
    .at(-1);
}

function stripIgnoreBlock(file: string): void {
  fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("# crank-mem\n.crank/\n", ""));
}

const repairCases: {
  name: string;
  damage(root: string, codexHome: string, home: string): void;
  files(root: string, codexHome: string, home: string): string[];
  line: string | null;
  extra?(root: string, home: string, lines: string[]): void;
}[] = [
  {
    name: "Claude wiring",
    damage: (root) => fs.rmSync(path.join(root, ".claude/settings.local.json")),
    files: (root) => [path.join(root, ".claude/settings.local.json")],
    line: "  re-wired Claude Code hooks in .claude/settings.local.json",
  },
  {
    name: ".crank/.gitignore",
    damage: (root) => fs.rmSync(path.join(root, ".crank/.gitignore")),
    files: (root) => [path.join(root, ".crank/.gitignore")],
    line: "  wrote the allowlist .crank/.gitignore",
  },
  {
    name: "cerebrum",
    damage: (root) => fs.rmSync(path.join(root, ".crank/cerebrum.md")),
    files: (root) => [path.join(root, ".crank/cerebrum.md")],
    line: "  seeded .crank/cerebrum.md from the template",
  },
  {
    name: "registry",
    damage: (_root, _codexHome, home) =>
      fs.writeFileSync(path.join(home, "projects.json"), '{"version":1,"projects":[]}'),
    files: () => [],
    line: null,
    extra: (root, home, lines) => {
      expect(registeredRoots(home).filter((r) => r === root).length).toBe(1);
      expect(lines).toEqual([]);
    },
  },
  {
    name: "Codex hooks",
    damage: (root) => fs.rmSync(path.join(root, ".codex/hooks.json")),
    files: (root) => [path.join(root, ".codex/hooks.json")],
    line: "  re-wired Codex hooks in .codex/hooks.json",
    extra: (_root, _home, lines) =>
      expect(lines.join("\n")).not.toContain("Codex trust: open codex once"),
  },
  {
    name: "Codex [features]",
    damage: (root) => fs.rmSync(path.join(root, ".codex/config.toml")),
    files: (root) => [path.join(root, ".codex/config.toml")],
    line: "  added the crank-mem [features] snippet to .codex/config.toml",
  },
  {
    name: "Codex trust",
    damage: (_root, codexHome) =>
      fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.6"\n'),
    files: (_root, codexHome) => [path.join(codexHome, "config.toml")],
    line: "  recomputed Codex trusted_hash entries",
  },
];

test("upgrade repairs git ignore block", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  const init = cli(
    root,
    codexHome,
    home,
    "init",
    "--yes",
    "--git",
    "exclude",
    ...CODEX_FLAGS.trust,
  );
  expect(init.status).toBe(0);
  const exclude = path.join(root, ".git/info/exclude");
  const recorded = fs.readFileSync(exclude);
  stripIgnoreBlock(exclude);
  const up = cli(root, codexHome, home, "upgrade");
  expect(up.status).toBe(0);
  expect(up.stdout).toContain("  added the crank-mem .crank/ ignore block to .git/info/exclude\n");
  expect(fs.readFileSync(exclude).equals(recorded)).toBe(true);
  expect(lastLine(up.stdout)).toBe(ALREADY_AT);
}, 20_000);

for (const c of repairCases) {
  test(`upgrade repairs ${c.name}`, () => {
    const p = project();
    const { root, codexHome, home } = p;
    initIn(p, "exclude", "trust");
    const files = c.files(root, codexHome, home);
    const recorded = files.map((f) => fs.readFileSync(f));
    c.damage(root, codexHome, home);
    const up = upgradeIn(p);
    expect(up.failed).toBe(false);
    if (c.line !== null) expect(up.lines).toContain(c.line);
    files.forEach((f, i) => expect(fs.readFileSync(f).equals(recorded[i]!)).toBe(true));
    c.extra?.(root, home, up.lines);
  });
}

const legacyStampCases: { choice: Choice; set: Record<string, unknown> }[] = [
  { choice: "trust", set: { codex_trust_written: true } },
  { choice: "review", set: {} },
  { choice: "skip", set: {} },
];

for (const { choice, set } of legacyStampCases) {
  test(`upgrade stamps a legacy config's Codex choice: ${choice}`, () => {
    const { root, codexHome } = makeProject();
    const home = makeCrankHome();
    expect(cli(root, codexHome, home, "init", "--yes", ...CODEX_FLAGS[choice]).status).toBe(0);
    const { codex: _codex, ...rest } = readConfig(root);
    writeConfig(root, { ...rest, ...set });
    if (choice === "trust")
      fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.6"\n');
    const up = cli(root, codexHome, home, "upgrade");
    expect(up.status).toBe(0);
    const parsed = readConfig(root);
    expect(parsed.codex).toBe(choice);
    expect("codex_trust_written" in parsed).toBe(false);
    if (choice === "trust") expect(up.stdout).toContain("  recomputed Codex trusted_hash entries");
  }, 20_000);
}

function initExcludeNoTrust(root: string, codexHome: string, home: string): void {
  const init = cli(
    root,
    codexHome,
    home,
    "init",
    "--yes",
    "--git",
    "exclude",
    ...CODEX_FLAGS.review,
  );
  expect(init.status).toBe(0);
}

test("a corrupt Claude settings file costs only the Claude item", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  initExcludeNoTrust(root, codexHome, home);
  const settings = path.join(root, ".claude/settings.local.json");
  fs.writeFileSync(settings, "{ broken");
  fs.rmSync(path.join(root, ".crank/.gitignore"));
  const codexHooks = path.join(root, ".codex/hooks.json");
  const codexHooksBefore = fs.readFileSync(codexHooks);
  fs.rmSync(codexHooks);
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(path.join(root, ".crank/memory.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(V1_DDL);
  db.exec("PRAGMA user_version = 1");
  db.close();
  const up = cli(root, codexHome, home, "upgrade");
  expect(up.status).toBe(1);
  expect(up.stderr).toContain("crank-mem: could not re-wire Claude Code hooks (");
  expect(fs.readFileSync(settings, "utf-8")).toBe("{ broken");
  expect(up.stdout).toContain("  wrote the allowlist .crank/.gitignore\n");
  expect(up.stdout).toContain("  migrated memory.db v1 → v2\n");
  expect(fs.readFileSync(codexHooks).equals(codexHooksBefore)).toBe(true);
  expect(up.stdout).toContain(
    "  Codex trust: open codex once in this project and accept the hooks review\n  (or headless: codex --dangerously-bypass-hook-trust)\n",
  );
}, 20_000);

test("a corrupt hooks.json costs only the Codex item", () => {
  const p = project();
  initIn(p);
  const codexHooks = path.join(p.root, ".codex/hooks.json");
  fs.writeFileSync(codexHooks, "{ broken");
  fs.rmSync(path.join(p.crankDir, ".gitignore"));
  const up = upgradeIn(p);
  expect(up.failed).toBe(true);
  expect(up.warnings.join("\n")).toContain("crank-mem: could not re-wire Codex hooks (");
  expect(fs.readFileSync(codexHooks, "utf-8")).toBe("{ broken");
  expect(up.lines).toContain("  wrote the allowlist .crank/.gitignore");
});

test("upgrade on a skip install creates nothing under .codex/", () => {
  const p = project();
  initIn(p, "exclude", "skip");
  expect(upgradeIn(p).failed).toBe(false);
  expect(fs.existsSync(path.join(p.root, ".codex"))).toBe(false);
});

test("upgrade leaves current trust entries alone and sweeps an orphan", () => {
  const p = project();
  initIn(p, "exclude", "trust");
  const toml = path.join(p.codexHome, "config.toml");
  const bytes = fs.readFileSync(toml);
  const mtimeMs = fs.statSync(toml).mtimeMs;
  const up = upgradeIn(p);
  expect(up.failed).toBe(false);
  expect(fs.readFileSync(toml).equals(bytes)).toBe(true);
  expect(fs.statSync(toml).mtimeMs).toBe(mtimeMs);
  expect(up.lines.join("\n")).not.toContain("recomputed");
  fs.appendFileSync(
    toml,
    `[hooks.state."${p.root}/.codex/hooks.json:SessionStart:0:0"]\ntrusted_hash = "sha256:00"\n`,
  );
  const again = upgradeIn(p);
  expect(again.failed).toBe(false);
  expect(again.lines).toContain("  recomputed Codex trusted_hash entries");
  expect(fs.readFileSync(toml, "utf-8")).not.toContain(':SessionStart:0:0"]');
});

test("upgrade after uninstall --keep-crank reinstalls every item", () => {
  const p = project();
  initIn(p);
  const files = [
    ".claude/settings.local.json",
    ".codex/hooks.json",
    ".codex/config.toml",
    ".git/info/exclude",
  ].map((rel) => path.join(p.root, rel));
  const recorded = files.map((f) => fs.readFileSync(f));
  expect(uninstallIn(p).failed).toBe(false);
  expect(upgradeIn(p).failed).toBe(false);
  files.forEach((f, i) => expect(fs.readFileSync(f).equals(recorded[i]!)).toBe(true));
  expect(registeredRoots(p.home)).toContain(p.root);
});

test("a failed cerebrum seed fails the upgrade after every step", () => {
  const p = project();
  initIn(p);
  fs.rmSync(path.join(p.crankDir, "cerebrum.md"));
  let up: Report;
  try {
    fs.chmodSync(p.crankDir, 0o555);
    up = upgradeIn(p);
  } finally {
    fs.chmodSync(p.crankDir, 0o755);
  }
  expect(up.failed).toBe(true);
  expect(up.warnings.join("\n")).toContain(
    "crank-mem: could not seed .crank/cerebrum.md from the template (",
  );
});

const failedWriteCases: { name: string; damage(root: string): () => void; line: string }[] = [
  {
    name: ".crank/.gitignore",
    damage: (root) => {
      const file = path.join(root, ".crank/.gitignore");
      fs.rmSync(file);
      fs.mkdirSync(file);
      return () => {};
    },
    line: "crank-mem: could not write .crank/.gitignore (",
  },
  {
    name: "ignore file",
    damage: (root) => {
      const file = path.join(root, ".git/info/exclude");
      stripIgnoreBlock(file);
      fs.chmodSync(file, 0o444);
      return () => fs.chmodSync(file, 0o644);
    },
    line: "crank-mem: could not write .git/info/exclude (",
  },
];

for (const c of failedWriteCases) {
  test(`a failed item write fails the upgrade: ${c.name}`, () => {
    const p = project();
    initIn(p);
    let up: Report;
    let restore = () => {};
    try {
      restore = c.damage(p.root);
      up = upgradeIn(p);
    } finally {
      restore();
    }
    expect(up.failed).toBe(true);
    expect(up.warnings.join("\n")).toContain(c.line);
  });
}

const REVENDORED = "  re-vendored .crank/hooks/, which differed from the clone";
const OLD_MTIME = new Date("2001-01-01");

/** The one entry of `.crank/backups` that `before` lacks. */
function newBackup(root: string, before: string[]): string {
  const added = fs
    .readdirSync(path.join(root, ".crank/backups"))
    .filter((e) => !before.includes(e));
  expect(added.length).toBe(1);
  return path.join(root, ".crank/backups", added[0]!);
}

function backupsListing(root: string): string[] {
  const dir = path.join(root, ".crank/backups");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

const sameBytes = (a: string, b: string): boolean => fs.readFileSync(a).equals(fs.readFileSync(b));

const treeCases: {
  name: string;
  damage(hooks: string): void;
  check(root: string, hooks: string, before: string[], lines: string[]): void;
}[] = [
  {
    name: "extra file",
    damage: (hooks) => fs.writeFileSync(path.join(hooks, "extra.ts"), "// extra\n"),
    check: (root, hooks, before, lines) => {
      expect(lines).toContain(REVENDORED);
      expect(fs.existsSync(path.join(hooks, "extra.ts"))).toBe(false);
      const backup = newBackup(root, before);
      expect(fs.readFileSync(path.join(backup, "hooks/extra.ts"), "utf-8")).toBe("// extra\n");
    },
  },
  {
    name: "changed bytes",
    damage: (hooks) => fs.writeFileSync(path.join(hooks, "stop.ts"), "// edited\n"),
    check: (root, hooks, before, lines) => {
      expect(lines).toContain(REVENDORED);
      expect(
        sameBytes(path.join(hooks, "stop.ts"), path.join(REPO_ROOT, "src/hooks/stop.ts")),
      ).toBe(true);
      const backup = newBackup(root, before);
      expect(fs.readFileSync(path.join(backup, "hooks/stop.ts"), "utf-8")).toBe("// edited\n");
    },
  },
  {
    name: "dot-file only",
    damage: (hooks) => fs.writeFileSync(path.join(hooks, ".DS_Store"), "x"),
    check: (_root, hooks, _before, lines) => {
      expect(lines.join("\n")).not.toContain("re-vendored");
      expect(fs.existsSync(path.join(hooks, ".DS_Store"))).toBe(true);
    },
  },
  {
    name: "match",
    damage: (hooks) => fs.utimesSync(path.join(hooks, "stop.ts"), OLD_MTIME, OLD_MTIME),
    check: (_root, hooks, _before, lines) => {
      expect(lines.join("\n")).not.toContain("re-vendored");
      expect(fs.statSync(path.join(hooks, "stop.ts")).mtimeMs).toBe(OLD_MTIME.getTime());
    },
  },
  {
    name: "missing dir",
    damage: (hooks) => fs.rmSync(hooks, { recursive: true }),
    check: (_root, hooks, _before, lines) => {
      expect(lines).toContain(REVENDORED);
      expect(
        sameBytes(path.join(hooks, "post-read.ts"), path.join(REPO_ROOT, "src/hooks/post-read.ts")),
      ).toBe(true);
    },
  },
];

for (const c of treeCases) {
  test(`same-version upgrade re-vendors exactly when the tree differs: ${c.name}`, () => {
    const p = project();
    initIn(p);
    const hooks = path.join(p.crankDir, "hooks");
    c.damage(hooks);
    const before = backupsListing(p.root);
    const up = upgradeIn(p);
    expect(up.failed).toBe(false);
    c.check(p.root, hooks, before, up.lines);
  });
}

test("a failed re-vendor prints no summary line and exits 1", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  initExcludeNoTrust(root, codexHome, home);
  writeConfig(root, { ...readConfig(root), vendored_version: "0.0.1" });
  const backups = path.join(root, ".crank/backups");
  let up: CliRun;
  try {
    fs.chmodSync(backups, 0o555);
    up = cli(root, codexHome, home, "upgrade");
  } finally {
    fs.chmodSync(backups, 0o755);
  }
  expect(up.status).toBe(1);
  expect(up.stderr).toContain("crank-mem: could not re-vendor .crank/hooks/ (");
  expect(up.stdout).not.toContain("upgraded vendored hooks");
  expect(up.stdout).not.toContain("already at");
  expect(readConfig(root).vendored_version).toBe("0.0.1");
}, 20_000);

test("init leaves an existing cerebrum alone", () => {
  const p = project();
  const cerebrumPath = path.join(p.crankDir, "cerebrum.md");
  fs.mkdirSync(p.crankDir, { recursive: true });
  fs.writeFileSync(cerebrumPath, "# Mine\n");
  expect(initIn(p).failed).toBe(false);
  expect(fs.readFileSync(cerebrumPath, "utf-8")).toBe("# Mine\n");
});

test("a failing first scan stops init before wiring anything", () => {
  const { root, codexHome } = makeProject();
  const exclude = path.join(root, ".git/info/exclude");
  const before = snapshot(root);
  const excludeBefore = fs.readFileSync(exclude);
  fs.mkdirSync(path.join(root, ".crank/anatomy-index.json"), { recursive: true });
  const run = cli(
    root,
    codexHome,
    makeCrankHome(),
    "init",
    "--yes",
    "--git",
    "exclude",
    ...CODEX_FLAGS.review,
  );
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("crank-mem: EISDIR");
  expect(run.stderr).toContain("init failed before wiring anything — delete .crank/ and retry.\n");
  expect(fs.existsSync(configPath(root))).toBe(false);
  expect(snapshot(root)).toEqual(before);
  expect(fs.readFileSync(exclude).equals(excludeBefore)).toBe(true);
});

test("a failing item stops init partway", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  const exclude = path.join(root, ".git/info/exclude");
  const excludeBefore = fs.readFileSync(exclude);
  fs.mkdirSync(path.join(root, ".claude/settings.local.json"), { recursive: true });
  const run = cli(
    root,
    codexHome,
    home,
    "init",
    "--yes",
    "--git",
    "exclude",
    ...CODEX_FLAGS.review,
  );
  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("crank-mem: EISDIR");
  expect(run.stderr).toContain(
    "init failed partway — run `crank-mem uninstall --restore` to roll back.",
  );
  expect(fs.existsSync(path.join(root, ".codex/hooks.json"))).toBe(false);
  expect(fs.readFileSync(exclude).equals(excludeBefore)).toBe(true);
  const registry = path.join(home, "projects.json");
  if (fs.existsSync(registry)) expect(fs.readFileSync(registry, "utf-8")).not.toContain(root);
});

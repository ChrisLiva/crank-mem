import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, makeCrankHome, makeProject, runCli, snapshot, type CliRun } from "./helpers.ts";
import { cliVersion } from "../src/cli/version.ts";
import { CRANK_ALLOW_RULES, crankHooks } from "../src/cli/settings.ts";
import { V1_DDL } from "./fixtures/schema-v1.ts";

function cli(cwd: string, codexHome: string, crankHome: string, ...args: string[]): CliRun {
  return runCli(cwd, args, { CODEX_HOME: codexHome, CRANK_HOME: crankHome });
}

type GitMode = "commit" | "ignore" | "exclude";
type Choice = "skip" | "review" | "trust";

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

describe("init records the Codex choice", () => {
  for (const { git, choice } of initCases) {
    test(`init records the Codex choice and prints today's lines: ${git} / ${choice}`, () => {
      const { root, codexHome } = makeProject();
      const home = makeCrankHome();
      const run = cli(root, codexHome, home, "init", "--yes", "--git", git, ...CODEX_FLAGS[choice]);
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      const settings = git === "commit" ? ".claude/settings.json" : ".claude/settings.local.json";
      expect(run.stdout).toBe(
        [
          `crank-mem ${cliVersion()} initialized (runtime: bun, git: ${git})`,
          "  indexed 2 files → .crank/anatomy.md",
          `  Claude Code: hooks wired into ${settings}`,
          ...codexLines(choice, codexHome),
          "Next: start a Claude Code session here — project memory injects at session start.",
          "Optional: install the audit skill — npx skills add ChrisLiva/crank-mem",
        ].join("\n") + "\n",
      );
      const parsed = readConfig(root);
      expect(parsed.codex).toBe(choice);
      expect("codex_trust_written" in parsed).toBe(false);
      expect(
        fs
          .readFileSync(path.join(root, ".crank/cerebrum.md"))
          .equals(fs.readFileSync(path.join(REPO_ROOT, "src/templates/cerebrum.md"))),
      ).toBe(true);
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
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  expect(cli(root, codexHome, home, "init", "--yes", ...CODEX_FLAGS.trust).status).toBe(0);
  const { codex: _codex, ...rest } = readConfig(root);
  writeConfig(root, { ...rest, codex_trust_written: true });
  const un = cli(root, codexHome, home, "uninstall", "--yes", "--delete-crank");
  expect(un.status).toBe(0);
  expect(un.stdout).toContain(`  removed trusted_hash entries from ${codexHome}/config.toml`);
  expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8")).toBe('model = "gpt-5.6"\n');
}, 20_000);

test("uninstall leaves trust entries when the config records review", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  expect(cli(root, codexHome, home, "init", "--yes", ...CODEX_FLAGS.trust).status).toBe(0);
  const trusted = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  writeConfig(root, { ...readConfig(root), codex: "review" });
  const un = cli(root, codexHome, home, "uninstall", "--yes", "--delete-crank");
  expect(un.status).toBe(0);
  expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8")).toBe(trusted);
  expect(un.stdout).not.toContain("removed trusted_hash entries");
}, 20_000);

test("upgrade writes no trust entries when the config records review", () => {
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
  const toml = path.join(codexHome, "config.toml");
  fs.writeFileSync(toml, 'model = "gpt-5.6"\n');
  writeConfig(root, { ...readConfig(root), vendored_version: "0.0.1", codex: "review" });
  const up = cli(root, codexHome, home, "upgrade");
  expect(up.status).toBe(0);
  expect(up.stdout).not.toContain("recomputed");
  expect(fs.readFileSync(toml, "utf-8")).toBe('model = "gpt-5.6"\n');
}, 20_000);

function registeredRoots(home: string): string[] {
  return JSON.parse(fs.readFileSync(path.join(home, "projects.json"), "utf-8")).projects.map(
    (p: { root: string }) => p.root,
  );
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
    const { root, codexHome } = makeProject();
    const home = makeCrankHome();
    expect(
      cli(root, codexHome, home, "init", "--yes", "--git", "exclude", "--codex", "skip").status,
    ).toBe(0);
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
    const un = cli(root, codexHome, home, "uninstall", "--yes", "--delete-crank");
    expect(un.status).toBe(0);
    const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf-8");
    expect(JSON.parse(read(".codex/hooks.json"))).toEqual({});
    expect(read(".codex/config.toml")).toBe("");
    expect(JSON.parse(read(".claude/settings.json"))).toEqual({});
    expect(read(".gitignore")).toBe("");
    expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(false);
    expect(read(".git/info/exclude")).not.toContain("# crank-mem");
  }, 20_000);
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

for (const c of unparseableCases) {
  test(`uninstall reports an unparseable file that holds crank entries: ${c.file}`, () => {
    const { root, codexHome } = makeProject();
    const home = makeCrankHome();
    initExclude(root, codexHome, home);
    fs.mkdirSync(path.dirname(path.join(root, c.file)), { recursive: true });
    fs.writeFileSync(path.join(root, c.file), c.text);
    const un = cli(root, codexHome, home, "uninstall", "--yes", "--delete-crank");
    expect(un.status).toBe(1);
    expect(un.stderr).toBe(
      `crank-mem: could not remove crank-mem's entries from ${c.file} (not valid JSON)\n`,
    );
    expect(fs.readFileSync(path.join(root, c.file), "utf-8")).toBe(c.text);
    expect(un.stdout.endsWith("crank-mem: uninstalled.\n")).toBe(true);
    expect(fs.readFileSync(path.join(root, ".git/info/exclude"), "utf-8")).not.toContain(
      "# crank-mem",
    );
    expect(fs.existsSync(path.join(root, c.gone))).toBe(false);
  }, 20_000);
}

test("uninstall leaves an unparseable file without crank strings alone", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  initExclude(root, codexHome, home);
  const file = path.join(root, ".claude/settings.json");
  fs.writeFileSync(file, "{ broken");
  const un = cli(root, codexHome, home, "uninstall", "--yes", "--delete-crank");
  expect(un.status).toBe(0);
  expect(un.stderr).toBe("");
  expect(fs.readFileSync(file, "utf-8")).toBe("{ broken");
}, 20_000);

const GITIGNORE_EACCES = "crank-mem: could not remove crank-mem's entries from .gitignore (EACCES";

test("uninstall reports an unwritable .gitignore once and carries on", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  const init = cli(
    root,
    codexHome,
    home,
    "init",
    "--yes",
    "--git",
    "ignore",
    ...CODEX_FLAGS.review,
  );
  expect(init.status).toBe(0);
  const gitignore = path.join(root, ".gitignore");
  let un: CliRun;
  try {
    fs.chmodSync(gitignore, 0o000);
    un = cli(root, codexHome, home, "uninstall", "--yes", "--delete-crank");
  } finally {
    fs.chmodSync(gitignore, 0o644);
  }
  expect(un.status).toBe(1);
  const lines = un.stderr.split("\n").filter((l) => l !== "");
  expect(lines.length).toBe(1);
  expect(lines[0]!.startsWith(GITIGNORE_EACCES)).toBe(true);
  expect(un.stdout.endsWith("crank-mem: uninstalled.\n")).toBe(true);
  expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(false);
  expect(fs.existsSync(path.join(root, ".codex/hooks.json"))).toBe(false);
}, 20_000);

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
  extra?(root: string, codexHome: string, home: string, run: CliRun): void;
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
    name: "git ignore block",
    damage: (root) => stripIgnoreBlock(path.join(root, ".git/info/exclude")),
    files: (root) => [path.join(root, ".git/info/exclude")],
    line: "  added the crank-mem .crank/ ignore block to .git/info/exclude",
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
    extra: (root, _codexHome, home, run) => {
      const real = fs.realpathSync(root);
      expect(registeredRoots(home).filter((r) => r === real).length).toBe(1);
      expect(run.stdout.split("\n").filter((l) => l.startsWith("  "))).toEqual([]);
    },
  },
  {
    name: "vendored hooks",
    damage: (root) => fs.rmSync(path.join(root, ".crank/hooks/post-read.ts")),
    files: (root) => [path.join(root, ".crank/hooks/post-read.ts")],
    line: "  re-vendored .crank/hooks/, which differed from the clone",
  },
  {
    name: "Codex hooks",
    damage: (root) => fs.rmSync(path.join(root, ".codex/hooks.json")),
    files: (root) => [path.join(root, ".codex/hooks.json")],
    line: "  re-wired Codex hooks in .codex/hooks.json",
    extra: (_root, _codexHome, _home, run) =>
      expect(run.stdout).not.toContain("Codex trust: open codex once"),
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

for (const c of repairCases) {
  test(`upgrade repairs ${c.name}`, () => {
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
    const files = c.files(root, codexHome, home);
    const recorded = files.map((f) => fs.readFileSync(f));
    c.damage(root, codexHome, home);
    const up = cli(root, codexHome, home, "upgrade");
    expect(up.status).toBe(0);
    if (c.line !== null) expect(up.stdout).toContain(c.line + "\n");
    files.forEach((f, i) => expect(fs.readFileSync(f).equals(recorded[i]!)).toBe(true));
    expect(lastLine(up.stdout)).toBe(ALREADY_AT);
    c.extra?.(root, codexHome, home, up);
  }, 20_000);
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
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  initExcludeNoTrust(root, codexHome, home);
  const codexHooks = path.join(root, ".codex/hooks.json");
  fs.writeFileSync(codexHooks, "{ broken");
  fs.rmSync(path.join(root, ".crank/.gitignore"));
  const up = cli(root, codexHome, home, "upgrade");
  expect(up.status).toBe(1);
  expect(up.stderr).toContain("crank-mem: could not re-wire Codex hooks (");
  expect(fs.readFileSync(codexHooks, "utf-8")).toBe("{ broken");
  expect(up.stdout).toContain("  wrote the allowlist .crank/.gitignore\n");
}, 20_000);

test("upgrade on a skip install creates nothing under .codex/", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  const init = cli(root, codexHome, home, "init", "--yes", "--git", "exclude", ...CODEX_FLAGS.skip);
  expect(init.status).toBe(0);
  const up = cli(root, codexHome, home, "upgrade");
  expect(up.status).toBe(0);
  expect(fs.existsSync(path.join(root, ".codex"))).toBe(false);
}, 20_000);

test("upgrade leaves current trust entries alone and sweeps an orphan", () => {
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
  const toml = path.join(codexHome, "config.toml");
  const bytes = fs.readFileSync(toml);
  const mtimeMs = fs.statSync(toml).mtimeMs;
  const up = cli(root, codexHome, home, "upgrade");
  expect(up.status).toBe(0);
  expect(fs.readFileSync(toml).equals(bytes)).toBe(true);
  expect(fs.statSync(toml).mtimeMs).toBe(mtimeMs);
  expect(up.stdout).not.toContain("recomputed");
  fs.appendFileSync(
    toml,
    `[hooks.state."${fs.realpathSync(root)}/.codex/hooks.json:SessionStart:0:0"]\ntrusted_hash = "sha256:00"\n`,
  );
  const again = cli(root, codexHome, home, "upgrade");
  expect(again.status).toBe(0);
  expect(again.stdout).toContain("  recomputed Codex trusted_hash entries");
  expect(fs.readFileSync(toml, "utf-8")).not.toContain(':SessionStart:0:0"]');
}, 20_000);

test("upgrade after uninstall --keep-crank reinstalls every item", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  initExcludeNoTrust(root, codexHome, home);
  const files = [
    ".claude/settings.local.json",
    ".codex/hooks.json",
    ".codex/config.toml",
    ".git/info/exclude",
  ].map((rel) => path.join(root, rel));
  const recorded = files.map((f) => fs.readFileSync(f));
  expect(cli(root, codexHome, home, "uninstall", "--yes", "--keep-crank").status).toBe(0);
  const up = cli(root, codexHome, home, "upgrade");
  expect(up.status).toBe(0);
  files.forEach((f, i) => expect(fs.readFileSync(f).equals(recorded[i]!)).toBe(true));
  expect(registeredRoots(home)).toContain(fs.realpathSync(root));
}, 20_000);

test("a failed cerebrum seed fails the upgrade after every step", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  initExcludeNoTrust(root, codexHome, home);
  const crankDir = path.join(root, ".crank");
  fs.rmSync(path.join(crankDir, "cerebrum.md"));
  let up: CliRun;
  try {
    fs.chmodSync(crankDir, 0o555);
    up = cli(root, codexHome, home, "upgrade");
  } finally {
    fs.chmodSync(crankDir, 0o755);
  }
  expect(up.status).toBe(1);
  expect(up.stderr).toContain("crank-mem: could not seed .crank/cerebrum.md from the template (");
  expect(lastLine(up.stdout)).toBe(ALREADY_AT);
}, 20_000);

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
    const { root, codexHome } = makeProject();
    const home = makeCrankHome();
    initExcludeNoTrust(root, codexHome, home);
    let up: CliRun;
    let restore = () => {};
    try {
      restore = c.damage(root);
      up = cli(root, codexHome, home, "upgrade");
    } finally {
      restore();
    }
    expect(up.status).toBe(1);
    expect(up.stderr).toContain(c.line);
    expect(lastLine(up.stdout)).toBe(ALREADY_AT);
  }, 20_000);
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
  check(root: string, hooks: string, before: string[], run: CliRun): void;
}[] = [
  {
    name: "extra file",
    damage: (hooks) => fs.writeFileSync(path.join(hooks, "extra.ts"), "// extra\n"),
    check: (root, hooks, before, run) => {
      expect(run.stdout).toContain(REVENDORED + "\n");
      expect(fs.existsSync(path.join(hooks, "extra.ts"))).toBe(false);
      const backup = newBackup(root, before);
      expect(fs.readFileSync(path.join(backup, "hooks/extra.ts"), "utf-8")).toBe("// extra\n");
    },
  },
  {
    name: "changed bytes",
    damage: (hooks) => fs.writeFileSync(path.join(hooks, "stop.ts"), "// edited\n"),
    check: (root, hooks, before, run) => {
      expect(run.stdout).toContain(REVENDORED + "\n");
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
    check: (_root, hooks, _before, run) => {
      expect(run.stdout).not.toContain("re-vendored");
      expect(fs.existsSync(path.join(hooks, ".DS_Store"))).toBe(true);
    },
  },
  {
    name: "match",
    damage: (hooks) => fs.utimesSync(path.join(hooks, "stop.ts"), OLD_MTIME, OLD_MTIME),
    check: (_root, hooks, _before, run) => {
      expect(run.stdout).not.toContain("re-vendored");
      expect(fs.statSync(path.join(hooks, "stop.ts")).mtimeMs).toBe(OLD_MTIME.getTime());
    },
  },
  {
    name: "missing dir",
    damage: (hooks) => fs.rmSync(hooks, { recursive: true }),
    check: (_root, hooks, _before, run) => {
      expect(run.stdout).toContain(REVENDORED + "\n");
      expect(
        sameBytes(path.join(hooks, "post-read.ts"), path.join(REPO_ROOT, "src/hooks/post-read.ts")),
      ).toBe(true);
    },
  },
];

for (const c of treeCases) {
  test(`same-version upgrade re-vendors exactly when the tree differs: ${c.name}`, () => {
    const { root, codexHome } = makeProject();
    const home = makeCrankHome();
    initExcludeNoTrust(root, codexHome, home);
    const hooks = path.join(root, ".crank/hooks");
    c.damage(hooks);
    const before = backupsListing(root);
    const up = cli(root, codexHome, home, "upgrade");
    expect(up.status).toBe(0);
    c.check(root, hooks, before, up);
  }, 20_000);
}

test("a version-changing upgrade re-vendors and ends on the upgraded line", () => {
  const { root, codexHome } = makeProject();
  const home = makeCrankHome();
  initExcludeNoTrust(root, codexHome, home);
  writeConfig(root, { ...readConfig(root), vendored_version: "0.0.1" });
  const stop = path.join(root, ".crank/hooks/stop.ts");
  fs.utimesSync(stop, OLD_MTIME, OLD_MTIME);
  const before = backupsListing(root);
  const up = cli(root, codexHome, home, "upgrade");
  expect(up.status).toBe(0);
  expect(lastLine(up.stdout)).toBe(`crank-mem: upgraded vendored hooks 0.0.1 → ${cliVersion()}`);
  expect(up.stdout).not.toContain("re-vendored");
  expect(readConfig(root).vendored_version).toBe(cliVersion());
  expect(fs.statSync(stop).mtimeMs).not.toBe(OLD_MTIME.getTime());
  expect(fs.existsSync(path.join(newBackup(root, before), "hooks/stop.ts"))).toBe(true);
}, 20_000);

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
  const { root, codexHome } = makeProject();
  const cerebrumPath = path.join(root, ".crank/cerebrum.md");
  fs.mkdirSync(path.dirname(cerebrumPath), { recursive: true });
  fs.writeFileSync(cerebrumPath, "# Mine\n");
  const run = cli(root, codexHome, makeCrankHome(), "init", "--yes", ...CODEX_FLAGS.review);
  expect(run.status).toBe(0);
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

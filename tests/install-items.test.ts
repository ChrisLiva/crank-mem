import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, makeCrankHome, makeProject, runCli, snapshot, type CliRun } from "./helpers.ts";
import { cliVersion } from "../src/cli/version.ts";
import { CRANK_ALLOW_RULES, crankHooks } from "../src/cli/settings.ts";

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

for (const choice of ["trust", "review"] as const) {
  test(`upgrade recomputes trust on a version change only when the config records trust: ${choice}`, () => {
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
    writeConfig(root, {
      ...readConfig(root),
      vendored_version: "0.0.1",
      ...(choice === "review" ? { codex: "review" } : {}),
    });
    const up = cli(root, codexHome, home, "upgrade");
    expect(up.status).toBe(0);
    if (choice === "trust") {
      expect(up.stdout).toContain("  recomputed Codex trusted_hash entries\n");
      expect(fs.readFileSync(toml, "utf-8")).toContain('trusted_hash = "sha256:');
    } else {
      expect(up.stdout).not.toContain("recomputed");
      expect(fs.readFileSync(toml, "utf-8")).toBe('model = "gpt-5.6"\n');
    }
  }, 20_000);
}

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

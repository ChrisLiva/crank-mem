import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "./args.ts";
import { COMMANDS } from "./commands.ts";
import { choose } from "./prompt.ts";
import { cliVersion, toolRoot } from "./version.ts";
import { printUpdateNotice } from "./updates.ts";
import { newBackupDir } from "./backups.ts";
import { applyInstall, printReport } from "./install.ts";
import { installPaths } from "./install-support.ts";
import {
  defaultConfig,
  saveConfig,
  CRANK_DIR,
  errorMessage,
  type CodexChoice,
  type CrankConfig,
} from "../hooks/lib/config.ts";
import { fullScan } from "../hooks/lib/scanner.ts";
import { commitIndex } from "../hooks/lib/store.ts";
import { CLI_LOCK_BUDGET_MS } from "../hooks/lib/lock.ts";

function detectRuntime(): CrankConfig["runtime"] | null {
  if (spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0) return "bun";
  const res = spawnSync("node", ["--version"], { encoding: "utf-8" });
  if (res.status === 0) {
    const m = res.stdout.trim().match(/^v(\d+)\.(\d+)/);
    if (m && (Number(m[1]) > 23 || (Number(m[1]) === 23 && Number(m[2]) >= 6))) return "node";
  }
  return null;
}

// Strict choice flags: reject bad values before prompting or touching disk.
const CHOICE_FLAGS = [
  ["git", ["commit", "ignore", "exclude"]],
  ["codex", ["merge", "skip"]],
  ["codex-trust", ["write", "skip"]],
] as const;

type Flags = Record<string, string | boolean>;

function invalidChoice(flags: Flags): string | null {
  for (const [name, choices] of CHOICE_FLAGS) {
    const value = flags[name];
    if (typeof value === "string" && !(choices as readonly string[]).includes(value)) {
      return `crank-mem: invalid --${name} ${value} (expected: ${choices.join(" | ")})`;
    }
  }
  return null;
}

/** A validated string flag wins, then `--yes` takes the preset, else the prompt asks. */
async function flagOr<T extends string>(
  value: string | boolean | undefined,
  yes: boolean,
  preset: T,
  ask: () => Promise<T>,
): Promise<T> {
  if (typeof value === "string") return value as T;
  return yes ? preset : ask();
}

async function askChoices(
  flags: Flags,
  yes: boolean,
  root: string,
): Promise<{ gitMode: CrankConfig["git"]; codexMode: string; codexTrust: string }> {
  const gitMode = await flagOr(flags.git, yes, "exclude", () =>
    choose("Track .crank/ in git?", ["commit", "ignore", "exclude"] as const, "exclude"),
  );
  // Pre-existing .codex wiring is a conflict — default to leaving it alone.
  const codexMode =
    typeof flags.codex !== "string" && !fs.existsSync(installPaths(root).codexHooks)
      ? "merge"
      : await flagOr(flags.codex, yes, "skip", () =>
          choose(
            ".codex/hooks.json exists — merge crank hooks into it?",
            ["merge", "skip"],
            "skip",
          ),
        );
  const codexTrust = await flagOr(flags["codex-trust"], yes, "skip", () =>
    choose("Write Codex trusted_hash entries to ~/.codex/config.toml?", ["write", "skip"], "skip"),
  );
  return { gitMode, codexMode, codexTrust };
}

function codexChoiceFor(codexMode: string, codexTrust: string): CodexChoice {
  if (codexMode !== "merge") return "skip";
  return codexTrust === "write" ? "trust" : "review";
}

/** Backup dir, first scan, config, then every item; null after printing the failure lines. */
function installAll(
  root: string,
  crankDir: string,
  config: CrankConfig & { codex: CodexChoice },
): { scanned: ReturnType<typeof commitIndex>; installed: ReturnType<typeof applyInstall> } | null {
  fs.mkdirSync(crankDir, { recursive: true });
  const backupDir = newBackupDir(crankDir);
  // Each writer backs up its file just before writing it, so a partial failure
  // is recoverable through `uninstall --restore`; init prints that hint instead of rolling back.
  try {
    const scanned = commitIndex(crankDir, CLI_LOCK_BUDGET_MS, () => fullScan(root, config));
    saveConfig(crankDir, config);
    const installed = applyInstall({ root, crankDir, config, backupDir: () => backupDir });
    return { scanned, installed };
  } catch (err) {
    console.error(`crank-mem: ${errorMessage(err)}`);
    // uninstall needs .crank/config.json; before it exists nothing outside
    // .crank/ has been touched yet, so the honest hint is just to delete it.
    if (fs.existsSync(path.join(crankDir, "config.json"))) {
      console.error("init failed partway — run `crank-mem uninstall --restore` to roll back.");
    } else {
      console.error("init failed before wiring anything — delete .crank/ and retry.");
    }
    return null;
  }
}

export async function run(args: string[]): Promise<number> {
  printUpdateNotice();
  const { flags } = parseArgs(args, COMMANDS.init.value);
  const yes = flags.yes === true;
  const root = process.cwd();
  const crankDir = path.join(root, CRANK_DIR);

  if (fs.existsSync(path.join(crankDir, "config.json"))) {
    console.error(
      "crank-mem: already initialized here — use `crank-mem upgrade` or `crank-mem uninstall`.",
    );
    return 1;
  }

  const runtime = detectRuntime();
  if (!runtime) {
    console.error("crank-mem: no suitable runtime — install bun or node >= 23.6. Aborting.");
    return 1;
  }

  const invalid = invalidChoice(flags);
  if (invalid) {
    console.error(invalid);
    return 1;
  }

  const { gitMode, codexMode, codexTrust } = await askChoices(flags, yes, root);
  const adrPath = typeof flags.adr === "string" ? flags.adr : "docs/adr";

  const config: CrankConfig & { codex: CodexChoice } = {
    ...defaultConfig(),
    adr_path: adrPath,
    git: gitMode,
    runtime,
    vendored_version: cliVersion(),
    clone_root: toolRoot(),
    codex: codexChoiceFor(codexMode, codexTrust),
  };

  const result = installAll(root, crankDir, config);
  if (!result) return 1;
  const { scanned, installed } = result;

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`crank-mem ${cliVersion()} initialized (runtime: ${runtime}, git: ${gitMode})`);
  console.log(`  indexed ${scanned?.meta.fileCount ?? "?"} files → .crank/anatomy.md`);
  printReport(installed);
  console.log(`Next: start a Claude Code session here — project memory injects at session start.`);
  console.log(`Optional: install the audit skill — npx skills add ChrisLiva/crank-mem`);
  return 0;
}

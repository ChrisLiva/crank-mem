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

  // ── Choices ──────────────────────────────────────────────────────────────
  // Strict choice flags: reject bad values before prompting or touching disk.
  const CHOICE_FLAGS = [
    ["git", ["commit", "ignore", "exclude"]],
    ["codex", ["merge", "skip"]],
    ["codex-trust", ["write", "skip"]],
  ] as const;
  for (const [name, choices] of CHOICE_FLAGS) {
    const value = flags[name];
    if (typeof value === "string" && !(choices as readonly string[]).includes(value)) {
      console.error(`crank-mem: invalid --${name} ${value} (expected: ${choices.join(" | ")})`);
      return 1;
    }
  }

  const gitMode: CrankConfig["git"] =
    typeof flags.git === "string"
      ? (flags.git as CrankConfig["git"])
      : yes
        ? "exclude"
        : await choose("Track .crank/ in git?", ["commit", "ignore", "exclude"], "exclude");

  const adrPath = typeof flags.adr === "string" ? flags.adr : "docs/adr";

  const codexHooksJson = installPaths(root).codexHooks;
  let codexMode: string;
  if (typeof flags.codex === "string") {
    codexMode = flags.codex;
  } else if (fs.existsSync(codexHooksJson)) {
    // Pre-existing .codex wiring is a conflict — default to leaving it alone.
    codexMode = yes
      ? "skip"
      : await choose(
          ".codex/hooks.json exists — merge crank hooks into it?",
          ["merge", "skip"],
          "skip",
        );
  } else {
    codexMode = "merge";
  }

  const codexTrust =
    typeof flags["codex-trust"] === "string"
      ? flags["codex-trust"]
      : yes
        ? "skip"
        : await choose(
            "Write Codex trusted_hash entries to ~/.codex/config.toml?",
            ["write", "skip"],
            "skip",
          );

  // ── Backup dir, config, first scan, then every item ──────────────────────
  fs.mkdirSync(crankDir, { recursive: true });
  const backupDir = newBackupDir(crankDir);
  const config: CrankConfig & { codex: CodexChoice } = {
    ...defaultConfig(),
    adr_path: adrPath,
    git: gitMode,
    runtime,
    vendored_version: cliVersion(),
    clone_root: toolRoot(),
    codex: codexMode !== "merge" ? "skip" : codexTrust === "write" ? "trust" : "review",
  };

  // Each writer backs up its file just before writing it, so a partial failure
  // is recoverable through `uninstall --restore`; init prints that hint instead of rolling back.
  let scanned: ReturnType<typeof commitIndex>;
  let installed: ReturnType<typeof applyInstall>;
  try {
    scanned = commitIndex(crankDir, CLI_LOCK_BUDGET_MS, () => fullScan(root, config));
    saveConfig(crankDir, config);
    installed = applyInstall({ root, crankDir, config, backupDir: () => backupDir });
  } catch (err) {
    console.error(`crank-mem: ${errorMessage(err)}`);
    // uninstall needs .crank/config.json; before it exists nothing outside
    // .crank/ has been touched yet, so the honest hint is just to delete it.
    if (fs.existsSync(path.join(crankDir, "config.json"))) {
      console.error("init failed partway — run `crank-mem uninstall --restore` to roll back.");
    } else {
      console.error("init failed before wiring anything — delete .crank/ and retry.");
    }
    return 1;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`crank-mem ${cliVersion()} initialized (runtime: ${runtime}, git: ${gitMode})`);
  console.log(`  indexed ${scanned?.meta.fileCount ?? "?"} files → .crank/anatomy.md`);
  printReport(installed);
  console.log(`Next: start a Claude Code session here — project memory injects at session start.`);
  console.log(`Optional: install the audit skill — npx skills add ChrisLiva/crank-mem`);
  return 0;
}

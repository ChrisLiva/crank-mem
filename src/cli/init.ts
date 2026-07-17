import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "./args.ts";
import { choose } from "./prompt.ts";
import { cliVersion } from "./version.ts";
import { vendorHooks, templatePath } from "./vendor.ts";
import { newBackupDir, backupFile } from "./backups.ts";
import {
  crankHooks, mergeHooksIntoFile, addIgnoreLines, ensureCodexFeatures,
} from "./settings.ts";
import { trustEntries, writeTrustEntries, userCodexConfigPath } from "./codex-trust.ts";
import { defaultConfig, saveConfig, CRANK_DIR } from "../hooks/lib/config.ts";
import { fullScan } from "../hooks/lib/scanner.ts";
import { saveIndex, saveAnatomyMd } from "../hooks/lib/store.ts";
import { withLock, CLI_LOCK_BUDGET_MS } from "../hooks/lib/lock.ts";

type GitMode = "commit" | "ignore" | "exclude";

function detectRuntime(): "bun" | "node" | null {
  if (spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0) return "bun";
  const res = spawnSync("node", ["--version"], { encoding: "utf-8" });
  if (res.status === 0) {
    const m = res.stdout.trim().match(/^v(\d+)\.(\d+)/);
    if (m && (Number(m[1]) > 23 || (Number(m[1]) === 23 && Number(m[2]) >= 6))) return "node";
  }
  return null;
}

export async function run(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, ["git", "adr", "codex", "codex-trust"]);
  const yes = flags.yes === true;
  const root = process.cwd();
  const crankDir = path.join(root, CRANK_DIR);

  if (fs.existsSync(path.join(crankDir, "config.json"))) {
    console.error("crank-mem: already initialized here — use `crank-mem upgrade` or `crank-mem uninstall`.");
    return 1;
  }

  const runtime = detectRuntime();
  if (!runtime) {
    console.error("crank-mem: no suitable runtime — install bun or node >= 23.6. Aborting.");
    return 1;
  }

  // ── Choices ──────────────────────────────────────────────────────────────
  const gitMode = (
    typeof flags.git === "string" ? flags.git
    : yes ? "exclude"
    : await choose("Track crank/ in git?", ["commit", "ignore", "exclude"], "exclude")
  ) as GitMode;
  if (!["commit", "ignore", "exclude"].includes(gitMode)) {
    console.error(`crank-mem: invalid --git ${gitMode}`);
    return 1;
  }

  const adrPath = typeof flags.adr === "string" ? flags.adr : "docs/adr";

  const codexHooksJson = path.join(root, ".codex", "hooks.json");
  let codexMode: string;
  if (typeof flags.codex === "string") {
    codexMode = flags.codex;
  } else if (fs.existsSync(codexHooksJson)) {
    // Pre-existing .codex wiring is a conflict — default to leaving it alone.
    codexMode = yes ? "skip" : await choose(".codex/hooks.json exists — merge crank hooks into it?", ["merge", "skip"], "skip");
  } else {
    codexMode = "merge";
  }

  const codexTrust =
    typeof flags["codex-trust"] === "string" ? flags["codex-trust"]
    : yes ? "skip"
    : await choose("Write Codex trusted_hash entries to ~/.codex/config.toml?", ["write", "skip"], "skip");

  // ── Backups of every file we might modify ────────────────────────────────
  fs.mkdirSync(crankDir, { recursive: true });
  const backupDir = newBackupDir(crankDir);
  const claudeSettings = path.join(
    root, ".claude", gitMode === "commit" ? "settings.json" : "settings.local.json"
  );
  const codexConfigToml = path.join(root, ".codex", "config.toml");
  const gitignore = path.join(root, ".gitignore");
  const gitExclude = path.join(root, ".git", "info", "exclude");

  backupFile(backupDir, claudeSettings);
  if (codexMode === "merge") {
    backupFile(backupDir, codexHooksJson);
    backupFile(backupDir, codexConfigToml);
  }
  if (gitMode === "ignore") backupFile(backupDir, gitignore);
  if (gitMode === "exclude" && fs.existsSync(path.join(root, ".git"))) backupFile(backupDir, gitExclude);
  if (codexTrust === "write") backupFile(backupDir, userCodexConfigPath());

  // ── Vendor hooks + write config ──────────────────────────────────────────
  vendorHooks(crankDir);
  const config = {
    ...defaultConfig(),
    adr_path: adrPath,
    git: gitMode,
    runtime,
    vendored_version: cliVersion(),
    codex_trust_written: codexTrust === "write" && codexMode === "merge",
  };
  saveConfig(crankDir, config);

  // ── Agent wiring ─────────────────────────────────────────────────────────
  mergeHooksIntoFile(claudeSettings, crankHooks(runtime, "claude"));
  if (codexMode === "merge") {
    mergeHooksIntoFile(codexHooksJson, crankHooks(runtime, "codex"));
    ensureCodexFeatures(codexConfigToml);
    if (codexTrust === "write") {
      writeTrustEntries(userCodexConfigPath(), trustEntries(codexHooksJson, crankHooks(runtime, "codex")));
    }
  }

  // ── Git mode ─────────────────────────────────────────────────────────────
  if (gitMode === "ignore") addIgnoreLines(gitignore);
  if (gitMode === "exclude" && fs.existsSync(path.join(root, ".git"))) addIgnoreLines(gitExclude);
  // Even in commit mode, backups and the lockfile never belong in git.
  fs.writeFileSync(path.join(crankDir, ".gitignore"), "backups/\nanatomy-index.lock\n*.tmp\n");

  // ── Seed cerebrum + first scan ───────────────────────────────────────────
  fs.copyFileSync(templatePath("cerebrum.md"), path.join(crankDir, "cerebrum.md"));
  const scanned = withLock(crankDir, CLI_LOCK_BUDGET_MS, () => {
    const index = fullScan(root, config);
    saveIndex(crankDir, index);
    saveAnatomyMd(crankDir, index);
    return index.meta.fileCount;
  });

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`crank-mem ${cliVersion()} initialized (runtime: ${runtime}, git: ${gitMode})`);
  console.log(`  indexed ${scanned ?? "?"} files → crank/anatomy.md`);
  console.log(`  Claude Code: hooks wired into ${path.relative(root, claudeSettings)}`);
  if (codexMode === "merge") {
    console.log(`  Codex: hooks wired into .codex/hooks.json`);
    if (codexTrust === "write") {
      console.log(`  Codex trust: trusted_hash entries written to ${userCodexConfigPath()}`);
    } else {
      console.log(`  Codex trust: open codex once in this project and accept the hooks review`);
      console.log(`  (or headless: codex --dangerously-bypass-hook-trust)`);
    }
  } else {
    console.log(`  Codex: skipped`);
  }
  console.log(`Next: start a Claude Code session here — the file map injects at session start.`);
  return 0;
}

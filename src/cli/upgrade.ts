import * as fs from "node:fs";
import * as path from "node:path";
import { cliVersion } from "./version.ts";
import { vendorHooks } from "./vendor.ts";
import { newBackupDir, backupFile } from "./backups.ts";
import { crankHooks } from "./settings.ts";
import { trustEntries, writeTrustEntries, userCodexConfigPath } from "./codex-trust.ts";
import { loadConfig, saveConfig, CRANK_DIR } from "../hooks/lib/config.ts";

// Non-interactive: re-vendor hooks after a `git pull` in the clone. Never
// touches config.json values (beyond the version stamp), cerebrum, or the
// index. Recomputes Codex trusted hashes iff the user opted in at init.

export async function run(_args: string[]): Promise<number> {
  const root = process.cwd();
  const crankDir = path.join(root, CRANK_DIR);
  if (!fs.existsSync(path.join(crankDir, "config.json"))) {
    console.error("crank-mem: not initialized here — run `crank-mem init` first.");
    return 1;
  }
  const config = loadConfig(crankDir);
  const current = cliVersion();

  if (config.vendored_version === current) {
    console.log(`crank-mem: already at ${current} — nothing to do.`);
    return 0;
  }

  // Backup the vendored hooks (as files under a timestamped backup dir).
  const backupDir = newBackupDir(crankDir);
  const hooksDir = path.join(crankDir, "hooks");
  if (fs.existsSync(hooksDir)) {
    fs.cpSync(hooksDir, path.join(backupDir, "hooks"), { recursive: true });
  }

  vendorHooks(crankDir);
  const prev = config.vendored_version;
  config.vendored_version = current;
  saveConfig(crankDir, config);

  if (config.codex_trust_written) {
    const codexHooksJson = path.join(root, ".codex", "hooks.json");
    backupFile(backupDir, userCodexConfigPath());
    writeTrustEntries(userCodexConfigPath(), trustEntries(codexHooksJson, crankHooks(config.runtime, "codex")));
    console.log(`  recomputed Codex trusted_hash entries`);
  }

  console.log(`crank-mem: upgraded vendored hooks ${prev} → ${current}`);
  return 0;
}

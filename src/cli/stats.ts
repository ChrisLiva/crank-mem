import * as fs from "node:fs";
import * as path from "node:path";
import { openProject } from "./project.ts";
import { loadIndex, INDEX_FILE } from "../hooks/lib/store.ts";
import { walkProject } from "../hooks/lib/scanner.ts";
import { hasCrankHooks } from "./settings.ts";
import { installedAtMs } from "./backups.ts";
import { codexInjectionGaps } from "./codex-sessions.ts";
import { codexHome, codexTrustStatus, userCodexConfigPath, CODEX_REVIEW_HINT } from "./codex-trust.ts";

function age(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export async function run(_args: string[]): Promise<number> {
  const project = openProject();
  if (!project) return 1;
  const { root, crankDir, config } = project;
  const index = loadIndex(crankDir);
  // Uncapped: the hooks' walk stops at max_files, so its count cannot show
  // how much of the project the cap leaves out. stats has no time budget.
  const walked = walkProject(root, { ...config, max_files: Infinity }).files;
  const indexed = Object.keys(index.files).length;
  const coverage = walked.length === 0 ? 100 : Math.round((100 * indexed) / walked.length);
  let indexSize = 0;
  try {
    indexSize = fs.statSync(path.join(crankDir, INDEX_FILE)).size;
  } catch {}

  console.log(`crank-mem stats`);
  console.log(`  files indexed:    ${indexed}${index.meta.truncated ? ` (capped at max_files ${config.max_files})` : ""}`);
  console.log(`  indexable files:  ${walked.length} (coverage ${coverage}%)`);
  console.log(`  last scan:        ${age(index.meta.lastScanned)}${index.meta.partial ? " (partial)" : ""}`);
  console.log(`  index size:       ${(indexSize / 1024).toFixed(1)} KB`);
  console.log(`  runtime:          ${config.runtime} (vendored ${config.vendored_version})`);
  console.log(`  injection budget: ${config.injection_budget_bytes} bytes`);

  const codexHooks = path.join(root, ".codex", "hooks.json");
  if (!hasCrankHooks(codexHooks)) {
    console.log(`  codex:            not wired`);
    return 0;
  }
  // Codex logs nothing when a hook never runs, so read its own rollouts and
  // trust config to show whether the wiring is live.
  const since = installedAtMs(crankDir);
  const gaps = codexInjectionGaps(path.join(codexHome(), "sessions"), root, since);
  const trust = codexTrustStatus(userCodexConfigPath(), root, codexHooks);
  const hashes = trust.current + trust.stale + trust.missing;
  const window = since === null ? "" : " since install";
  console.log(
    gaps.roots === 0
      ? `  codex sessions:   no root threads${window}`
      : `  codex sessions:   ${gaps.missed} of ${gaps.roots} root threads${window} got no injection`
  );
  console.log(
    `  codex hook trust: ${trust.current} of ${hashes} hashes current` +
      `${trust.stale ? `, ${trust.stale} stale` : ""}${trust.missing ? `, ${trust.missing} missing` : ""}`
  );
  if (trust.projectTrustLevel === null) {
    // Codex may resolve trust from a parent directory; no probe has tested that (ADR 0002).
    console.log(`  codex project:    no exact-path trust_level in ${userCodexConfigPath()}; a parent directory's entry may apply`);
  } else if (trust.projectTrustLevel !== "trusted") {
    console.log(`  codex project:    trust_level = "${trust.projectTrustLevel}", so codex loads no .codex/ hooks here`);
  }
  if (trust.stale || trust.missing) for (const line of CODEX_REVIEW_HINT) console.log(line);
  return 0;
}

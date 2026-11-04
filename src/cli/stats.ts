import * as fs from "node:fs";
import * as path from "node:path";
import { openProject } from "./project.ts";
import { loadIndex, INDEX_FILE, type AnatomyIndex } from "../hooks/lib/store.ts";
import { walkProject } from "../hooks/lib/scanner.ts";
import type { CrankConfig } from "../hooks/lib/config.ts";
import { composeInjection, fileCitations, injectionSources } from "../hooks/lib/injection.ts";
import { auditSkillInstalled, installedAtMs, lastAuditMs } from "../hooks/lib/cerebrum-files.ts";
import { hasCrankHooks } from "./settings.ts";
import { codexInjectionGaps } from "./codex-sessions.ts";
import { codexHome, codexTrustStatus, userCodexConfigPath, CODEX_REVIEW_HINT } from "./codex-trust.ts";
import { readStopState } from "../hooks/lib/user-state.ts";
import { daemonAlive, readParked, readSpool } from "../hooks/lib/spool.ts";
import { memoryPath, openMemory } from "../hooks/lib/memory.ts";
import { EMBED_MODEL, embedderReady } from "../daemon/embedder.ts";

function age(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

const row = (label: string, value: string): string => `  ${(label + ":").padEnd(18)}${value}`;
const ageOf = (ms: number): string => age(new Date(ms).toISOString());

/**
 * How much of cerebrum reaches a session, whether the paths it cites still
 * exist, and when the audit skill last ran. The excerpt counts come from
 * composing the injection a Claude session start would get, minus the
 * occasional staleness and drift notes, so the budget that cuts bullets is the
 * real one.
 */
function memoryLines(root: string, crankDir: string, config: CrankConfig, index: AnatomyIndex): string[] {
  const lines: string[] = [];
  const sources = injectionSources(root, crankDir, config, index, false);
  const { cerebrumMd } = sources;

  if (!cerebrumMd) {
    lines.push(row("cerebrum", cerebrumMd === null ? "missing" : "empty"));
  } else {
    const { excerpt } = composeInjection(sources, config.injection_budget_bytes);
    const e = excerpt!;
    lines.push(row("cerebrum bullets", `${e.shown} of ${e.total} injected`));
    lines.push(row("prefs dropped", `${e.prefsTotal - e.prefsShown} of ${e.prefsTotal}`));

    // A bullet's date is the latest one it carries: a (supersedes …) date is older.
    // A string Date.parse rejects, such as MySQL's 0000-00-00, is not a date.
    const dates = e.hidden.map(
      (b) => b.match(/\b\d{4}-\d{2}-\d{2}\b/g)?.filter((d) => !Number.isNaN(Date.parse(d))).sort().at(-1) ?? null,
    );
    const dated = dates.filter((d): d is string => d !== null).sort();
    const undated = dates.length - dated.length;
    lines.push(
      row(
        "oldest hidden",
        !dates.length
          ? "none hidden"
          : (dated.length ? `${dated[0]} (${ageOf(Date.parse(dated[0]!))})` : "no dated bullet") +
              (undated ? `, ${undated} undated` : ""),
      ),
    );

    // Only paths with a directory: a bare basename may live anywhere.
    const cited = [...new Set(fileCitations(cerebrumMd).filter((rel) => rel.includes("/")))];
    const existing = cited.filter((rel) => fs.existsSync(path.join(root, rel))).length;
    lines.push(row("cited paths", cited.length ? `${existing} of ${cited.length} exist` : "none cited"));
  }

  const audited = lastAuditMs(crankDir);
  const installed = installedAtMs(crankDir);
  const skill = auditSkillInstalled(root, false) || auditSkillInstalled(root, true) ? "" : "; audit skill not installed";
  lines.push(
    row(
      "last audit",
      (audited !== null ? ageOf(audited) : installed !== null ? `never (installed ${ageOf(installed)})` : "never") + skill,
    ),
  );
  return lines;
}

const MEMORY_STATE = {
  missing: "none yet",
  newer: "newer than this version; run crank-mem upgrade",
  unreadable: "unreadable",
} as const;

/** To the cent, or to two significant digits under a cent: one Haiku digest costs about $0.002. */
function dollars(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toPrecision(2)}` : `$${usd.toFixed(2)}`;
}

/** Whether digests run, what waits for them user-wide, what the store holds, and whether search by meaning works. */
async function captureLines(root: string, config: CrankConfig): Promise<string[]> {
  const stop = readStopState();
  const lines = [
    row("digest", !config.digest ? "off" : stop ? `stopped (${stop.reason})` : "on"),
    row("daemon", daemonAlive() ? "alive" : "not running"),
    row("spool", `${readSpool().length} waiting, ${readParked().length} parked`),
  ];
  const opened = openMemory(memoryPath(root), "read");
  if (opened.status === "open") {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let s;
    try {
      s = opened.memory.stats(EMBED_MODEL, monthStart);
    } finally {
      opened.memory.close();
    }
    lines.push(row("observations", String(s.observations)));
    lines.push(row("unembedded", String(s.unembedded)));
    lines.push(row("last digest", s.lastDigestMs === null ? "never" : ageOf(s.lastDigestMs)));
    lines.push(row("month cost", `${dollars(s.costUsdSince)} (list price)`));
  } else {
    lines.push(row("memory", MEMORY_STATE[opened.status]));
  }
  lines.push(row("embedder", (await embedderReady()) ? "ready" : "not ready (run crank-mem setup)"));
  return lines;
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
  for (const line of memoryLines(root, crankDir, config, index)) console.log(line);
  for (const line of await captureLines(root, config)) console.log(line);

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

import * as fs from "node:fs";
import * as path from "node:path";
import { openProject } from "./project.ts";
import { loadIndex, INDEX_FILE, type AnatomyIndex } from "../hooks/lib/store.ts";
import { walkProject } from "../hooks/lib/scanner.ts";
import type { CrankConfig } from "../hooks/lib/config.ts";
import { composeInjection, fileCitations, listAdrFilenames } from "../hooks/lib/injection.ts";
import { recentJournalBullets, JOURNAL_FILE, NEXT_MARKER } from "../hooks/lib/journal.ts";
import { parseBullets } from "../hooks/lib/bullets.ts";
import { countChangedSince } from "../hooks/lib/changes.ts";
import { LOG_FILE } from "../hooks/lib/debug.ts";
import { auditSkillInstalled, lastAuditMs, overlapPairCount, OVERLAP_MIN_SHARED } from "../hooks/lib/cerebrum-nudge.ts";
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

const row = (label: string, value: string): string => `  ${(label + ":").padEnd(18)}${value}`;
const ageOf = (ms: number): string => age(new Date(ms).toISOString());

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/**
 * How much of the memory reaches a session and how current it is. The excerpt
 * counts come from composing the injection a Claude session start would get,
 * minus the occasional staleness and drift notes, so the budget that cuts
 * bullets is the real one.
 */
function memoryLines(root: string, crankDir: string, config: CrankConfig, index: AnatomyIndex): string[] {
  const lines: string[] = [];
  const cerebrumMd = readText(path.join(crankDir, "cerebrum.md"));
  const journalMd = readText(path.join(crankDir, JOURNAL_FILE));

  if (!cerebrumMd) {
    lines.push(row("cerebrum", cerebrumMd === null ? "missing" : "empty"));
  } else {
    const journalBullets = recentJournalBullets(crankDir);
    let journalChanged: number | undefined;
    try {
      if (journalBullets.length) {
        journalChanged = countChangedSince(root, config, index, fs.statSync(path.join(crankDir, JOURNAL_FILE)).mtimeMs);
      }
    } catch {}
    const { excerpt } = composeInjection(
      {
        cerebrumMd,
        journalBullets,
        adrFilenames: listAdrFilenames(root, config.adr_path),
        index,
        adrPath: config.adr_path,
        projectRoot: root,
        journalChanged,
      },
      config.injection_budget_bytes,
    );
    const e = excerpt!;
    lines.push(row("cerebrum bullets", `${e.shown} of ${e.total} injected`));
    lines.push(row("prefs dropped", `${e.prefsTotal - e.prefsShown} of ${e.prefsTotal}`));

    // A bullet's date is the latest one it carries: a (supersedes …) date is older.
    const dates = e.hidden.map((b) => b.match(/\b\d{4}-\d{2}-\d{2}\b/g)?.sort().at(-1) ?? null);
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
    lines.push(row("overlaps", `${overlapPairCount(cerebrumMd)} bullet pair(s) share ${OVERLAP_MIN_SHARED}+ identifiers`));
  }

  if (journalMd === null) {
    lines.push(row("journal", "missing"));
  } else {
    const entries = parseBullets(journalMd.split("\n"));
    lines.push(row("journal no NEXT", `${entries.filter((b) => !b.includes(NEXT_MARKER)).length} of ${entries.length} entries`));
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
  lines.push(row("nudges", nudgeCounts(crankDir)));
  return lines;
}

/** Nudge parts emitted and overlap flags raised, as recorded in debug.log. */
function nudgeCounts(crankDir: string): string {
  const log = readText(path.join(crankDir, LOG_FILE));
  if (log === null) return "n/a (debug off)";
  const counts = { record: 0, journal: 0, prune: 0, audit: 0, overlap: 0 };
  let since: string | null = null;
  for (const line of log.split("\n")) {
    let rec: { ts?: unknown; events?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (since === null && typeof rec.ts === "string") since = rec.ts.slice(0, 10);
    for (const e of Array.isArray(rec.events) ? rec.events : []) {
      if (e?.event === "nudge-emitted") {
        if (e.recordDue) counts.record++;
        if (e.journalDue) counts.journal++;
        if (e.pruneDue) counts.prune++;
        if (e.auditDue) counts.audit++;
      } else if (e?.event === "overlap-checked" && e.pairs > 0) {
        counts.overlap++;
      }
    }
  }
  const parts = Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ");
  return since === null ? parts : `${parts} since ${since}`;
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

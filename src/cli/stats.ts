import * as fs from "node:fs";
import * as path from "node:path";
import { openProject } from "./project.ts";
import { loadIndex, INDEX_FILE, type AnatomyIndex } from "../hooks/lib/store.ts";
import { walkProject } from "../hooks/lib/scanner.ts";
import type { CrankConfig } from "../hooks/lib/config.ts";
import { fileCitations, sessionStartInjection } from "../hooks/lib/injection.ts";
import {
  auditSkillInstalled,
  CEREBRUM_FILE,
  installedAtMs,
  lastAuditMs,
} from "../hooks/lib/cerebrum-files.ts";
import { hasCrankHooks } from "./settings.ts";
import { installPaths } from "./install-support.ts";
import { codexInjectionGaps } from "./codex-sessions.ts";
import {
  codexHome,
  codexTrustStatus,
  userCodexConfigPath,
  CODEX_REVIEW_HINT,
} from "./codex-trust.ts";
import { readStopState } from "../hooks/lib/user-state.ts";
import { daemonAlive, readParked, readSpool, type SpoolItem } from "../hooks/lib/spool.ts";
import { formatUsd, projectStatus, type HealthSummary } from "../hooks/lib/wire.ts";
import { localDate, memoryPath, openMemory } from "../hooks/lib/memory.ts";
import { latestSnapshot } from "../hooks/lib/store-upkeep.ts";
import { EMBED_MODEL, embedderReady } from "../daemon/embedder.ts";
import { readUpdateState, updateAvailable } from "./updates.ts";
import { installedCopy } from "./version.ts";

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
 * staleness note, so the budget that cuts bullets is the real one.
 */
function memoryLines(
  root: string,
  crankDir: string,
  config: CrankConfig,
  index: AnatomyIndex,
): string[] {
  const lines: string[] = [];
  let cerebrumMd: string | null = null;
  try {
    cerebrumMd = fs.readFileSync(path.join(crankDir, CEREBRUM_FILE), "utf-8");
  } catch {
    // Unreadable: cerebrumMd stays null and the row reads missing.
  }
  const { excerpt: e } = sessionStartInjection(root, crankDir, config, index, {
    codex: false,
    source: null,
    stalenessNote: null,
  });

  if (!e) {
    lines.push(row("cerebrum", cerebrumMd === null ? "missing" : "empty"));
  } else {
    lines.push(row("cerebrum bullets", `${e.shown} of ${e.total} injected`));
    lines.push(row("prefs dropped", `${e.prefsTotal - e.prefsShown} of ${e.prefsTotal}`));

    // A bullet's date is the latest one it carries: a (supersedes …) date is older.
    // A string Date.parse rejects, such as MySQL's 0000-00-00, is not a date.
    const dates = e.hidden.map(
      (b) =>
        b
          .match(/\b\d{4}-\d{2}-\d{2}\b/g)
          ?.filter((d) => !Number.isNaN(Date.parse(d)))
          .sort()
          .at(-1) ?? null,
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
    const cited = [...new Set(fileCitations(cerebrumMd ?? "").filter((rel) => rel.includes("/")))];
    const existing = cited.filter((rel) => fs.existsSync(path.join(root, rel))).length;
    lines.push(
      row("cited paths", cited.length ? `${existing} of ${cited.length} exist` : "none cited"),
    );
  }

  const audited = lastAuditMs(crankDir);
  const installed = installedAtMs(crankDir);
  const skill =
    auditSkillInstalled(root, false) || auditSkillInstalled(root, true)
      ? ""
      : "; audit skill not installed";
  lines.push(
    row(
      "last audit",
      (audited !== null
        ? ageOf(audited)
        : installed !== null
          ? `never (installed ${ageOf(installed)})`
          : "never") + skill,
    ),
  );
  return lines;
}

/** The `update:` row's value: an available release, the last check's date, or no check yet. */
function updateValue(): string {
  const state = readUpdateState();
  if (updateAvailable(state))
    return `${state.latest.version} available — run \`crank-mem self-update\``;
  if (state.latest !== null && state.checkedAtMs !== null)
    return `up to date (checked ${localDate(state.checkedAtMs)})`;
  return "not checked yet";
}

const MEMORY_STATE = {
  missing: "none yet",
  older: "older than this version; run crank-mem upgrade",
  newer: "newer than this version; run crank-mem upgrade",
  unreadable: "unreadable",
} as const;

/**
 * Whether digests run, what waits for them from this project, what the store holds,
 * and whether search by meaning works: the dashboard's Health view reads it, and
 * `captureRows` prints it.
 */
export async function captureSummary(root: string, config: CrankConfig): Promise<HealthSummary> {
  const stop = readStopState();
  const ours = (items: SpoolItem[]) => items.filter(({ entry }) => entry.projectRoot === root);
  const store = memoryPath(root);
  const opened = openMemory(store, "read");
  let memory: HealthSummary["memory"] = null;
  if (opened.status === "open") {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    try {
      const s = opened.memory.stats(EMBED_MODEL, monthStart);
      memory = {
        observations: s.observations,
        unembedded: s.unembedded,
        lastDigestMs: s.lastDigestMs,
        monthCostUsd: s.costUsdSince,
        pendingProposals: s.pendingProposals,
        staleFlags: s.staleRows,
        lastConsolidation: s.lastConsolidation,
      };
    } finally {
      opened.memory.close();
    }
  }
  const facts: Omit<HealthSummary, "status"> = {
    digest: !config.digest ? "off" : stop ? "stopped" : "on",
    stopReason: config.digest && stop ? stop.reason : null,
    daemonAlive: daemonAlive(),
    spool: { waiting: ours(readSpool()).length, parked: ours(readParked()).length },
    store: opened.status,
    memory,
    lastSnapshotMs: latestSnapshot(store)?.atMs ?? null,
    embedderReady: await embedderReady(),
  };
  return { ...facts, status: projectStatus(facts) };
}

/**
 * `captureSummary` as the label and value pairs `stats` pads, except that the
 * spool row counts what waits user-wide; the status row counts this project's.
 */
async function captureRows(
  root: string,
  config: CrankConfig,
): Promise<[label: string, value: string][]> {
  const s = await captureSummary(root, config);
  const { label, fix } = s.status;
  const rows: [label: string, value: string][] = [
    [
      "status",
      fix === null ? label : `${label} — ${fix.text}${fix.command ? ` Run: ${fix.command}` : ""}`,
    ],
    ["digest", s.digest === "stopped" ? `stopped (${s.stopReason})` : s.digest],
    ["daemon", s.daemonAlive ? "alive" : "not running"],
    ["spool", `${readSpool().length} waiting, ${readParked().length} parked`],
  ];
  const m = s.memory;
  if (m !== null) {
    rows.push(["observations", String(m.observations)]);
    rows.push(["unembedded", String(m.unembedded)]);
    rows.push(["last digest", m.lastDigestMs === null ? "never" : ageOf(m.lastDigestMs)]);
    rows.push(["month cost", `${formatUsd(m.monthCostUsd)} (list price)`]);
    rows.push(["proposals", String(m.pendingProposals)]);
    rows.push(["stale", String(m.staleFlags)]);
    const last = m.lastConsolidation;
    rows.push([
      "consolidation",
      last === null ? "never" : `${ageOf(last.startedMs)} (${last.outcome})`,
    ]);
  } else if (s.store !== "open") {
    rows.push(["memory", MEMORY_STATE[s.store]]);
  }
  rows.push(["last snapshot", s.lastSnapshotMs === null ? "never" : ageOf(s.lastSnapshotMs)]);
  rows.push(["embedder", s.embedderReady ? "ready" : "not ready (run crank-mem setup)"]);
  return rows;
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
  } catch {
    // No index yet: the size reads 0.
  }

  console.log(`crank-mem stats`);
  console.log(
    `  files indexed:    ${indexed}${index.meta.truncated ? ` (capped at max_files ${config.max_files})` : ""}`,
  );
  console.log(`  indexable files:  ${walked.length} (coverage ${coverage}%)`);
  console.log(
    `  last scan:        ${age(index.meta.lastScanned)}${index.meta.partial ? " (partial)" : ""}`,
  );
  console.log(`  index size:       ${(indexSize / 1024).toFixed(1)} KB`);
  console.log(`  runtime:          ${config.runtime} (vendored ${config.vendored_version})`);
  console.log(`  injection budget: ${config.injection_budget_bytes} bytes`);
  if (installedCopy()) console.log(row("update", updateValue()));
  for (const line of memoryLines(root, crankDir, config, index)) console.log(line);
  for (const [label, value] of await captureRows(root, config)) console.log(row(label, value));

  const { codexHooks } = installPaths(root);
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
      : `  codex sessions:   ${gaps.missed} of ${gaps.roots} root threads${window} got no injection`,
  );
  console.log(
    `  codex hook trust: ${trust.current} of ${hashes} hashes current` +
      `${trust.stale ? `, ${trust.stale} stale` : ""}${trust.missing ? `, ${trust.missing} missing` : ""}`,
  );
  if (trust.projectTrustLevel === null) {
    // Codex may resolve trust from a parent directory; no probe has tested that (ADR 0002).
    console.log(
      `  codex project:    no exact-path trust_level in ${userCodexConfigPath()}; a parent directory's entry may apply`,
    );
  } else if (trust.projectTrustLevel !== "trusted") {
    console.log(
      `  codex project:    trust_level = "${trust.projectTrustLevel}", so codex loads no .codex/ hooks here`,
    );
  }
  if (trust.stale || trust.missing) for (const line of CODEX_REVIEW_HINT) console.log(line);
  return 0;
}

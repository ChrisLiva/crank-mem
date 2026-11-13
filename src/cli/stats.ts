import * as fs from "node:fs";
import * as path from "node:path";
import { openProject } from "./project.ts";
import { loadIndex, INDEX_FILE, type AnatomyIndex } from "../hooks/lib/store.ts";
import { walkProject } from "../hooks/lib/scanner.ts";
import type { CrankConfig } from "../hooks/lib/config.ts";
import { citationCheck, fileCitations, type CitationCheck } from "../hooks/lib/citations.ts";
import { readCerebrum, sessionStartInjection, type Excerpt } from "../hooks/lib/injection.ts";
import { auditSkillInstalled, installedAtMs, lastAuditMs } from "../hooks/lib/cerebrum-files.ts";
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
import { readUntouched } from "../hooks/lib/untouched.ts";
import { daemonAlive, readParked, readSpool, type SpoolItem } from "../hooks/lib/spool.ts";
import { formatUsd, projectStatus, type HealthSummary } from "../hooks/lib/wire.ts";
import { localDate, memoryPath, openMemory } from "../hooks/lib/memory.ts";
import { ISO_DATE } from "../hooks/lib/bullets.ts";
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
  const cerebrumMd = readCerebrum(crankDir);
  const { excerpt: e } = sessionStartInjection(root, crankDir, config, index, {
    codex: false,
    source: null,
    stalenessNote: null,
  });
  const check = citationCheck({ root, index });
  const lines = e
    ? excerptRows(cerebrumMd, e, check)
    : [row("cerebrum", cerebrumMd === null ? "missing" : "empty")];
  lines.push(row("last audit", lastAuditValue(root, crankDir)));
  return lines;
}

function excerptRows(cerebrumMd: string | null, e: Excerpt, check: CitationCheck): string[] {
  // Only paths with a directory: a bare basename may live anywhere.
  const cited = [...new Set(fileCitations(cerebrumMd ?? "").filter((rel) => rel.includes("/")))];
  const missing = new Set(check.status(cerebrumMd ?? "", null).missing);
  const existing = cited.filter((rel) => !missing.has(rel)).length;
  return [
    row("cerebrum bullets", `${e.shown} of ${e.total} injected`),
    row("prefs dropped", `${e.prefsTotal - e.prefsShown} of ${e.prefsTotal}`),
    row("oldest hidden", oldestHidden(e.hidden)),
    row("cited paths", cited.length ? `${existing} of ${cited.length} exist` : "none cited"),
  ];
}

/** The `oldest hidden` row's value: the oldest hidden bullet's date and age, and how many carry none. */
function oldestHidden(hidden: string[]): string {
  if (!hidden.length) return "none hidden";
  // A bullet's date is the latest one it carries: a (supersedes …) date is older.
  // A string Date.parse rejects, such as MySQL's 0000-00-00, is not a date.
  const dates = hidden.map(
    (b) =>
      b
        .match(ISO_DATE)
        ?.filter((d) => !Number.isNaN(Date.parse(d)))
        .sort()
        .at(-1) ?? null,
  );
  const dated = dates.filter((d): d is string => d !== null).sort();
  const undated = dates.length - dated.length;
  return (
    (dated.length ? `${dated[0]} (${ageOf(Date.parse(dated[0]!))})` : "no dated bullet") +
    (undated ? `, ${undated} undated` : "")
  );
}

/** The `last audit` row's value: when the audit skill last ran, and whether it is installed. */
function lastAuditValue(root: string, crankDir: string): string {
  const audited = lastAuditMs(crankDir);
  const installed = installedAtMs(crankDir);
  const skill =
    auditSkillInstalled(root, false) || auditSkillInstalled(root, true)
      ? ""
      : "; audit skill not installed";
  if (audited !== null) return ageOf(audited) + skill;
  if (installed !== null) return `never (installed ${ageOf(installed)})` + skill;
  return "never" + skill;
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

/** The index rows: files indexed, coverage of the uncapped walk, last scan, size and config. */
function indexLines(
  root: string,
  crankDir: string,
  config: CrankConfig,
  index: AnatomyIndex,
): string[] {
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
  return [
    `  files indexed:    ${indexed}${index.meta.truncated ? ` (capped at max_files ${config.max_files})` : ""}`,
    `  indexable files:  ${walked.length} (coverage ${coverage}%)`,
    `  last scan:        ${age(index.meta.lastScanned)}${index.meta.partial ? " (partial)" : ""}`,
    `  index size:       ${(indexSize / 1024).toFixed(1)} KB`,
    `  runtime:          ${config.runtime} (vendored ${config.vendored_version})`,
    `  injection budget: ${config.injection_budget_bytes} bytes`,
  ];
}

/** The `not installed` row and one line per repo agents read or wrote that has no crank-mem install. */
function untouchedLines(): string[] {
  const repos = readUntouched();
  if (repos.length === 0) return [row("not installed", "none")];
  return [
    row("not installed", String(repos.length)),
    ...repos.map((r) => `    ${r.root}  last seen ${localDate(r.lastSeenMs)}`),
  ];
}

/** The codex rows: wiring, whether root threads got the injection, and hook and project trust. */
function codexLines(root: string, crankDir: string, codexHooks: string): string[] {
  if (!hasCrankHooks(codexHooks)) return [`  codex:            not wired`];
  // Codex logs nothing when a hook never runs, so read its own rollouts and
  // trust config to show whether the wiring is live.
  const since = installedAtMs(crankDir);
  const gaps = codexInjectionGaps(path.join(codexHome(), "sessions"), root, since);
  const trust = codexTrustStatus(userCodexConfigPath(), root, codexHooks);
  const hashes = trust.current + trust.stale + trust.missing;
  const window = since === null ? "" : " since install";
  const lines = [
    gaps.roots === 0
      ? `  codex sessions:   no root threads${window}`
      : `  codex sessions:   ${gaps.missed} of ${gaps.roots} root threads${window} got no injection`,
    `  codex hook trust: ${trust.current} of ${hashes} hashes current` +
      `${trust.stale ? `, ${trust.stale} stale` : ""}${trust.missing ? `, ${trust.missing} missing` : ""}`,
  ];
  if (trust.projectTrustLevel === null) {
    // Codex may resolve trust from a parent directory; no probe has tested that (ADR 0002).
    lines.push(
      `  codex project:    no exact-path trust_level in ${userCodexConfigPath()}; a parent directory's entry may apply`,
    );
  } else if (trust.projectTrustLevel !== "trusted") {
    lines.push(
      `  codex project:    trust_level = "${trust.projectTrustLevel}", so codex loads no .codex/ hooks here`,
    );
  }
  if (trust.stale || trust.missing) lines.push(...CODEX_REVIEW_HINT);
  return lines;
}

export async function run(_args: string[]): Promise<number> {
  const project = openProject();
  if (!project) return 1;
  const { root, crankDir, config } = project;
  const index = loadIndex(crankDir);
  console.log(`crank-mem stats`);
  for (const line of indexLines(root, crankDir, config, index)) console.log(line);
  if (installedCopy()) console.log(row("update", updateValue()));
  for (const line of memoryLines(root, crankDir, config, index)) console.log(line);
  for (const [label, value] of await captureRows(root, config)) console.log(row(label, value));
  for (const line of untouchedLines()) console.log(line);
  for (const line of codexLines(root, crankDir, installPaths(root).codexHooks)) console.log(line);
  return 0;
}

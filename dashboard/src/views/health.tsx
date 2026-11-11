import { useState } from "react";
import { cn } from "cn";
import {
  fetchActivity,
  fetchConsolidations,
  formatUsd,
  type ActivityDay,
  type ActivityWindow,
  type ConsolidationRow,
  type HealthSummary,
  type Note,
  type Project,
  type Status,
  type Tone,
} from "@/api";
import { DayColumns, Sparkline } from "@/components/chart";
import { usePerProject } from "@/hooks/use-per-project";
import { usePoll } from "@/hooks/use-poll";
import {
  Command,
  Dot,
  formatAgo,
  formatTime,
  OUTCOME_TONE,
  Pairs,
  Pill,
  Segmented,
  Stat,
  TONE_TEXT,
  WINDOWS,
} from "./shared";

const TREND_DAYS = 30;
const fetchTrend = (id: string) => fetchActivity(id, TREND_DAYS);

/** One project's line in the projects overview. */
type Line = {
  project: Project;
  health: HealthSummary | undefined;
  trend: ActivityDay[] | null;
  status: Status | null;
  selected: boolean;
  focus: () => void;
};

/** The projects overview, then `ProjectDetail` for the focused project. */
export function HealthView({
  projects,
  health,
  projectId,
  focus,
  openCuration,
}: {
  projects: Project[];
  health: Record<string, HealthSummary | undefined>;
  projectId: string;
  focus: (id: string) => void;
  openCuration: () => void;
}) {
  const trends = usePerProject(projects, fetchTrend);
  const lines = projects.map((p): Line => {
    const h = health[p.id];
    const trend = trends[p.id];
    return {
      project: p,
      health: h,
      trend: trend === undefined || "note" in trend ? null : trend,
      status: h === undefined ? null : h.status,
      selected: p.id === projectId,
      focus: () => focus(p.id),
    };
  });
  const attention = lines.filter((l) => l.status !== null && l.status.tone !== "ok").length;
  const focused = projects.find((p) => p.id === projectId)!;

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto grid w-full max-w-[1400px] gap-10 px-4 py-6 md:px-6 md:py-8">
        <section aria-labelledby="projects-heading" className="grid gap-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="grid gap-1">
              <h1 id="projects-heading" className="text-xl font-semibold tracking-tight">
                Projects
              </h1>
              <p className="text-muted-foreground">
                {projects.length} {projects.length === 1 ? "project" : "projects"} on this machine
                {attention > 0 && ` · ${attention} ${attention === 1 ? "needs" : "need"} a look`}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">Refreshes every 10 seconds</p>
          </div>
          <ProjectCards lines={lines} />
          <ProjectsTable lines={lines} />
        </section>
        <ProjectDetail
          key={focused.id}
          project={focused}
          health={health[focused.id]}
          openCuration={openCuration}
        />
      </div>
    </main>
  );
}

const MUTED = <span className="text-muted-foreground">—</span>;

function StatusPill({ status }: { status: Status | null }) {
  return status === null ? MUTED : <Pill tone={status.tone}>{status.label}</Pill>;
}

function LastDigest({ health: h }: { health: HealthSummary | undefined }) {
  const ms = h?.memory?.lastDigestMs ?? null;
  if (h === undefined) return MUTED;
  if (ms === null) return <span className="text-muted-foreground">never</span>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={formatTime(ms)}>
      {formatAgo(ms)}
    </time>
  );
}

function Spool({ health: h }: { health: HealthSummary | undefined }) {
  if (h === undefined) return MUTED;
  return (
    <span className={cn(h.spool.parked > 0 && "text-warn")}>
      {h.spool.waiting} waiting · {h.spool.parked} parked
    </span>
  );
}

function Trend({ trend }: { trend: ActivityDay[] | null }) {
  if (trend === null) return MUTED;
  return (
    <Sparkline
      values={trend.map((d) => d.digests)}
      label={`${trend.reduce((n, d) => n + d.digests, 0)} digests in ${TREND_DAYS} days`}
    />
  );
}

/** The fact that stalls capture, with the command that fixes it when one exists. */
function FixLine({ status, className }: { status: Status; className?: string }) {
  if (status.fix === null) return null;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs", className)}>
      <span className={TONE_TEXT[status.tone]}>{status.fix.text}</span>
      {status.fix.command && <Command command={status.fix.command} />}
    </p>
  );
}

/** The overview below the `lg` breakpoint: one card per project. */
function ProjectCards({ lines }: { lines: Line[] }) {
  return (
    <ul className="grid gap-2 lg:hidden">
      {lines.map((l) => {
        const m = l.health?.memory ?? null;
        return (
          <li
            key={l.project.id}
            data-project={l.project.id}
            className={cn("rounded-lg border bg-card", l.selected && "bg-selected")}
          >
            <button
              type="button"
              aria-current={l.selected || undefined}
              onClick={l.focus}
              className="grid w-full gap-1 rounded-lg px-4 pt-3 pb-3 text-left outline-offset-[-2px]"
            >
              <span className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{l.project.name}</span>
                <StatusPill status={l.status} />
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {l.project.root}
              </span>
              <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
                <span>
                  Last digest <LastDigest health={l.health} />
                </span>
                {m !== null && <span>{formatUsd(m.monthCostUsd)} this month</span>}
                {m !== null && <span>{m.observations.toLocaleString()} observations</span>}
              </span>
            </button>
            {l.status !== null && <FixLine status={l.status} className="-mt-1 px-4 pb-3" />}
          </li>
        );
      })}
    </ul>
  );
}

const HEAD = "px-4 py-2.5 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const CELL = "px-4 py-3 whitespace-nowrap";
const COLUMNS = 7;

/** The overview at `lg` and wider: one table row per project, and a fix row under a stalled one. */
function ProjectsTable({ lines }: { lines: Line[] }) {
  return (
    <div className="hidden overflow-x-auto rounded-lg border bg-card lg:block">
      <table className="w-full border-collapse">
        <thead className="border-b bg-muted/50">
          <tr>
            <th className={HEAD}>Project</th>
            <th className={HEAD}>Status</th>
            <th className={HEAD}>Spool</th>
            <th className={HEAD}>Last digest</th>
            <th className={cn(HEAD, "text-right")}>Month cost</th>
            <th className={cn(HEAD, "text-right")}>Observations</th>
            <th className={HEAD}>Digests, {TREND_DAYS} days</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <ProjectRows key={l.project.id} line={l} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProjectRows({ line: l }: { line: Line }) {
  const m = l.health?.memory ?? null;
  const fix = l.status?.fix ?? null;
  const rowClass = cn(
    "cursor-pointer hover:bg-accent/60",
    l.selected && "bg-selected hover:bg-selected",
  );
  return (
    <>
      <tr
        data-project={l.project.id}
        onClick={l.focus}
        className={cn(rowClass, fix === null && "border-b last:border-b-0")}
      >
        <td className={CELL}>
          <button
            type="button"
            aria-current={l.selected || undefined}
            onClick={(e) => {
              e.stopPropagation();
              l.focus();
            }}
            className="grid text-left outline-offset-4"
          >
            <span className="font-medium">{l.project.name}</span>
            <span className="max-w-80 truncate font-mono text-xs text-muted-foreground">
              {l.project.root}
            </span>
          </button>
        </td>
        <td className={CELL}>
          <StatusPill status={l.status} />
        </td>
        <td className={cn(CELL, "tabular-nums")}>
          <Spool health={l.health} />
        </td>
        <td className={CELL}>
          <LastDigest health={l.health} />
        </td>
        <td className={cn(CELL, "text-right tabular-nums")}>
          {m === null ? MUTED : formatUsd(m.monthCostUsd)}
        </td>
        <td className={cn(CELL, "text-right tabular-nums")}>
          {m === null ? MUTED : m.observations.toLocaleString()}
        </td>
        <td className={cn(CELL, "py-2")}>
          <Trend trend={l.trend} />
        </td>
      </tr>
      {l.status !== null && fix !== null && (
        <tr onClick={l.focus} className={cn(rowClass, "border-b last:border-b-0")}>
          <td colSpan={COLUMNS} className="px-4 pt-0 pb-3">
            <FixLine status={l.status} />
          </td>
        </tr>
      )}
    </>
  );
}

/** The focused project: its capture figures, its upkeep per day over a chosen window, and its last consolidation. */
function ProjectDetail({
  project,
  health,
  openCuration,
}: {
  project: Project;
  health: HealthSummary | undefined;
  openCuration: () => void;
}) {
  const [days, setDays] = useState<ActivityWindow>(30);
  const [activity, setActivity] = useState<{
    days: ActivityWindow;
    data: ActivityDay[] | Note;
  } | null>(null);
  const [run, setRun] = useState<ConsolidationRow | null>(null);
  usePoll(
    async (isCurrent) => {
      const [data, runs] = await Promise.all([
        fetchActivity(project.id, days),
        fetchConsolidations(project.id, null),
      ]);
      if (isCurrent()) setActivity({ days, data });
      setRun("note" in runs ? null : (runs.rows[0] ?? null));
    },
    [project.id, days],
  );
  const status = health === undefined ? null : health.status;

  return (
    <section aria-labelledby="detail-heading" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {status && <Dot tone={status.tone} className="size-2.5" />}
          <h2 id="detail-heading" className="text-lg font-semibold tracking-tight">
            {project.name}
          </h2>
          {status && <span className="text-muted-foreground">{status.label}</span>}
        </div>
        <Segmented label="Window" options={WINDOWS} value={days} onChange={setDays} />
      </div>
      {status !== null && (
        <FixLine
          status={status}
          className={cn(
            "rounded-lg border px-4 py-3 text-sm",
            status.tone === "bad"
              ? "border-bad-line bg-bad-soft"
              : status.tone === "warn"
                ? "border-warn-line bg-warn-soft"
                : "bg-card",
          )}
        />
      )}
      {health !== undefined && <Stats health={health} />}
      {activity !== null && activity.days === days && (
        <Charts data={activity.data} days={days} run={run} openCuration={openCuration} />
      )}
    </section>
  );
}

const DIGEST_STAT = {
  on: { value: "On", tone: "ok" },
  off: { value: "Off", tone: "off" },
  stopped: { value: "Stopped", tone: "bad" },
} as const satisfies Record<HealthSummary["digest"], { value: string; tone: Tone }>;

/** Why the store's observations are or are not searchable by meaning yet. */
function observationsDetail(h: HealthSummary): string {
  const m = h.memory;
  if (m === null) return `store ${h.store}`;
  if (m.unembedded > 0) return `${m.unembedded} waiting for embeddings`;
  return h.embedderReady ? "all searchable by meaning" : "embedder not ready";
}

function Stats({ health: h }: { health: HealthSummary }) {
  const m = h.memory;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Stat
        label="Digest"
        value={DIGEST_STAT[h.digest].value}
        tone={DIGEST_STAT[h.digest].tone}
        detail={
          m?.lastDigestMs != null ? `last digest ${formatAgo(m.lastDigestMs)}` : "no digest yet"
        }
      />
      <Stat
        label="Daemon"
        value={h.daemonAlive ? "Alive" : "Not running"}
        tone={h.daemonAlive ? "ok" : h.spool.waiting > 0 ? "warn" : "off"}
        detail="one per user, all projects"
      />
      <Stat
        label="Spool"
        value={`${h.spool.waiting} waiting`}
        tone={h.spool.parked > 0 ? "warn" : undefined}
        detail={`${h.spool.parked} parked`}
      />
      <Stat
        label="Observations"
        value={m === null ? "—" : m.observations.toLocaleString()}
        detail={observationsDetail(h)}
      />
      <Stat
        label="Pending proposals"
        value={m === null ? "—" : m.pendingProposals}
        detail={m === null ? undefined : `${m.staleFlags} stale flags`}
      />
      <Stat
        label="Month cost"
        value={m === null ? "—" : formatUsd(m.monthCostUsd)}
        detail="list price, not billed"
      />
    </div>
  );
}

const usdTick = (n: number, step: number) =>
  n === 0 ? "$0" : `$${n.toFixed(Math.max(2, Math.ceil(-Math.log10(step))))}`;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function Charts({
  data,
  days,
  run,
  openCuration,
}: {
  data: ActivityDay[] | Note;
  days: ActivityWindow;
  run: ConsolidationRow | null;
  openCuration: () => void;
}) {
  if ("note" in data) return <p className="text-muted-foreground">{data.note}</p>;
  const dates = data.map((d) => d.date);
  const sum = (key: Exclude<keyof ActivityDay, "date">) => data.reduce((n, d) => n + d[key], 0);
  const window = `last ${days} days`;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <DayColumns
        title="Digests per day"
        note={`${count(sum("digests"), "digest")}, ${count(sum("observations"), "observation")} stored, ${window}`}
        dates={dates}
        series={[
          {
            key: "digests",
            label: "Digests",
            color: "var(--series-1)",
            values: data.map((d) => d.digests),
          },
        ]}
        empty="No digests in this window"
      />
      <DayColumns
        title="Cost per day"
        note={`${formatUsd(sum("costUsd"))} at list price for digests and consolidation, ${window}`}
        dates={dates}
        series={[
          {
            key: "cost",
            label: "Cost",
            color: "var(--series-1)",
            values: data.map((d) => d.costUsd),
          },
        ]}
        format={formatUsd}
        tickFormat={usdTick}
        empty="Nothing spent in this window"
      />
      <DayColumns
        title="Consolidation decisions"
        note={`${count(sum("consolidations"), "consolidation run")}, ${window}`}
        dates={dates}
        series={[
          {
            key: "accepted",
            label: "Accepted",
            color: "var(--series-3)",
            values: data.map((d) => d.accepted),
          },
          {
            key: "rejected",
            label: "Rejected",
            color: "var(--series-2)",
            values: data.map((d) => d.rejected),
          },
          {
            key: "stale",
            label: "Stale flags",
            color: "var(--series-1)",
            values: data.map((d) => d.staleFlags),
          },
        ]}
        empty="No proposals decided or observations flagged in this window"
      />
      <section className="grid content-start gap-3 rounded-lg border bg-card p-4">
        <header className="flex items-start justify-between gap-4">
          <div className="grid gap-0.5">
            <h3 className="text-sm font-semibold">Last consolidation</h3>
            <p className="text-xs text-muted-foreground">
              Checks proposals and stale flags against the code, then edits cerebrum.md
            </p>
          </div>
          <button
            type="button"
            onClick={openCuration}
            className="text-xs font-medium whitespace-nowrap text-link hover:underline"
          >
            Open Curation
          </button>
        </header>
        {run === null ? (
          <p className="text-muted-foreground">No consolidation has run yet.</p>
        ) : (
          <Pairs
            bare
            pairs={[
              ["Outcome", <Pill tone={OUTCOME_TONE[run.outcome]}>{run.outcome}</Pill>],
              ["Started", `${formatTime(run.startedAtMs)} (${formatAgo(run.startedAtMs)})`],
              ["Took", `${Math.max(1, Math.round((run.finishedAtMs - run.startedAtMs) / 1000))} s`],
              ["Model", <span className="font-mono text-xs">{run.model ?? "none"}</span>],
              ["Cost", `${formatUsd(run.costUsd)} at list price`],
            ]}
          />
        )}
      </section>
    </div>
  );
}

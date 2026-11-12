import { useState, type ReactNode } from "react";
import { cn } from "cn";
import { errorMessage } from "../../../src/hooks/lib/wire";
import {
  fetchUsage,
  type ActivityWindow,
  type UsageAnswer,
  type UsageChannel,
  type UsageMetrics,
} from "@/api";
import { BarList, DayColumns } from "@/components/chart";
import { usePoll } from "@/hooks/use-poll";
import {
  formatAgo,
  formatTime,
  ListFoot,
  ObservationLink,
  Row,
  Segmented,
  Stat,
  useSelection,
  WINDOWS,
} from "./shared";

/** A share as a whole percent, or `—` when there was nothing to divide. */
function percent(share: number | null): string {
  return share === null ? "—" : `${Math.round(share * 100)}%`;
}

/** The channels in three kinds, each one chart series: what hooks inject, what agents recall, what they read as code. */
const KINDS: { key: string; label: string; color: string; channels: UsageChannel[] }[] = [
  {
    key: "injected",
    label: "Injected",
    color: "var(--series-1)",
    channels: ["session-start", "subagent-start", "file-history"],
  },
  {
    key: "recall",
    label: "Recall",
    color: "var(--series-2)",
    channels: ["search", "timeline", "get"],
  },
  { key: "code", label: "Code reading", color: "var(--series-3)", channels: ["outline", "unfold"] },
];

export function UsageView({
  projectId,
  item,
  setItem,
  openObservation,
}: {
  projectId: string;
  item: string | null;
  setItem: (item: string | null) => void;
  openObservation: (id: number) => void;
}) {
  const [days, setDays] = useState<ActivityWindow>(30);
  const [manual, setManual] = useState(false);
  const key = JSON.stringify([projectId, days, manual]);
  const [loaded, setLoaded] = useState<{ key: string; metrics: UsageAnswer } | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePoll(
    async (isCurrent) => {
      try {
        const metrics = await fetchUsage(projectId, days, manual);
        if (!isCurrent()) return;
        setLoaded({ key, metrics });
        setError(null);
      } catch (err) {
        if (isCurrent()) setError(errorMessage(err));
      }
    },
    [key],
  );

  const metrics = loaded?.key === key ? loaded.metrics : null;
  const stale = loaded !== null && metrics === null;
  const shown = metrics ?? loaded?.metrics ?? null;
  useSelection(metrics === null ? null : metrics.topQueries.map((q) => q.query), item, setItem);

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto grid w-full max-w-[1400px] gap-6 px-4 py-6 md:px-6 md:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="grid gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
            <p className="text-muted-foreground">
              What hooks inject into agent sessions, and whether agents call recall and code
              reading.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented label="Window" options={WINDOWS} value={days} onChange={setDays} />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={manual}
                onChange={(e) => setManual(e.target.checked)}
                className="size-3.5 accent-[var(--ring)]"
              />
              Include manual runs
            </label>
          </div>
        </div>
        {error !== null ? (
          <p className="text-destructive">{error}</p>
        ) : (
          shown !== null && (
            <div className={cn("grid gap-6 transition-opacity", stale && "opacity-60")}>
              <Shares metrics={shown} />
              <Calls metrics={shown} days={days} />
              <Queries
                metrics={shown}
                item={item}
                setItem={setItem}
                openObservation={openObservation}
              />
              <div className="grid gap-4 lg:grid-cols-2">
                <Ranked
                  title="Most surfaced observations"
                  note="How often hooks and recall showed each observation to an agent"
                  empty="No observation shown yet."
                  extra={shown.note}
                  rows={shown.surfaced.map((s) => ({
                    key: String(s.id),
                    count: s.count,
                    body: (
                      <>
                        <ObservationLink id={s.id} open={openObservation} />
                        {shown.note === undefined && (
                          <span className="min-w-0 truncate">{s.title}</span>
                        )}
                      </>
                    ),
                  }))}
                />
                <Ranked
                  title="Files without memory"
                  note="Files agents read that no stored observation mentions"
                  empty="Every file agents read has memory."
                  rows={shown.filesWithoutMemory.map((f) => ({
                    key: f.path,
                    count: f.count,
                    body: <span className="min-w-0 truncate font-mono text-xs">{f.path}</span>,
                  }))}
                />
              </div>
            </div>
          )
        )}
      </div>
    </main>
  );
}

function Shares({ metrics: m }: { metrics: UsageMetrics }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      <Stat
        label="Recall reach"
        value={percent(m.recallReach)}
        detail="sessions that searched or opened memory"
      />
      <Stat
        label="Surfaced follow-through"
        value={percent(m.surfacedFollowThrough)}
        detail="surfaced ids the agent opened"
      />
      <Stat label="Searches" value={m.searches.toLocaleString()} detail="crank-mem search calls" />
      <Stat
        label="Zero-result searches"
        value={percent(m.zeroResultShare)}
        detail="searches that found nothing"
      />
      <Stat
        label="Keyword-only searches"
        value={percent(m.keywordShare)}
        detail="ran without the local model"
      />
      <Stat
        label="Search follow-through"
        value={percent(m.followThrough)}
        detail="results the agent opened"
      />
      <Stat
        label="Never surfaced"
        value={percent(m.neverSurfacedShare)}
        detail="stored observations no agent saw"
      />
    </div>
  );
}

function Calls({ metrics: m, days }: { metrics: UsageMetrics; days: number }) {
  const total = (channels: UsageChannel[]) =>
    m.perDay.reduce((n, d) => n + channels.reduce((s, c) => s + d.counts[c], 0), 0);
  const most = Math.max(1, ...KINDS.flatMap((k) => k.channels.map((c) => total([c]))));
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
      <DayColumns
        title="Agent calls per day"
        note={`${KINDS.map((k) => `${total(k.channels)} ${k.label.toLowerCase()}`).join(" · ")}, last ${days} days`}
        dates={m.perDay.map((d) => d.date)}
        series={KINDS.map((k) => ({
          key: k.key,
          label: k.label,
          color: k.color,
          values: m.perDay.map((d) => k.channels.reduce((s, c) => s + d.counts[c], 0)),
        }))}
        empty="No usage recorded in this window"
      />
      <section className="grid content-start gap-3 rounded-lg border bg-card p-4">
        <div className="grid gap-0.5">
          <h3 className="text-sm font-semibold">Calls by channel</h3>
          <p className="text-xs text-muted-foreground">
            Each hook and command on one scale, last {days} days
          </p>
        </div>
        {KINDS.map((k) => (
          <div key={k.key} className="grid gap-1.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2.5 rounded-[2px]" style={{ background: k.color }} />
              {k.label}
            </div>
            <BarList
              max={most}
              rows={k.channels.map((c) => ({
                key: c,
                label: <span className="font-mono">{c}</span>,
                value: total([c]),
                color: k.color,
              }))}
            />
          </div>
        ))}
      </section>
    </div>
  );
}

function Queries({
  metrics: m,
  item,
  setItem,
  openObservation,
}: {
  metrics: UsageMetrics;
  item: string | null;
  setItem: (item: string | null) => void;
  openObservation: (id: number) => void;
}) {
  const chosen = m.topQueries.find((q) => q.query === item);
  return (
    <section
      className={cn(
        "grid overflow-hidden rounded-lg border bg-card",
        m.topQueries.length > 0 && "md:grid-cols-[minmax(18rem,26rem)_1fr]",
      )}
    >
      <div
        className={cn(
          "flex min-h-0 flex-col",
          m.topQueries.length > 0 && "border-b md:border-r md:border-b-0",
        )}
      >
        <div className="grid gap-0.5 border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Top queries</h3>
          <p className="text-xs text-muted-foreground">What agents searched for, most run first</p>
        </div>
        <div className="max-h-96 overflow-auto">
          {m.topQueries.length === 0 ? (
            <p className="px-4 py-6 text-muted-foreground">
              No searches in this window. Agents call crank-mem search when the injected memory
              points them to it.
            </p>
          ) : (
            m.topQueries.map((q) => (
              <Row key={q.query} selected={q.query === item} onClick={() => setItem(q.query)}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{q.query}</span>
                  <span className="tabular-nums">{q.count}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {q.meanResults.toFixed(1)} results on average · {formatAgo(q.lastMs)}
                </span>
              </Row>
            ))
          )}
        </div>
        {m.topQueries.length > 0 && <ListFoot start={`${m.searches} searches`} />}
      </div>
      {m.topQueries.length > 0 && (
        <div className="min-w-0 p-4 md:p-5">
          {chosen === undefined ? (
            <p className="text-muted-foreground">Choose a query to see its recent runs.</p>
          ) : (
            <div className="grid gap-4">
              <div className="grid gap-1">
                <h4 className="font-mono text-base font-semibold break-all">{chosen.query}</h4>
                <p className="text-xs text-muted-foreground">
                  {chosen.count} runs · {chosen.meanResults.toFixed(1)} results on average · last{" "}
                  {formatTime(chosen.lastMs)}
                </p>
              </div>
              <ul className="grid rounded-lg border">
                {chosen.runs.map((run, i) => (
                  <li
                    key={`${run.ts}:${i}`}
                    className="flex flex-wrap gap-x-3 gap-y-1 border-b px-3.5 py-2 last:border-b-0"
                  >
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatTime(run.ts)}
                    </span>
                    {run.ids.length === 0 ? (
                      <span className="text-muted-foreground">no results</span>
                    ) : (
                      run.ids.map((id) => (
                        <ObservationLink key={id} id={id} open={openObservation} />
                      ))
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** The rows each ranked list shows, of the `TOP` the metrics answer. */
const RANKED = 10;

/** A titled list of counted rows, most counted first. */
function Ranked({
  title,
  note,
  extra,
  empty,
  rows,
}: {
  title: string;
  note: string;
  extra?: string;
  empty: string;
  rows: { key: string; count: number; body: ReactNode }[];
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-lg border bg-card">
      <div className="grid gap-0.5 border-b px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{note}</p>
        {extra !== undefined && <p className="text-xs text-muted-foreground">{extra}</p>}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-muted-foreground">{empty}</p>
      ) : (
        <ul>
          {rows.slice(0, RANKED).map((row) => (
            <li
              key={row.key}
              className="flex items-center gap-3 border-b px-4 py-2 text-sm last:border-b-0"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">{row.body}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{row.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

import { useRef, useState } from "react";
import { cn } from "cn";
import { fetchUsage, USAGE_CHANNELS, USAGE_DAYS, type UsageDays, type UsageMetrics } from "@/api";
import { Button } from "@/components/ui/button";
import { usePoll } from "@/hooks/use-poll";
import { formatTime, LABEL, ObservationLink, Row, useSelection } from "./curation";

/** A share as a whole percent, or `—` when there was nothing to divide. */
function percent(share: number | null): string {
  return share === null ? "—" : `${Math.round(share * 100)}%`;
}

/** Events per day per channel: one row per channel, one cell per day, darker for more. */
function DayGrid({ perDay }: { perDay: UsageMetrics["perDay"] }) {
  const max = Math.max(1, ...perDay.flatMap((d) => Object.values(d.counts)));
  return (
    <div className="grid gap-1">
      {USAGE_CHANNELS.map((channel) => {
        const total = perDay.reduce((n, d) => n + d.counts[channel], 0);
        return (
          <div key={channel} className="flex items-center gap-2 text-xs">
            <span className="w-24 flex-none truncate text-muted-foreground">{channel}</span>
            <span className="flex h-3 flex-1 gap-px">
              {perDay.map((d) => {
                const n = d.counts[channel];
                return (
                  <span
                    key={d.date}
                    data-day-cell
                    title={`${d.date} · ${channel}: ${n}`}
                    className={cn("flex-1 rounded-[2px]", n === 0 && "bg-muted")}
                    style={
                      n === 0
                        ? undefined
                        : { backgroundColor: `oklch(0.6 0.14 250 / ${0.25 + (0.75 * n) / max})` }
                    }
                  />
                );
              })}
            </span>
            <span className="w-8 flex-none text-right tabular-nums">{total}</span>
          </div>
        );
      })}
      <div className="flex justify-between pr-10 pl-26 text-[11px] text-muted-foreground tabular-nums">
        <span>{perDay[0]?.date}</span>
        <span>{perDay[perDay.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function Shares({ metrics }: { metrics: UsageMetrics }) {
  const tiles: [key: string, label: string, share: number | null][] = [
    ["zero-result", "Zero-result", metrics.zeroResultShare],
    ["keyword", "Keyword", metrics.keywordShare],
    ["follow-through", "Follow-through", metrics.followThrough],
    ["never-surfaced", "Never surfaced", metrics.neverSurfacedShare],
  ];
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {tiles.map(([key, label, share]) => (
        <div key={key} className="rounded-md border px-2 py-1.5">
          <div className="text-[11px] leading-tight text-muted-foreground">{label}</div>
          <div data-share={key} className="text-base font-semibold tabular-nums">
            {percent(share)}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Columns 2 and 3 for a project's usage log: the charts strip and top queries, and one query's runs. */
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
  const [days, setDays] = useState<UsageDays>(7);
  const [manual, setManual] = useState(false);
  const key = JSON.stringify([projectId, days, manual]);
  const keyRef = useRef(key);
  keyRef.current = key;
  const [loaded, setLoaded] = useState<{ key: string; metrics: UsageMetrics } | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePoll(async () => {
    const asked = key;
    try {
      const metrics = await fetchUsage(projectId, days, manual);
      if (keyRef.current !== asked) return;
      setLoaded({ key: asked, metrics });
      setError(null);
    } catch (err) {
      if (keyRef.current === asked) setError(err instanceof Error ? err.message : String(err));
    }
  }, [key]);

  const metrics = loaded?.key === key ? loaded.metrics : null;
  const queries = metrics?.topQueries ?? null;
  useSelection(queries === null ? null : queries.map((q) => q.query), item, setItem);
  const empty =
    metrics !== null && metrics.perDay.every((d) => Object.values(d.counts).every((n) => n === 0));
  const chosen = queries?.find((q) => q.query === item);

  return (
    <>
      <section aria-label="List" className="flex min-h-0 flex-col border-r">
        <div className="grid gap-2.5 border-b px-3 py-2.5">
          <h2 className="text-sm font-semibold">Usage</h2>
          <div className="flex items-center gap-1.5">
            {USAGE_DAYS.map((d) => (
              <Button
                key={d}
                variant="outline"
                size="xs"
                aria-label={`${d} days`}
                aria-pressed={days === d}
                onClick={() => setDays(d)}
                className={cn(days === d && "bg-accent text-accent-foreground")}
              >
                {d}d
              </Button>
            ))}
            <span className="flex-1" />
            <Button
              variant="outline"
              size="xs"
              aria-pressed={manual}
              onClick={() => setManual((m) => !m)}
              className={cn(manual && "bg-accent text-accent-foreground")}
            >
              Include manual
            </Button>
          </div>
          {metrics !== null && (
            <>
              {!empty && <DayGrid perDay={metrics.perDay} />}
              <Shares metrics={metrics} />
            </>
          )}
        </div>
        <div data-list className="min-h-0 flex-1 overflow-auto">
          {error !== null ? (
            <p className="px-4 py-8 text-center text-destructive">{error}</p>
          ) : empty ? (
            <p className="px-4 py-8 text-center text-muted-foreground">No usage recorded yet.</p>
          ) : queries !== null && queries.length === 0 ? (
            <p className="px-4 py-8 text-center text-muted-foreground">No searches yet.</p>
          ) : (
            <>
              {queries !== null && <div className={cn(LABEL, "px-3 pt-2.5 pb-1")}>Top queries</div>}
              {queries?.map((q) => (
                <Row key={q.query} selected={q.query === item} onClick={() => setItem(q.query)}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{q.query}</span>
                    <span data-count className="tabular-nums">
                      {q.count}
                    </span>
                  </span>
                  <span className="flex gap-2 text-xs text-muted-foreground">
                    <span>{q.meanResults.toFixed(1)} results on average</span>
                    <span className="tabular-nums">{formatTime(q.lastMs)}</span>
                  </span>
                </Row>
              ))}
            </>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <span>{metrics !== null && `${metrics.searches} searches`}</span>
          <span>
            <kbd className="font-mono">j</kbd> <kbd className="font-mono">k</kbd>
          </span>
        </div>
      </section>
      <section aria-label="Detail" className="min-h-0 overflow-auto">
        {chosen !== undefined && (
          <div className="grid max-w-3xl gap-5 px-6 pt-5 pb-10">
            <div className="grid gap-1.5">
              <div className="flex flex-wrap gap-x-3.5 text-xs text-muted-foreground">
                <span>{chosen.count} runs</span>
                <span>{chosen.meanResults.toFixed(1)} results on average</span>
                <span>last {formatTime(chosen.lastMs)}</span>
              </div>
              <h1 className="font-mono text-lg leading-snug font-semibold">{chosen.query}</h1>
            </div>
            <div className="grid gap-1.5">
              <div className={LABEL}>Recent runs</div>
              <ul className="grid rounded-lg border bg-card text-card-foreground">
                {chosen.runs.map((run, i) => (
                  <li
                    key={`${run.ts}:${i}`}
                    data-run
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
          </div>
        )}
      </section>
    </>
  );
}

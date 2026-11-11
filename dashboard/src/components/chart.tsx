import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type Series = { key: string; label: string; color: string; values: number[] };

const AXIS_W = 40;
const PLOT_H = 168;
const PAD_TOP = 8;
const AXIS_H = 22;
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

/** The width of `ref`'s element, kept current as it resizes. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A clean axis top at or above `max`, and its ticks: 1, 2 or 5 times a power of ten per step, whole when `integer`. */
function niceTicks(max: number, integer: boolean, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const step = integer ? Math.max(1, Math.round(nice)) : nice;
  const ticks: number[] = [];
  for (let v = 0; v < max + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

/** `2026-11-04` as "Nov 4" in the reader's locale. */
function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A column path from the baseline up `h` px, its top corners rounded when `top`. */
function columnPath(x: number, y: number, w: number, h: number, top: boolean): string {
  const r = top ? Math.min(RADIUS, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ""}H${x + w - r}${
    r ? `Q${x + w},${y} ${x + w},${y + r}` : ""
  }V${y + h}Z`;
}

function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px]" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Stacked columns, one per day, on one count axis. Hover or arrow keys pick a day
 * and its tooltip lists every series; "Table" swaps the plot for the same numbers.
 */
export function DayColumns({
  title,
  note,
  dates,
  series,
  format = (n) => n.toLocaleString(),
  tickFormat,
  empty,
}: {
  title: string;
  note?: ReactNode;
  dates: string[];
  series: Series[];
  format?: (n: number) => string;
  /** Axis labels, given each tick and the step between ticks; counts get whole ticks when this is unset. */
  tickFormat?: (n: number, step: number) => string;
  empty: string;
}) {
  const [table, setTable] = useState(false);
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="grid gap-0.5">
          <h3 className="text-sm font-semibold">{title}</h3>
          {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
        </div>
        <div className="flex items-center gap-3">
          {series.length > 1 && <Legend series={series} />}
          <button
            type="button"
            aria-pressed={table}
            onClick={() => setTable((t) => !t)}
            className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            Table
          </button>
        </div>
      </header>
      {table ? (
        <DayTable dates={dates} series={series} format={format} />
      ) : (
        <Plot
          title={title}
          dates={dates}
          series={series}
          format={format}
          tickFormat={tickFormat}
          empty={empty}
        />
      )}
    </section>
  );
}

function DayTable({
  dates,
  series,
  format,
}: {
  dates: string[];
  series: Series[];
  format: (n: number) => string;
}) {
  return (
    <div className="overflow-auto" style={{ maxHeight: PLOT_H + AXIS_H }}>
      <table className="w-full text-xs tabular-nums">
        <thead className="sticky top-0 bg-card text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 text-left font-medium">Day</th>
            {series.map((s) => (
              <th key={s.key} className="py-1 pl-3 text-right font-medium">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates
            .map((date, i) => ({ date, i }))
            .reverse()
            .map(({ date, i }) => (
              <tr key={date} className="border-t">
                <td className="py-1 pr-3">{shortDate(date)}</td>
                {series.map((s) => (
                  <td key={s.key} className="py-1 pl-3 text-right">
                    {format(s.values[i] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function Plot({
  title,
  dates,
  series,
  format,
  tickFormat,
  empty,
}: {
  title: string;
  dates: string[];
  series: Series[];
  format: (n: number) => string;
  tickFormat: ((n: number, step: number) => string) | undefined;
  empty: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const n = dates.length;
  const totals = dates.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const max = Math.max(0, ...totals);
  const ticks = niceTicks(max, tickFormat === undefined);
  const top = ticks[ticks.length - 1]!;
  const tickStep = ticks[1]! - ticks[0]!;
  const plotW = Math.max(0, width - AXIS_W);
  const plotH = PLOT_H - PAD_TOP;
  const band = n === 0 ? 0 : plotW / n;
  const barW = Math.max(2, Math.min(MAX_BAR, band - GAP * 2));
  const y = (v: number) => PAD_TOP + plotH - (v / top) * plotH;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 64))));

  useEffect(() => setActive(null), [n]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setActive((a) =>
      a === null ? n - 1 : Math.max(0, Math.min(n - 1, a + (e.key === "ArrowLeft" ? -1 : 1))),
    );
  };

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={width}
          height={PLOT_H + AXIS_H}
          role="img"
          aria-label={`${title}: ${format(totals.reduce((a, b) => a + b, 0))} over ${n} days. Use the Table button for each day's values.`}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
          className="block overflow-visible rounded-sm"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={AXIS_W}
                x2={width}
                y1={y(t)}
                y2={y(t)}
                stroke={t === 0 ? "var(--axis)" : "var(--grid)"}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={AXIS_W - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {tickFormat ? tickFormat(t, tickStep) : format(t)}
              </text>
            </g>
          ))}
          {dates.map((date, i) => {
            const x0 = AXIS_W + i * band;
            const cx = x0 + band / 2;
            let base = 0;
            const drawn = series.filter((s) => (s.values[i] ?? 0) > 0);
            return (
              <g key={date}>
                {i === active && (
                  <rect x={x0} y={PAD_TOP} width={band} height={plotH} fill="var(--accent)" />
                )}
                {drawn.map((s, k) => {
                  const v = s.values[i]!;
                  const y1 = y(base + v);
                  const h = Math.max(1, y(base) - y1 - (base > 0 ? GAP : 0));
                  base += v;
                  return (
                    <path
                      key={s.key}
                      d={columnPath(cx - barW / 2, y1, barW, h, k === drawn.length - 1)}
                      fill={s.color}
                    />
                  );
                })}
                {(i % labelEvery === 0 || i === n - 1) &&
                  (i === n - 1 || n - 1 - i >= labelEvery) && (
                    <text
                      x={cx}
                      y={PLOT_H + 15}
                      textAnchor="middle"
                      className="fill-muted-foreground text-[11px]"
                    >
                      {i === n - 1 ? "Today" : shortDate(date)}
                    </text>
                  )}
                <rect
                  x={x0}
                  y={0}
                  width={band}
                  height={PLOT_H}
                  fill="transparent"
                  onPointerEnter={() => setActive(i)}
                />
              </g>
            );
          })}
        </svg>
      )}
      {max === 0 && width > 0 && (
        <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-xs text-muted-foreground">
          {empty}
        </p>
      )}
      {active !== null && width > 0 && (
        <Tooltip
          left={Math.min(Math.max(AXIS_W + (active + 0.5) * band, 80), width - 80)}
          date={dates[active]!}
          rows={series.map((s) => ({ ...s, value: s.values[active] ?? 0 }))}
          total={series.length > 1 ? totals[active]! : null}
          format={format}
        />
      )}
    </div>
  );
}

function Tooltip({
  left,
  date,
  rows,
  total,
  format,
}: {
  left: number;
  date: string;
  rows: (Series & { value: number })[];
  total: number | null;
  format: (n: number) => string;
}) {
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-0 z-10 grid min-w-36 -translate-x-1/2 gap-1 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-[0_4px_12px_rgb(0_0_0/0.08)]"
      style={{ left }}
    >
      <div className="font-medium">{shortDate(date)}</div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2">
          <span className="h-0.5 w-3 rounded-full" style={{ background: r.color }} />
          <span className="flex-1 text-muted-foreground">{r.label}</span>
          <span className="font-semibold tabular-nums">{format(r.value)}</span>
        </div>
      ))}
      {total !== null && (
        <div className="flex justify-between border-t pt-1 text-muted-foreground">
          <span>Total</span>
          <span className="font-semibold text-foreground tabular-nums">{format(total)}</span>
        </div>
      )}
    </div>
  );
}

/** A small trend line for a table cell, on its own axis from zero; flat and muted when every value is zero. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const width = 96;
  const height = 24;
  const max = Math.max(0, ...values);
  const step = values.length > 1 ? (width - 6) / (values.length - 1) : 0;
  const point = (v: number, i: number) =>
    [3 + i * step, max === 0 ? height - 3 : height - 3 - (v / max) * (height - 6)] as const;
  const points = values.map(point);
  const last = points[points.length - 1];
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="block">
      <polyline
        points={points.map(([x, y]) => `${x},${y}`).join(" ")}
        fill="none"
        stroke={max === 0 ? "var(--axis)" : "var(--series-1)"}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {last !== undefined && max > 0 && (
        <circle
          cx={last[0]}
          cy={last[1]}
          r={2.5}
          fill="var(--series-1)"
          stroke="var(--card)"
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}

/** Share bars for a ranked list: one row per item, bar lengths on one scale up to `max`. */
export function BarList({
  rows,
  max = Math.max(1, ...rows.map((r) => r.value)),
}: {
  rows: { key: string; label: ReactNode; value: number; color?: string }[];
  /** The scale's top, shared when several lists sit side by side. */
  max?: number;
}) {
  return (
    <ul className="grid gap-1.5">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,9rem)_1fr_3rem] items-center gap-3">
          <span className="truncate text-xs">{r.label}</span>
          <span className="h-2 rounded-full bg-muted">
            {r.value > 0 && (
              <span
                className="block h-2 rounded-full"
                style={{
                  width: `${Math.max(2, (r.value / max) * 100)}%`,
                  background: r.color ?? "var(--series-1)",
                }}
              />
            )}
          </span>
          <span className="text-right text-xs tabular-nums">{r.value.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

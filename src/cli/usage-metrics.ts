import { localDate } from "../hooks/lib/memory.ts";
import type { UsageChannel, UsageLine } from "../hooks/lib/usage.ts";

// The Usage view's numbers, computed from a store's usage lines over a window
// of whole local days that ends today.

const CHANNELS: UsageChannel[] = [
  "session-start",
  "subagent-start",
  "file-history",
  "search",
  "timeline",
  "get",
  "outline",
  "unfold",
];
/** The longest list the metrics answer. */
const TOP = 50;
/** The runs each `topQueries` entry keeps. */
const RUNS = 10;
/** A get or timeline this long after a search, in the same session, follows it through. */
const FOLLOW_MS = 30 * 60 * 1000;
const DELETED_TITLE = "(deleted)";

export type UsageMetrics = {
  days: number;
  manual: boolean;
  perDay: { date: string; counts: Record<UsageChannel, number> }[];
  searches: number;
  zeroResultShare: number | null;
  keywordShare: number | null;
  followThrough: number | null;
  topQueries: {
    query: string;
    count: number;
    lastMs: number;
    meanResults: number;
    runs: { ts: number; ids: number[] }[];
  }[];
  surfaced: { id: number; count: number; title: string }[];
  neverSurfacedShare: number | null;
  observationCount: number;
  topFiles: { path: string; count: number }[];
  filesWithoutMemory: { path: string; count: number }[];
  sessionStarts: number;
  subagentStarts: number;
  outlines: number;
  unfolds: number;
  cappedShare: number | null;
};

type Line<C extends UsageChannel> = Extract<UsageLine, { channel: C }>;

/** `part / whole`, or null when `whole` is 0. */
function share(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function zeroCounts(): Record<UsageChannel, number> {
  return Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<UsageChannel, number>;
}

/** The `TOP` most counted keys, by count and then path, both as `{ path, count }`. */
function topPaths(counts: Map<string, number>): { path: string; count: number }[] {
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, TOP)
    .map(([path, count]) => ({ path, count }));
}

/** The ids an event showed to the agent, each once. */
function shownIds(line: UsageLine): Set<number> {
  switch (line.channel) {
    case "session-start":
    case "search":
      return new Set(line.ids);
    case "timeline":
      return new Set(line.ids ?? []);
    case "get":
      return new Set(line.found);
    case "file-history":
      return new Set(line.shown.flatMap((s) => s.ids));
    default:
      return new Set();
  }
}

/** Whether `later` opens one of `search`'s result ids in its session. */
function opens(search: Line<"search">, later: UsageLine): boolean {
  if (later.session !== search.session) return false;
  if (later.channel === "get") return later.requested.some((id) => search.ids.includes(id));
  if (later.channel === "timeline") return search.ids.includes(later.anchor);
  return false;
}

/** Whether a line after `lines[i]`, a search, opens one of its ids within FOLLOW_MS. */
function followedThrough(lines: UsageLine[], i: number): boolean {
  const search = lines[i] as Line<"search">;
  for (let j = i + 1; j < lines.length && lines[j]!.ts - search.ts <= FOLLOW_MS; j++) {
    if (opens(search, lines[j]!)) return true;
  }
  return false;
}

export function usageMetrics(
  events: UsageLine[],
  opts: {
    nowMs: number;
    days: 7 | 30 | 90;
    manual: boolean;
    titles: (ids: number[]) => Map<number, string>;
    observationCount: number;
  },
): UsageMetrics {
  const start = new Date(opts.nowMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (opts.days - 1));
  const lines = events
    .filter((e) => e.ts >= start.getTime() && (opts.manual || e.agent !== "manual"))
    .sort((a, b) => a.ts - b.ts);
  const of = <C extends UsageChannel>(channel: C) =>
    lines.filter((l): l is Line<C> => l.channel === channel);

  const perDay: UsageMetrics["perDay"] = [];
  const byDate = new Map<string, Record<UsageChannel, number>>();
  for (let i = 0; i < opts.days; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const entry = { date: localDate(day.getTime()), counts: zeroCounts() };
    perDay.push(entry);
    byDate.set(entry.date, entry.counts);
  }
  for (const line of lines) {
    const counts = byDate.get(localDate(line.ts));
    if (counts && line.channel in counts) counts[line.channel]++;
  }

  const searches = of("search");
  let followable = 0;
  let followed = 0;
  lines.forEach((line, i) => {
    if (line.channel !== "search" || line.ids.length === 0 || line.session === null) return;
    followable++;
    if (followedThrough(lines, i)) followed++;
  });

  const groups = new Map<string, Line<"search">[]>();
  for (const s of searches) {
    const query = s.query.toLowerCase().trim().replace(/\s+/g, " ");
    const runs = groups.get(query);
    if (runs) runs.push(s);
    else groups.set(query, [s]);
  }
  const topQueries = [...groups]
    .map(([query, runs]) => ({
      query,
      count: runs.length,
      lastMs: runs[runs.length - 1]!.ts,
      meanResults: runs.reduce((n, r) => n + r.ids.length, 0) / runs.length,
      runs: runs
        .slice(-RUNS)
        .reverse()
        .map((r) => ({ ts: r.ts, ids: r.ids })),
    }))
    .sort((a, b) => b.count - a.count || b.lastMs - a.lastMs)
    .slice(0, TOP);

  const shown = new Map<number, number>();
  for (const line of lines) {
    for (const id of shownIds(line)) shown.set(id, (shown.get(id) ?? 0) + 1);
  }
  const titles = shown.size === 0 ? new Map<number, string>() : opts.titles([...shown.keys()]);
  const surfaced = [...shown]
    .sort(([a, x], [b, y]) => y - x || b - a)
    .slice(0, TOP)
    .map(([id, count]) => ({ id, count, title: titles.get(id) ?? DELETED_TITLE }));

  const shownFiles = new Map<string, number>();
  const emptyFiles = new Map<string, number>();
  for (const line of of("file-history")) {
    for (const s of line.shown) shownFiles.set(s.path, (shownFiles.get(s.path) ?? 0) + 1);
    for (const p of line.empty) emptyFiles.set(p, (emptyFiles.get(p) ?? 0) + 1);
  }

  const outlines = of("outline");
  const unfolds = of("unfold");
  const code = [...outlines, ...unfolds];
  return {
    days: opts.days,
    manual: opts.manual,
    perDay,
    searches: searches.length,
    zeroResultShare: share(searches.filter((s) => s.ids.length === 0).length, searches.length),
    keywordShare: share(searches.filter((s) => s.mode === "keyword").length, searches.length),
    followThrough: share(followed, followable),
    topQueries,
    surfaced,
    neverSurfacedShare: share(opts.observationCount - titles.size, opts.observationCount),
    observationCount: opts.observationCount,
    topFiles: topPaths(shownFiles),
    filesWithoutMemory: topPaths(emptyFiles),
    sessionStarts: of("session-start").length,
    subagentStarts: of("subagent-start").length,
    outlines: outlines.length,
    unfolds: unfolds.length,
    cappedShare: share(code.filter((c) => c.capped).length, code.length),
  };
}

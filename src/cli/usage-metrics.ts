import { localDate } from "../hooks/lib/memory.ts";
import type { UsageLine } from "../hooks/lib/usage.ts";
import { USAGE_CHANNELS, type UsageChannel, type UsageMetrics } from "../hooks/lib/wire.ts";

// The Usage view's numbers, computed from a store's usage lines over a window
// of whole local days that ends today.

/** The longest list the metrics answer. */
const TOP = 50;
/** The runs each `topQueries` entry keeps. */
const RUNS = 10;
/** A get or timeline this long after a search, in the same session, follows it through. */
const FOLLOW_MS = 30 * 60 * 1000;
const DELETED_TITLE = "(deleted)";

type Line<C extends UsageChannel> = Extract<UsageLine, { channel: C }>;

/** `part / whole`, or null when `whole` is 0. */
function share(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function zeroCounts(): Record<UsageChannel, number> {
  return Object.fromEntries(USAGE_CHANNELS.map((c) => [c, 0])) as Record<UsageChannel, number>;
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

type MetricsOptions = {
  nowMs: number;
  days: 7 | 30 | 90;
  manual: boolean;
  titles: (ids: number[]) => Map<number, string>;
  observationCount: number;
};

/** The lines of one channel, in order. */
function ofChannel<C extends UsageChannel>(lines: UsageLine[], channel: C): Line<C>[] {
  return lines.filter((l): l is Line<C> => l.channel === channel);
}

/** The window's first local midnight, and its lines in time order. */
function windowLines(
  events: UsageLine[],
  opts: MetricsOptions,
): { start: Date; lines: UsageLine[] } {
  const start = new Date(opts.nowMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (opts.days - 1));
  const lines = events
    .filter((e) => e.ts >= start.getTime() && (opts.manual || e.agent !== "manual"))
    .sort((a, b) => a.ts - b.ts);
  return { start, lines };
}

/** One entry per local day of the window, counting its lines by channel. */
function perDayGrid(lines: UsageLine[], start: Date, days: number): UsageMetrics["perDay"] {
  const perDay: UsageMetrics["perDay"] = [];
  const byDate = new Map<string, Record<UsageChannel, number>>();
  for (let i = 0; i < days; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const entry = { date: localDate(day.getTime()), counts: zeroCounts() };
    perDay.push(entry);
    byDate.set(entry.date, entry.counts);
  }
  for (const line of lines) {
    const counts = byDate.get(localDate(line.ts));
    if (counts) counts[line.channel]++;
  }
  return perDay;
}

/** The share of sessioned searches with results that a later line opens. */
function followThrough(lines: UsageLine[]): number | null {
  let followable = 0;
  let followed = 0;
  lines.forEach((line, i) => {
    if (line.channel !== "search" || line.ids.length === 0 || line.session === null) return;
    followable++;
    if (followedThrough(lines, i)) followed++;
  });
  return share(followed, followable);
}

/** Searches grouped by normalized query, most run first. */
function topQueries(searches: Line<"search">[]): UsageMetrics["topQueries"] {
  const groups = new Map<string, Line<"search">[]>();
  for (const s of searches) {
    const query = s.query.toLowerCase().trim().replace(/\s+/g, " ");
    const runs = groups.get(query);
    if (runs) runs.push(s);
    else groups.set(query, [s]);
  }
  return [...groups]
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
}

/** The most shown ids with their titles, and the titles map `titlesOf` returned. */
function surfacedCounts(
  lines: UsageLine[],
  titlesOf: MetricsOptions["titles"],
): { surfaced: UsageMetrics["surfaced"]; titles: Map<number, string> } {
  const shown = new Map<number, number>();
  for (const line of lines) {
    for (const id of shownIds(line)) shown.set(id, (shown.get(id) ?? 0) + 1);
  }
  const titles = shown.size === 0 ? new Map<number, string>() : titlesOf([...shown.keys()]);
  const surfaced = [...shown]
    .sort(([a, x], [b, y]) => y - x || b - a)
    .slice(0, TOP)
    .map(([id, count]) => ({ id, count, title: titles.get(id) ?? DELETED_TITLE }));
  return { surfaced, titles };
}

/** The paths file history found no memory for, most often first. */
function filesWithoutMemory(lines: UsageLine[]): UsageMetrics["filesWithoutMemory"] {
  const emptyFiles = new Map<string, number>();
  for (const line of ofChannel(lines, "file-history")) {
    for (const p of line.empty) emptyFiles.set(p, (emptyFiles.get(p) ?? 0) + 1);
  }
  return topPaths(emptyFiles);
}

export function usageMetrics(events: UsageLine[], opts: MetricsOptions): UsageMetrics {
  const { start, lines } = windowLines(events, opts);
  const perDay = perDayGrid(lines, start, opts.days);
  const searches = ofChannel(lines, "search");
  const followed = followThrough(lines);
  const queries = topQueries(searches);
  const { surfaced, titles } = surfacedCounts(lines, opts.titles);
  const emptyFiles = filesWithoutMemory(lines);

  return {
    perDay,
    searches: searches.length,
    zeroResultShare: share(searches.filter((s) => s.ids.length === 0).length, searches.length),
    keywordShare: share(searches.filter((s) => s.mode === "keyword").length, searches.length),
    followThrough: followed,
    topQueries: queries,
    surfaced,
    neverSurfacedShare: share(opts.observationCount - titles.size, opts.observationCount),
    filesWithoutMemory: emptyFiles,
  };
}

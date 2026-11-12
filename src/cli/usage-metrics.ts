import { localDate, type ActivityEvents } from "../hooks/lib/memory.ts";
import type { UsageLine } from "../hooks/lib/usage.ts";
import {
  USAGE_CHANNELS,
  type ActivityDay,
  type UsageChannel,
  type UsageMetrics,
} from "../hooks/lib/wire.ts";

// The Usage view's numbers from a store's usage lines, and the store's daily
// upkeep from its own rows, each over a window of whole local days that ends today.

/** The longest list the metrics answer. */
const TOP = 50;
/** The runs each `topQueries` entry keeps. */
const RUNS = 10;
/** A get or timeline this long after a search, in the same session, follows it through. */
const FOLLOW_MS = 30 * 60 * 1000;
const DELETED_TITLE = "(deleted)";

type Line<C extends UsageChannel> = Extract<UsageLine, { channel: C }>;

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

/** The ids a get or timeline line opened: a get's requested ids, a timeline's anchor. */
function openedIds(line: UsageLine): number[] {
  if (line.channel === "get") return line.requested;
  if (line.channel === "timeline") return [line.anchor];
  return [];
}

/** Whether `later` opens one of `search`'s result ids in its session. */
function opens(search: Line<"search">, later: UsageLine): boolean {
  return later.session === search.session && openedIds(later).some((id) => search.ids.includes(id));
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

function ofChannel<C extends UsageChannel>(lines: UsageLine[], channel: C): Line<C>[] {
  return lines.filter((l): l is Line<C> => l.channel === channel);
}

/** The local midnight that starts a window of `days` whole local days ending today. */
export function windowStart(nowMs: number, days: number): Date {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start;
}

/** The window's local dates, oldest first. */
function windowDates(start: Date, days: number): string[] {
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return localDate(day.getTime());
  });
}

/** The window's first local midnight, and its lines in time order. */
function windowLines(
  events: UsageLine[],
  opts: MetricsOptions,
): { start: Date; lines: UsageLine[] } {
  const start = windowStart(opts.nowMs, opts.days);
  const lines = events
    .filter((e) => e.ts >= start.getTime() && (opts.manual || e.agent !== "manual"))
    .sort((a, b) => a.ts - b.ts);
  return { start, lines };
}

/** One entry per local day of the window, counting its lines by channel. */
function perDayGrid(lines: UsageLine[], start: Date, days: number): UsageMetrics["perDay"] {
  const perDay: UsageMetrics["perDay"] = [];
  const byDate = new Map<string, Record<UsageChannel, number>>();
  for (const date of windowDates(start, days)) {
    const entry = { date, counts: zeroCounts() };
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

/** The share of Claude sessions with a session start that ran a search, timeline or get. */
function recallReach(lines: UsageLine[]): number | null {
  const started = new Set<string>();
  for (const l of ofChannel(lines, "session-start")) {
    if (l.agent === "claude" && l.session !== null) started.add(l.session);
  }
  const recalled = new Set<string>();
  for (const l of lines) {
    const recall = l.channel === "search" || l.channel === "timeline" || l.channel === "get";
    if (recall && l.agent === "claude" && l.session !== null && started.has(l.session)) {
      recalled.add(l.session);
    }
  }
  return share(recalled.size, started.size);
}

function addId(map: Map<string, Set<number>>, session: string, id: number): void {
  const ids = map.get(session);
  if (ids) ids.add(id);
  else map.set(session, new Set([id]));
}

function pairCount(map: Map<string, Set<number>>): number {
  return [...map.values()].reduce((n, ids) => n + ids.size, 0);
}

/** The ids a line surfaced to the agent: start injection and file history, never search. */
function surfacedIds(l: UsageLine): number[] {
  if (l.channel === "session-start") return l.ids;
  if (l.channel === "file-history") return l.shown.flatMap((s) => s.ids);
  return [];
}

/** The share of distinct (session, id) pairs surfaced to a Claude session that a later get or timeline in it opened. */
function surfacedFollowThrough(lines: UsageLine[]): number | null {
  const surfaced = new Map<string, Set<number>>();
  const opened = new Map<string, Set<number>>();
  for (const l of lines) {
    if (l.agent !== "claude" || l.session === null) continue;
    for (const id of openedIds(l)) {
      if (surfaced.get(l.session)?.has(id)) addId(opened, l.session, id);
    }
    for (const id of surfacedIds(l)) addId(surfaced, l.session, id);
  }
  return share(pairCount(opened), pairCount(surfaced));
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
    recallReach: recallReach(lines),
    surfacedFollowThrough: surfacedFollowThrough(lines),
    topQueries: queries,
    surfaced,
    neverSurfacedShare: share(opts.observationCount - titles.size, opts.observationCount),
    filesWithoutMemory: emptyFiles,
  };
}

/** One `ActivityDay` per local day of the window starting at `start`, from the store's upkeep events. */
export function activityDays(events: ActivityEvents, start: Date, days: number): ActivityDay[] {
  const grid = windowDates(start, days).map((date): ActivityDay => ({
    date,
    digests: 0,
    observations: 0,
    costUsd: 0,
    consolidations: 0,
    accepted: 0,
    rejected: 0,
    staleFlags: 0,
  }));
  const byDate = new Map(grid.map((day) => [day.date, day]));
  const count = (ms: number, key: Exclude<keyof ActivityDay, "date">, costUsd = 0) => {
    const day = byDate.get(localDate(ms));
    if (day === undefined) return;
    day[key]++;
    day.costUsd += costUsd;
  };
  for (const d of events.digests) count(d.atMs, "digests", d.costUsd);
  for (const c of events.consolidations) count(c.atMs, "consolidations", c.costUsd);
  for (const ms of events.observations) count(ms, "observations");
  for (const ms of events.staleFlags) count(ms, "staleFlags");
  for (const d of events.decisions) count(d.atMs, d.state);
  return grid;
}

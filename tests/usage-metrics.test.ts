import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cleanup, childEnv, inZone, ZONES } from "./helpers.ts";
import type { UsageLine } from "../src/hooks/lib/usage.ts";
import { usageMetrics } from "../src/cli/usage-metrics.ts";
import {
  CHANNELS,
  channelCounts,
  D,
  searchLine,
  TITLES,
  totals,
  windowLines,
  X,
} from "./fixtures/usage-lines.ts";

afterEach(cleanup);

const NOW = Date.UTC(2026, 10, 10, 12);
const IDS = [1, 2, 3, 4];

/** `usageMetrics` at NOW over `events`, with IDS titled as TITLES and every other id absent. */
function metricsOf(events: object[], days: 7 | 30 | 90, manual = false) {
  return usageMetrics(events as UsageLine[], {
    nowMs: NOW,
    days,
    manual,
    titles: (ids) =>
      new Map(ids.filter((id) => IDS.includes(id)).map((id) => [id, TITLES[IDS.indexOf(id)]!])),
    observationCount: IDS.length,
  });
}

describe("usageMetrics (in-process)", () => {
  for (const zone of ZONES) {
    test(`days 7, 30 and 90, agent runs only and with manual runs, in ${zone}`, () => {
      inZone(zone, () => {
        const [A, B, C] = IDS as [number, number, number];
        const { L1, L2, L3, L4, L5, L6, L7, L8 } = windowLines(NOW, IDS);
        const events = [L1, L2, L3, L4, L5, L6, L7, L8];
        const title = (id: number) => TITLES[IDS.indexOf(id)]!;
        const local = new Intl.DateTimeFormat("en-CA", { timeZone: zone });

        const week = metricsOf(events, 7);
        expect(week.perDay).toHaveLength(7);
        const dates = week.perDay.map((d) => d.date);
        expect(dates.at(-1)).toBe(local.format(NOW));
        expect([...new Set(dates)].sort()).toEqual(dates);
        for (const day of week.perDay) expect(Object.keys(day.counts).sort()).toEqual(CHANNELS);
        const on = (ts: number) => week.perDay.find((d) => d.date === local.format(ts))!;
        expect(on(L1.ts).counts.search).toBe(1);
        expect(on(L2.ts).counts.get).toBe(1);
        expect(totals(week)).toEqual(channelCounts({ search: 1, get: 1 }));
        expect(week).toMatchObject({
          searches: 1,
          zeroResultShare: 0,
          keywordShare: 0,
          followThrough: 1,
          topQueries: [
            {
              query: "foo bar",
              count: 1,
              lastMs: L1.ts,
              meanResults: 2,
              runs: [{ ts: L1.ts, ids: [A, B] }],
            },
          ],
          neverSurfacedShare: 0.5,
        });
        expect(week.surfaced).toEqual([
          { id: B, count: 2, title: title(B) },
          { id: A, count: 1, title: title(A) },
        ]);

        const manual = metricsOf(events, 7, true);
        expect(manual).toMatchObject({ searches: 2, keywordShare: 0.5, followThrough: 1 });
        expect(manual.topQueries).toEqual([
          {
            query: "manual q",
            count: 1,
            lastMs: L3.ts,
            meanResults: 1,
            runs: [{ ts: L3.ts, ids: [A] }],
          },
          week.topQueries[0]!,
        ]);
        expect(manual.surfaced).toEqual([
          { id: B, count: 2, title: title(B) },
          { id: A, count: 2, title: title(A) },
        ]);

        const month = metricsOf(events, 30);
        expect(month.perDay).toHaveLength(30);
        expect(month).toMatchObject({
          searches: 2,
          zeroResultShare: 0.5,
          keywordShare: 0.5,
          followThrough: 1,
          neverSurfacedShare: 0.25,
        });
        expect(month.topQueries).toEqual([
          {
            query: "foo bar",
            count: 2,
            lastMs: L1.ts,
            meanResults: 1,
            runs: [
              { ts: L1.ts, ids: [A, B] },
              { ts: L4.ts, ids: [] },
            ],
          },
        ]);
        expect(month.surfaced).toEqual([
          { id: B, count: 2, title: title(B) },
          { id: A, count: 2, title: title(A) },
          { id: X, count: 1, title: "(deleted)" },
          { id: C, count: 1, title: title(C) },
        ]);

        const quarter = metricsOf(events, 90);
        expect(quarter.perDay).toHaveLength(90);
        expect(quarter.searches).toBe(3);
        expect(quarter.zeroResultShare).toBeCloseTo(1 / 3);
        expect(quarter.keywordShare).toBeCloseTo(2 / 3);
        expect(quarter.followThrough).toBe(0.5);
        expect(quarter.topQueries.map((q) => [q.query, q.count])).toEqual([
          ["foo bar", 2],
          ["baz", 1],
        ]);
        expect(quarter.surfaced.map((s) => [s.id, s.count])).toEqual([
          [A, 3],
          [C, 2],
          [B, 2],
          [X, 1],
        ]);
        expect(quarter.neverSurfacedShare).toBe(0.25);
        expect(totals(quarter)).toEqual(
          channelCounts({ search: 3, get: 1, "session-start": 1, "file-history": 1 }),
        );
      });
    });
  }

  test("follow-through needs the same session within 30 minutes, and a query keeps its last 10 runs", () => {
    const T = NOW - D;
    const actor = (session: string) => ({ v: 1, agent: "claude", session });
    const body = metricsOf(
      [
        searchLine(T, "claude", "s1", "one", [1]),
        { ...actor("s2"), ts: T + 60_000, channel: "get", requested: [1], found: [1] },
        searchLine(T + 7_200_000, "claude", "s1", "two", [2]),
        { ...actor("s1"), ts: T + 9_060_000, channel: "get", requested: [2], found: [2] },
        searchLine(T + 14_400_000, "claude", "s1", "three", [3]),
        { ...actor("s1"), ts: T + 16_140_000, channel: "timeline", anchor: 3, depth: 5, ids: [3] },
        ...Array.from({ length: 11 }, (_, i) =>
          searchLine(T + 18_000_000 + i, "claude", null, "again", []),
        ),
      ],
      7,
    );
    expect(body.followThrough).toBeCloseTo(1 / 3);
    const again = body.topQueries.find((q) => q.query === "again")!;
    expect(again.count).toBe(11);
    expect(again.runs.map((r) => r.ts)).toEqual(
      Array.from({ length: 10 }, (_, i) => T + 18_000_010 - i),
    );
  });

  test("recall reach counts Claude sessions with a session start that ran search, timeline or get", () => {
    const T = NOW - D;
    const at = (i: number) => T + i * 1_000;
    const start = (i: number, agent: string, session: string | null, source = "startup") => ({
      v: 1,
      agent,
      session,
      ts: at(i),
      channel: "session-start",
      source,
      ids: [],
    });
    const lines = [
      start(0, "claude", "S1"),
      searchLine(at(1), "claude", "S1", "q", []),
      start(2, "claude", "S2"),
      start(3, "claude", "S3"),
      {
        v: 1,
        agent: "claude",
        session: "S3",
        ts: at(4),
        channel: "get",
        requested: [1],
        found: [1],
      },
      start(5, "claude", "S5", "compact"),
      start(6, "claude", "S5", "resume"),
      {
        v: 1,
        agent: "claude",
        session: "S5",
        ts: at(7),
        channel: "timeline",
        anchor: 1,
        depth: 5,
        ids: [1],
      },
      start(8, "codex", "C"),
      {
        v: 1,
        agent: "manual",
        session: null,
        ts: at(9),
        channel: "get",
        requested: [1],
        found: [1],
      },
      searchLine(at(10), "claude", "S4", "q", []),
      start(11, "claude", null),
    ];
    expect(metricsOf(lines, 7).recallReach).toBe(0.75);
    expect(metricsOf(lines, 7, true).recallReach).toBe(0.75);
  });

  test("surfaced follow-through counts distinct session ids opened after they surfaced", () => {
    const T = NOW - D;
    const line = (ts: number, session: string | null, rest: object, agent = "claude") => ({
      v: 1,
      agent,
      session,
      ts,
      ...rest,
    });
    const get = (ids: number[]) => ({ channel: "get", requested: ids, found: ids });
    const history = (ids: number[]) => ({
      channel: "file-history",
      tool: "Read",
      shown: [{ path: "a.ts", ids }],
      empty: [],
      seen: [],
      cut: [],
      bytes: 1,
    });
    const lines = [
      line(T, "S1", get([4])),
      line(T + 60_000, "S1", { channel: "session-start", source: "startup", ids: [1, 2, 4] }),
      line(T + 120_000, "S1", history([2, 3])),
      line(T + 180_000, "S1", history([2, 3])),
      searchLine(T + 240_000, "claude", "S1", "q", [2, 7]),
      line(T + 300_000, "S2", get([1])),
      line(T + 310_000, "C", { channel: "session-start", source: "startup", ids: [5] }, "codex"),
      line(T + 320_000, null, history([6])),
      line(T + 11_040_000, "S1", get([2])),
      line(T + 11_100_000, "S1", { channel: "timeline", anchor: 3, depth: 5, ids: [3] }),
      line(T + 11_160_000, "S1", get([7])),
    ];
    expect(metricsOf(lines, 7).surfacedFollowThrough).toBe(0.5);
    expect(metricsOf(lines, 7, true).surfacedFollowThrough).toBe(0.5);
  });

  test("graph share and symbol follow-through count graph questions against symbol lookups", () => {
    const T = NOW - D;
    let tick = 0;
    const line = (session: string | null, rest: object, agent = "claude") => ({
      v: 1,
      agent,
      session,
      ts: T + 60_000 * tick++,
      ...rest,
    });
    const graph = { path: null, matches: 1, chars: 1, capped: false, pending: 0, outcome: "ok" };
    const ask = (channel: string, symbol: string | null) => ({ channel, symbol, ...graph, ms: 1 });
    const lookup = (shown: string[], symbols = shown) => ({
      channel: "symbol-lookup",
      tool: "Bash",
      symbols,
      shown,
      bytes: 1,
    });
    const lines = [
      line("S1", ask("callers", "early")),
      line("S1", lookup(["early", "fooBar", "bazQux"], ["early", "fooBar", "bazQux", "dupName"])),
      line("S1", lookup(["fooBar"])),
      line("S1", ask("callers", "fooBar")),
      line("S1", ask("impact", "Store.bazQux")),
      line("S1", ask("impact", null)),
      line("S1", { channel: "anatomy", from: null, ...graph, ms: 1 }),
      line("S2", ask("callees", "early")),
      line("S2", lookup(["other"])),
      line(null, lookup(["noSession"])),
      line(null, ask("callers", "other"), "manual"),
    ];
    // Claude lines: 5 callers, callees and impact against 4 symbol lookups.
    expect(metricsOf(lines, 7).graphShare).toBeCloseTo(5 / 9);
    expect(metricsOf(lines, 7, true).graphShare).toBeCloseTo(5 / 9);
    // Shown pairs: S1 early, fooBar and bazQux, S2 other. S1 then asked about fooBar and bazQux.
    expect(metricsOf(lines, 7).symbolFollowThrough).toBe(0.5);
    expect(metricsOf(lines, 7, true).symbolFollowThrough).toBe(0.5);
    expect(totals(metricsOf(lines, 7))).toEqual(
      channelCounts({ callers: 2, callees: 1, impact: 2, anatomy: 1, "symbol-lookup": 4 }),
    );
  });

  test("a child started after a zone test runs in the system zone, or the zone it is given", () => {
    inZone("Asia/Tokyo", () => undefined);
    const zoneOf = (env: NodeJS.ProcessEnv) =>
      spawnSync(
        process.execPath,
        ["-e", "process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)"],
        { encoding: "utf-8", env },
      ).stdout;
    expect(zoneOf(childEnv())).toBe(zoneOf({ PATH: process.env.PATH! }));
    expect(zoneOf(childEnv({ TZ: "Asia/Tokyo" }))).toBe("Asia/Tokyo");
  });
});

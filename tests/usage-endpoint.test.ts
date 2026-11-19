import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanup, makeCrankHome, plantMemory, runCli, runHook, seedMemory } from "./helpers.ts";
import { projectId, registeredCopy, startDashboard } from "./release-fixtures.ts";
import { STORE_TEXT } from "../src/hooks/lib/wire.ts";
import {
  claudePostBash,
  claudePostRead,
  claudeSessionStart,
  claudeSubagentStart,
} from "./fixtures/payloads.ts";
import {
  channelCounts,
  claudeCli,
  HOOK,
  lineCount,
  printedIds,
  READ_HOOK,
  searchLine,
  SUBAGENT_HOOK,
  THREE,
  TITLES,
  totals,
  TRANSCRIPT,
  usageLines,
  windowLines,
} from "./fixtures/usage-lines.ts";

afterEach(cleanup);

/** Write `entries` to the project's usage file, objects as JSON lines and strings as they are. */
function writeLog(root: string, entries: Array<object | string>, file = "usage.jsonl"): void {
  const text = entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e)) + "\n").join("");
  fs.writeFileSync(path.join(root, ".crank", file), text);
}

/** A registered project on `home` with four observations and the window journey's log. */
function windowProject(home: string) {
  const root = registeredCopy(home);
  fs.writeFileSync(path.join(root, "b.ts"), "export const b = 1;\n");
  const ids = seedMemory(
    root,
    TITLES.map((title) => ({ title })),
  );
  const lines = windowLines(Date.now(), ids);
  writeLog(root, lines.log);
  return { root, ids, lines };
}

type Dashboard = Awaited<ReturnType<typeof startDashboard>>;

async function usageOf(dash: Dashboard, root: string, query: string): Promise<Record<string, any>> {
  const res = await dash.get(`/api/projects/${projectId(root)}/usage?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

describe("usage window: the usage endpoint aggregates the log", () => {
  test("a project with no usage log answers zero, a bad days or manual gets 400, and a missing manual means 0", async () => {
    const home = makeCrankHome();
    const { root } = windowProject(home);
    const empty = registeredCopy(home);
    expect(fs.existsSync(path.join(empty, ".crank/usage.jsonl"))).toBe(false);
    const dash = await startDashboard(home, ["--port", "0"]);
    const none = await usageOf(dash, empty, "days=7");
    expect(none.perDay).toHaveLength(7);
    for (const day of none.perDay) expect(day.counts).toEqual(channelCounts({}));
    expect(none).toEqual({
      perDay: none.perDay,
      searches: 0,
      zeroResultShare: null,
      keywordShare: null,
      followThrough: null,
      recallReach: null,
      surfacedFollowThrough: null,
      graphShare: null,
      symbolFollowThrough: null,
      topQueries: [],
      surfaced: [],
      neverSurfacedShare: null,
      filesWithoutMemory: [],
      note: STORE_TEXT.missing.note,
    });
    const id = projectId(root);
    for (const query of [
      "manual=0",
      "days=5",
      "days=abc",
      "days=toString",
      "days=7&manual=2",
      "days=7&manual=x",
    ]) {
      expect([query, (await dash.get(`/api/projects/${id}/usage?${query}`)).status]).toEqual([
        query,
        400,
      ]);
    }
    expect(await usageOf(dash, root, "days=7")).toEqual(
      await usageOf(dash, root, "days=7&manual=0"),
    );
  }, 20_000);

  test("a store that does not open still answers the log's metrics, with no titles", async () => {
    const home = makeCrankHome();
    const { root } = windowProject(home);
    const newer = registeredCopy(home);
    plantMemory(newer, "newer");
    const missing = registeredCopy(home);
    for (const other of [newer, missing]) {
      fs.copyFileSync(
        path.join(root, ".crank/usage.jsonl"),
        path.join(other, ".crank/usage.jsonl"),
      );
      fs.writeFileSync(path.join(other, "b.ts"), "export const b = 1;\n");
    }
    const dash = await startDashboard(home, ["--port", "0"]);
    const good = await usageOf(dash, root, "days=90&manual=0");
    const expected = {
      ...good,
      neverSurfacedShare: null,
      surfaced: good.surfaced.map((s: object) => ({ ...s, title: "(deleted)" })),
    };
    expect(await usageOf(dash, newer, "days=90&manual=0")).toEqual({
      ...expected,
      note: STORE_TEXT.newer.note,
    });
    expect(await usageOf(dash, missing, "days=90&manual=0")).toEqual({
      ...expected,
      note: STORE_TEXT.missing.note,
    });
    expect(good).not.toHaveProperty("note");
  }, 20_000);

  test("the rotated file is read too, and a changed file is read again", async () => {
    const home = makeCrankHome();
    const { root, lines } = windowProject(home);
    const dash = await startDashboard(home, ["--port", "0"]);
    const whole = await usageOf(dash, root, "days=30&manual=0");
    expect(whole.searches).toBe(2);
    writeLog(root, [lines.L4], "usage.1.jsonl");
    writeLog(
      root,
      lines.log.filter((l) => l !== lines.L4),
    );
    expect(await usageOf(dash, root, "days=30&manual=0")).toEqual(whole);
    fs.appendFileSync(
      path.join(root, ".crank/usage.jsonl"),
      JSON.stringify(searchLine(Date.now() - 1000, "claude", "s5", "later", [])) + "\n",
    );
    expect((await usageOf(dash, root, "days=30&manual=0")).searches).toBe(3);
    const empty = async () => (await usageOf(dash, root, "days=90&manual=0")).filesWithoutMemory;
    expect(await empty()).toEqual([{ path: "b.ts", count: 1 }]);
    fs.writeFileSync(path.join(root, "gone.ts"), "export const gone = 1;\n");
    expect(await empty()).toEqual([
      { path: "b.ts", count: 1 },
      { path: "gone.ts", count: 1 },
    ]);
  }, 20_000);
});

describe("usage capture: the journey's lines reach the usage endpoint", () => {
  test("every channel counts once, and a dashboard search records no line", async () => {
    const home = makeCrankHome();
    const root = registeredCopy(home);
    fs.writeFileSync(path.join(root, "code.ts"), THREE);
    fs.writeFileSync(path.join(root, "shaped.ts"), "export function shapedName() {}\n");
    const hit = seedMemory(root, [{ title: "Epsilon finding", filesRead: ["a.ts"] }])[0]!;
    const hook = (file: string, payload: object) =>
      runHook(file, JSON.stringify(payload), root, { CRANK_HOME: home });
    expect(hook(HOOK, claudeSessionStart(root)).status).toBe(0);
    expect(hook(SUBAGENT_HOOK, claudeSubagentStart(root, "Explore")).status).toBe(0);
    expect(hook(READ_HOOK, claudePostRead(root, path.join(root, "a.ts"), TRANSCRIPT)).status).toBe(
      0,
    );
    const claude = (args: string[]) =>
      claudeCli(root, args, {
        CRANK_HOME: home,
        CLAUDE_CODE_SESSION_ID: "a46b6073-1111-2222-3333-444455556666",
      });
    expect(printedIds(claude(["search", "epsilon"]).stdout)).toEqual([hit]);
    expect(claude(["search", "zzz-none"]).stdout).toBe("");
    expect(claude(["timeline", String(hit)]).status).toBe(0);
    expect(claude(["get", String(hit)]).status).toBe(0);
    expect(claude(["outline", "code.ts"]).status).toBe(0);
    expect(claude(["unfold", "code.ts", "one"]).status).toBe(0);
    for (const args of [["anatomy"], ["callers", "one"], ["callees", "one"], ["impact", "one"]])
      expect(claude(args).status).toBe(0);
    expect(hook(READ_HOOK, claudePostBash(root, "rg -n shapedName .", TRANSCRIPT)).status).toBe(0);
    const manual = runCli(root, ["search", "epsilon"], {
      CLAUDECODE: "",
      CLAUDE_CODE_SESSION_ID: "",
      CRANK_HOME: home,
    });
    expect(printedIds(manual.stdout)).toEqual([hit]);

    const lines = usageLines(root);
    const actor = { v: 1, ts: Date.now(), agent: "claude", session: "s1" };
    const malformed = [
      { channel: "session-start" },
      { channel: "search", query: "q" },
      { channel: "search", query: 7, ids: [] },
      { channel: "timeline", anchor: hit, ids: "1" },
      { channel: "get", requested: [hit], found: null },
      { channel: "file-history", empty: [] },
      { channel: "file-history", shown: [null], empty: [] },
      { channel: "session-start", ids: [true] },
      { channel: "search", query: "q", ids: [[1]] },
      { channel: "timeline", anchor: hit, ids: ["1"] },
      { channel: "get", requested: [hit], found: [{}] },
      { channel: "file-history", shown: [{ ids: [null] }], empty: [] },
      { channel: "file-history", shown: [], empty: [{}] },
      { channel: "file-history", shown: [{ path: 7, ids: [hit] }], empty: [] },
      { channel: "search", query: "q", ids: [], session: undefined },
      { channel: "symbol-lookup", symbols: ["shapedName"] },
      { channel: "symbol-lookup", symbols: ["shapedName"], shown: [7] },
      { channel: "bogus", ids: [hit] },
    ];
    fs.appendFileSync(
      path.join(root, ".crank", "usage.jsonl"),
      malformed.map((m) => JSON.stringify({ ...actor, ...m }) + "\n").join(""),
    );
    fs.appendFileSync(path.join(root, ".crank", "usage.jsonl"), "null\n[]\n42\n");
    const dash = await startDashboard(home, ["--port", "0"]);
    const all = await usageOf(dash, root, "days=7&manual=1");
    expect(totals(all)).toEqual(
      channelCounts({
        "session-start": 1,
        "subagent-start": 1,
        "file-history": 1,
        "symbol-lookup": 1,
        search: 3,
        timeline: 1,
        get: 1,
        outline: 1,
        unfold: 1,
        anatomy: 1,
        callers: 1,
        callees: 1,
        impact: 1,
      }),
    );
    expect(all.zeroResultShare).toBeCloseTo(1 / 3);
    const lists = (l: Record<string, any>): number[][] =>
      [l.ids, l.found, ...(l.shown ?? []).map((s: { ids: number[] }) => s.ids)].filter(
        Array.isArray,
      );
    const listing = lines.filter((l) => lists(l).some((ids) => ids.includes(hit)));
    expect(all.surfaced.find((s: { id: number }) => s.id === hit).count).toBe(listing.length);
    expect(all).toMatchObject({ recallReach: 1, surfacedFollowThrough: 0.5 });

    const agents = await usageOf(dash, root, "days=7&manual=0");
    expect(agents).toMatchObject({ searches: 2, zeroResultShare: 0.5, followThrough: 1 });
    expect(agents).toMatchObject({ recallReach: 1, surfacedFollowThrough: 0.5 });

    const before = lineCount(root);
    const res = await dash.get(`/api/projects/${projectId(root)}/observations?q=epsilon`);
    expect(res.status).toBe(200);
    const found = (await res.json()) as { rows: { id: number }[] };
    expect(found.rows.map((l) => l.id)).toEqual([hit]);
    expect(lineCount(root)).toBe(before);
  }, 60_000);
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  claudePostBash,
  claudePostRead,
  claudePostWrite,
  claudeSessionStart,
} from "./fixtures/payloads.ts";
import { readUntouched } from "../src/hooks/lib/untouched.ts";
import { localDate, memoryPath } from "../src/hooks/lib/memory.ts";
import {
  makeCrankHome,
  plantMemory,
  runCli,
  runHook,
  seedMemory,
  setMtime,
  withEnv,
} from "./helpers.ts";
import { workspace } from "./workspace.ts";

const SESSION = "a46b6073-1111-2222-3333-444455556666";
const TRANSCRIPT = "/u/.claude/projects/-proj/551be959.jsonl";
const HOUR = 3_600_000;

function usageLines(root: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(path.dirname(memoryPath(root)), "usage.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function additionalContext(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

/** The `\n\n`-separated section of `ctx` that starts with `header`, or undefined. */
function sectionOf(ctx: string, header: string): string | undefined {
  return ctx.split("\n\n").find((s) => s.startsWith(header));
}

const lastLine = (root: string) => usageLines(root).at(-1);

describe("cross-repo memory", () => {
  test("journey 1: a session started in H captures across projects", () => {
    const ws = workspace();
    const hook = (name: string, payload: object) =>
      runHook(`src/hooks/${name}.ts`, JSON.stringify(payload), undefined, { CRANK_HOME: ws.home });
    const scratchSessions = () =>
      withEnv({ CRANK_HOME: ws.home }, readUntouched).find((r) => r.root === ws.scratch)?.sessions;

    expect(hook("session-start", claudeSessionStart(ws.H)).status).toBe(0);

    const storefrontFile = path.join(ws.storefront, "src/a.ts");
    expect(hook("post-write", claudePostWrite(ws.H, storefrontFile)).status).toBe(0);
    expect(fs.readFileSync(path.join(ws.storefront, ".crank/anatomy.md"), "utf-8")).toContain(
      "src/a.ts",
    );

    const scratchFile = path.join(ws.scratch, "a.ts");
    expect(hook("post-write", claudePostWrite(ws.H, scratchFile)).status).toBe(0);
    expect(scratchSessions()).toEqual([SESSION]);

    const numericId = { ...claudePostWrite(ws.H, scratchFile), session_id: 7 };
    expect(hook("post-write", numericId).status).toBe(0);
    expect(scratchSessions()).toEqual([SESSION]);

    const r = withEnv({ CRANK_HOME: ws.home }, readUntouched).find((e) => e.root === ws.scratch)!;
    const stats = runCli(ws.H, ["stats"], { CRANK_HOME: ws.home, TZ: "UTC" });
    expect(stats.stdout).toContain(
      `  not installed:    1\n    ${ws.scratch}  last seen ${localDate(r.lastSeenMs)}\n`,
    );

    const read = (file: string, stem: string, agentId?: string) =>
      hook(
        "post-read",
        claudePostRead(ws.H, file, `/u/.claude/projects/-h/${stem}.jsonl`, agentId),
      );
    const payFile = path.join(ws.payments, "src/a.ts");
    const first = read(payFile, "9c000001");
    expect(first.status).toBe(0);
    const block = additionalContext(first.stdout);
    expect(block).toStartWith(
      `Excerpt of \`${ws.payments}/.crank/cerebrum.md\`, project payments-api's memory; grep it for more.\n` +
        "Recall there: `crank-mem search --project payments-api <query>`; its ids show as `payments-api#<id>`.\n\n",
    );
    expect(block).toContain("project payments-api.");
    expect(block).not.toContain("History of");
    const marker = fs.readFileSync(path.join(ws.home, "seen/9c000001-main.seen"), "utf-8");
    expect(marker.split("\n")).toContain(`cerebrum:${ws.payments}`);
    expect(read(payFile, "9c000001").stdout).not.toContain("Excerpt of");
    expect(additionalContext(read(payFile, "9c000001", "sub1").stdout)).toStartWith(
      `Excerpt of \`${ws.payments}/.crank/cerebrum.md\``,
    );

    expect(read(path.join(ws.H, "src/h.ts"), "9c000002").stdout).not.toContain("Excerpt of");
    const untouchedFile = path.join(ws.home, "untouched.json");
    const untouchedBefore = fs.readFileSync(untouchedFile, "utf-8");
    const rootRead = read(ws.storefront, "9c000003");
    expect([rootRead.status, rootRead.stdout]).toEqual([0, ""]);
    expect(fs.readFileSync(untouchedFile, "utf-8")).toBe(untouchedBefore);

    fs.writeFileSync(path.join(ws.payments, ".env"), "SECRET=1\n");
    expect(read(path.join(ws.payments, ".env"), "9c000004").stdout).not.toContain("Excerpt of");
    const absent = read(path.join(ws.payments, "src/none.ts"), "9c000005").stdout;
    expect(absent).not.toContain("Excerpt of");

    fs.rmSync(path.join(ws.storefront, ".crank/cerebrum.md"));
    const noCerebrum = read(storefrontFile, "9c000006");
    expect(noCerebrum.status).toBe(0);
    expect(noCerebrum.stdout).not.toContain("Excerpt of");
  });

  test("journey 2: recall from the other side", () => {
    const ws = workspace();
    const read = (file: string) =>
      runHook(
        "src/hooks/post-read.ts",
        JSON.stringify(claudePostRead(ws.H, file, TRANSCRIPT)),
        ws.H,
        { CRANK_HOME: ws.home },
      );

    const storefrontFile = path.join(ws.storefront, "src/a.ts");
    const [storefrontId] = seedMemory(ws.storefront, [
      { title: "Storefront fact", filesRead: ["src/a.ts"] },
    ]);
    setMtime(storefrontFile, Date.now() - HOUR);
    const first = read(storefrontFile);
    expect(first.status).toBe(0);
    const ctx = additionalContext(first.stdout);
    expect(ctx).toStartWith("History of src/a.ts (open one: `crank-mem get <id>`):\nstorefront#");
    expect(ctx).toMatch(/^storefront#\d+ \d{4}-\d\d-\d\d discovery Storefront fact$/m);
    const actor = { agent: "claude", session: "551be959-1111-2222-3333-444455556666" };
    expect(usageLines(ws.storefront)).toEqual([
      expect.objectContaining({
        ...actor,
        channel: "file-history",
        shown: [{ path: "src/a.ts", ids: [storefrontId] }],
      }),
    ]);
    expect(usageLines(ws.H)).toEqual([
      expect.objectContaining({
        ...actor,
        channel: "file-history",
        shown: [],
        empty: [],
        seen: [],
        cut: [],
      }),
    ]);
    const marker = fs.readFileSync(path.join(ws.home, "seen/551be959-main.seen"), "utf-8");
    expect(marker.split("\n")).toContain(storefrontFile);
    expect(read(storefrontFile).stdout).toBe("");

    seedMemory(ws.payments, [{ title: "Payments fact", filesRead: ["src/a.ts"] }]);
    const worktreeRead = read(path.join(ws.worktree, "src/a.ts"));
    expect(worktreeRead.status).toBe(0);
    const worktreeCtx = additionalContext(worktreeRead.stdout);
    expect(worktreeCtx).toContain("History of src/a.ts");
    expect(worktreeCtx).toMatch(/^payments-api#\d+ .* Payments fact$/m);

    const scratchRead = read(path.join(ws.scratch, "a.ts"));
    expect([scratchRead.status, scratchRead.stdout]).toEqual([0, ""]);
    const untouched = withEnv({ CRANK_HOME: ws.home }, readUntouched);
    expect(untouched.find((r) => r.root === ws.scratch)?.sessions).toEqual([
      "551be959-1111-2222-3333-444455556666",
    ]);

    const freshHome = makeCrankHome();
    const usageFile = path.join(ws.storefront, ".crank/usage.jsonl");
    const usageBefore = fs.readFileSync(usageFile, "utf-8");
    const fromScratch = runHook(
      "src/hooks/post-read.ts",
      JSON.stringify(claudePostRead(ws.scratch, storefrontFile, TRANSCRIPT)),
      ws.scratch,
      { CRANK_HOME: freshHome },
    );
    expect([fromScratch.status, fromScratch.stdout]).toEqual([0, ""]);
    expect(fs.existsSync(path.join(freshHome, "untouched.json"))).toBe(false);
    expect(fs.readFileSync(usageFile, "utf-8")).toBe(usageBefore);

    const fromStorefront = (file: string, transcript: string) =>
      runHook(
        "src/hooks/post-read.ts",
        JSON.stringify(claudePostRead(ws.storefront, file, transcript)),
        ws.storefront,
        { CRANK_HOME: ws.home },
      );
    const payFile = path.join(ws.payments, "src/pay.ts");
    fs.writeFileSync(payFile, "export const pay = 1;\n");
    seedMemory(ws.storefront, [
      {
        title: "Cart calls pay",
        filesRead: ["src/a.ts"],
        refs: [
          { project: "payments-api", path: "src/pay.ts", kind: "read" },
          { project: "ghost", path: "src/g.ts", kind: "read" },
        ],
      },
    ]);
    const [payFactId] = seedMemory(ws.payments, [{ title: "Pay fact", filesRead: ["src/pay.ts"] }]);
    const paired = fromStorefront(storefrontFile, "/u/.claude/projects/-sf/7a0c0001.jsonl");
    expect(paired.status).toBe(0);
    const pairedCtx = additionalContext(paired.stdout);
    expect(pairedCtx).toStartWith("History of src/a.ts (open one: `crank-mem get <id>`):\n#");
    expect(pairedCtx).toMatch(
      /\n\nHistory of payments-api\/src\/pay\.ts, paired with src\/a\.ts:\npayments-api#\d+ .* Pay fact$/,
    );
    expect(pairedCtx).not.toContain("History of ghost/");
    const sfMarker = fs.readFileSync(path.join(ws.home, "seen/7a0c0001-main.seen"), "utf-8");
    expect(sfMarker.split("\n")).toContain(storefrontFile);
    expect(sfMarker.split("\n")).not.toContain(payFile);
    expect(lastLine(ws.payments)).toMatchObject({
      channel: "file-history",
      shown: [{ path: "src/pay.ts", ids: [payFactId] }],
    });
    expect(lastLine(ws.storefront)).toMatchObject({ channel: "file-history" });
    expect((lastLine(ws.storefront)!.shown as { path: string }[]).map((e) => e.path)).toEqual([
      "src/a.ts",
    ]);
    const payRead = fromStorefront(payFile, "/u/.claude/projects/-sf/7a0c0001.jsonl");
    expect(additionalContext(payRead.stdout)).toMatch(
      /^History of src\/pay\.ts \(open one: `crank-mem get <id>`\):.*\npayments-api#\d+ .* Pay fact$/m,
    );

    seedMemory(ws.payments, [
      {
        title: "Pay writes cart",
        filesRead: ["src/pay.ts"],
        refs: [{ project: "storefront", path: "src/a.ts", kind: "modified" }],
      },
    ]);
    seedMemory(ws.storefront, [{ title: "Front fact", filesRead: ["src/a.ts"] }]);
    const back = fromStorefront(payFile, "/u/.claude/projects/-sf/7a0c0002.jsonl");
    const backPair = sectionOf(
      additionalContext(back.stdout),
      "History of storefront/src/a.ts, paired with src/pay.ts:\n",
    );
    expect(backPair).toMatch(/^#\d+ .* Front fact$/m);

    const fresh = "/u/.claude/projects/-h/9d000001.jsonl";
    const paymentsFile = path.join(ws.payments, "src/a.ts");
    const both = runHook(
      "src/hooks/post-read.ts",
      JSON.stringify(claudePostBash(ws.H, `cat ${storefrontFile} ${paymentsFile}`, fresh)),
      ws.H,
      { CRANK_HOME: ws.home },
    );
    const bothCtx = additionalContext(both.stdout);
    expect(bothCtx.split(`Excerpt of \`${ws.storefront}/.crank/cerebrum.md\``)).toHaveLength(2);
    expect(bothCtx).not.toContain("payments-api's memory");
    const next = runHook(
      "src/hooks/post-read.ts",
      JSON.stringify(claudePostRead(ws.H, paymentsFile, fresh)),
      ws.H,
      { CRANK_HOME: ws.home },
    );
    expect(additionalContext(next.stdout)).toStartWith(
      `Excerpt of \`${ws.payments}/.crank/cerebrum.md\`, project payments-api's memory;`,
    );
  });

  test("pair-reached history keeps 3 files and 5 lines each", () => {
    const ws = workspace();
    const storefrontFile = path.join(ws.storefront, "src/a.ts");
    const read = (transcript: string) =>
      runHook(
        "src/hooks/post-read.ts",
        JSON.stringify(claudePostRead(ws.storefront, storefrontFile, transcript)),
        ws.storefront,
        { CRANK_HOME: ws.home },
      );
    for (const n of [1, 2, 3, 4]) {
      seedMemory(ws.storefront, [
        {
          title: `Cites p${n}`,
          narrative: `Cites p${n} file`,
          filesRead: ["src/a.ts"],
          refs: [{ project: "payments-api", path: `src/p${n}.ts`, kind: "read" }],
        },
      ]);
      Bun.sleepSync(2);
    }
    const lines = (f: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        title: `${f} fact ${i}`,
        narrative: `${f} words ${i}`,
        filesRead: [`src/${f}.ts`],
      }));
    seedMemory(ws.payments, [
      ...lines("p1", 1),
      ...lines("p2", 1),
      ...lines("p3", 1),
      ...lines("p4", 7),
    ]);
    const ctx = additionalContext(read("/u/.claude/projects/-sf/7b000001.jsonl").stdout);
    const pairHeaders = ctx
      .split("\n\n")
      .filter((s) => s.startsWith("History of payments-api/"))
      .map((s) => s.split("\n")[0]);
    expect(pairHeaders).toEqual(
      ["p4", "p3", "p2"].map((f) => `History of payments-api/src/${f}.ts, paired with src/a.ts:`),
    );
    const p4 = sectionOf(ctx, "History of payments-api/src/p4.ts")!;
    expect(p4.split("\n").slice(1)).toHaveLength(5);
    expect(
      p4
        .split("\n")
        .slice(1)
        .every((l) => /^payments-api#\d+ .* p4 fact \d$/.test(l)),
    ).toBe(true);

    const shared = { title: "Shared", narrative: "Same words" };
    const bFile = path.join(ws.storefront, "src/b.ts");
    fs.writeFileSync(bFile, "export const b = 1;\n");
    seedMemory(ws.storefront, [
      {
        ...shared,
        filesRead: ["src/b.ts"],
        refs: [
          { project: "payments-api", path: "src/q.ts", kind: "read" },
          { project: "H", path: "src/h.ts", kind: "read" },
        ],
      },
    ]);
    seedMemory(ws.H, [{ ...shared, filesRead: ["src/h.ts"] }]);
    const [, pairOnlyId] = seedMemory(ws.payments, [
      { ...shared, filesRead: ["src/q.ts"] },
      { title: "Pair only", narrative: "Only the pair", filesRead: ["src/q.ts"] },
    ]);
    const deduped = runHook(
      "src/hooks/post-read.ts",
      JSON.stringify(
        claudePostRead(ws.storefront, bFile, "/u/.claude/projects/-sf/7b000002.jsonl"),
      ),
      ws.storefront,
      { CRANK_HOME: ws.home },
    );
    const dedupedCtx = additionalContext(deduped.stdout);
    const q = sectionOf(dedupedCtx, "History of payments-api/src/q.ts, paired with src/b.ts:\n")!;
    expect(q).toMatch(/^payments-api#\d+ .* Pair only$/m);
    expect(q).not.toContain("Shared");
    expect(dedupedCtx).not.toContain("History of H/");
    expect(lastLine(ws.payments)!.shown).toEqual([{ path: "src/q.ts", ids: [pairOnlyId] }]);
    expect(fs.existsSync(path.join(ws.H, ".crank/usage.jsonl"))).toBe(false);
  });

  test("history, own and pair-reached, stays within 1,536 bytes", () => {
    const ws = workspace();
    const storefrontFile = path.join(ws.storefront, "src/a.ts");
    const long = (f: string, i: number) => `${f}${i} `.padEnd(200, "x");
    const cite = (p: string) => [{ project: "payments-api", path: p, kind: "read" as const }];
    seedMemory(ws.storefront, [
      { title: long("a", 0), filesRead: ["src/a.ts"], refs: cite("src/old.ts") },
      ...[1, 2, 3].map((i) => ({ title: long("a", i), filesRead: ["src/a.ts"] })),
    ]);
    Bun.sleepSync(2);
    seedMemory(ws.storefront, [
      { title: long("a", 4), filesRead: ["src/a.ts"], refs: cite("src/new.ts") },
    ]);
    seedMemory(ws.payments, [
      ...[0, 1, 2, 3, 4].map((i) => ({ title: long("n", i), filesRead: ["src/new.ts"] })),
      { title: "Old short", filesRead: ["src/old.ts"] },
    ]);
    setMtime(storefrontFile, Date.now() - HOUR);
    const run = runHook(
      "src/hooks/post-read.ts",
      JSON.stringify(claudePostRead(ws.storefront, storefrontFile, TRANSCRIPT)),
      ws.storefront,
      { CRANK_HOME: ws.home },
    );
    const ctx = additionalContext(run.stdout);
    expect(ctx).toStartWith("History of src/a.ts (open one: `crank-mem get <id>`):\n");
    expect(ctx).not.toContain("History of payments-api/");
    expect(Buffer.byteLength(ctx)).toBeLessThanOrEqual(1536);
    const payLines = usageLines(ws.payments).filter((l) => l.channel === "file-history");
    expect(payLines).toEqual([
      expect.objectContaining({ shown: [], cut: ["src/new.ts", "src/old.ts"] }),
    ]);
  });

  test("history plus an excerpt stays under 4,096 bytes", () => {
    const ws = workspace();
    const cerebrum = path.join(ws.payments, ".crank/cerebrum.md");
    const pad = Array.from(
      { length: 10 },
      (_, i) => `- **Pad ${i}**: ${"y".repeat(600)} (2026-11-12)\n`,
    ).join("");
    fs.appendFileSync(cerebrum, pad);
    expect(fs.statSync(cerebrum).size).toBeGreaterThan(4096);
    const payFile = path.join(ws.payments, "src/a.ts");
    seedMemory(
      ws.payments,
      Array.from({ length: 7 }, (_, i) => ({
        title: `t${i} `.padEnd(200, "x"),
        filesRead: ["src/a.ts"],
      })),
    );
    const run = runHook(
      "src/hooks/post-read.ts",
      JSON.stringify(claudePostRead(ws.H, payFile, TRANSCRIPT)),
      ws.H,
      { CRANK_HOME: ws.home },
    );
    const ctx = additionalContext(run.stdout);
    expect(Buffer.byteLength(ctx)).toBeLessThan(4096);
    const [history, ...rest] = ctx.split(`\n\nExcerpt of \`${ws.payments}/.crank/cerebrum.md\``);
    expect(history).toStartWith("History of src/a.ts (open one: `crank-mem get <id>`):\n");
    expect(Buffer.byteLength(history!)).toBeGreaterThan(1000);
    expect(rest).toHaveLength(1);
    expect(rest[0]).toContain("**Pad 9**");
  });

  test("post-read stays silent when another project's store cannot be read", () => {
    const ws = workspace();
    const storefrontFile = path.join(ws.storefront, "src/a.ts");
    const read = () =>
      runHook(
        "src/hooks/post-read.ts",
        JSON.stringify(claudePostRead(ws.H, storefrontFile, TRANSCRIPT)),
        ws.H,
        { CRANK_HOME: makeCrankHome() },
      );

    plantMemory(ws.storefront, "unreadable");
    const garbage = read();
    expect([garbage.status, garbage.stderr]).toEqual([0, ""]);
    expect(garbage.stdout).not.toContain("History of");

    const db = memoryPath(ws.storefront);
    fs.rmSync(db);
    seedMemory(ws.storefront, [{ title: "Hidden fact", filesRead: ["src/a.ts"] }]);
    fs.chmodSync(db, 0o000);
    try {
      const locked = read();
      expect([locked.status, locked.stderr]).toEqual([0, ""]);
      expect(locked.stdout).not.toContain("History of");
    } finally {
      fs.chmodSync(db, 0o644);
    }
  });
});

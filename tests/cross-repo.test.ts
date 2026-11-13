import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import {
  claudePostBash,
  claudePostRead,
  claudePostWrite,
  claudeSessionStart,
} from "./fixtures/payloads.ts";
import { readUntouched } from "../src/hooks/lib/untouched.ts";
import { localDate, MEMORY_NEWER_NOTE, memoryPath } from "../src/hooks/lib/memory.ts";
import type { Digest } from "../src/daemon/digest-prompt.ts";
import { okStream, okStreamOf } from "./fixtures/claude-scenarios.ts";
import { SAMPLE_DIGEST } from "./fixtures/digest-output.ts";
import {
  journey,
  makeCrankHome,
  plantMemory,
  projectId,
  readRecord,
  realModelsDir,
  rerun,
  runCli,
  runHook,
  seedMemory,
  setMtime,
  startDashboard,
  userRecord,
  withEnv,
} from "./helpers.ts";
import { V1_DDL } from "./fixtures/schema-v1.ts";
import { V2_DDL } from "./fixtures/schema-v2.ts";
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

/** A CLI env outside any Claude session, so its searches never count toward a project's follow-through. */
const sessionless = (ws: Ws) => ({ CRANK_HOME: ws.home, CLAUDECODE: "" });

type Ws = ReturnType<typeof workspace>;

/** A transcript past MIN_DELTA_CHARS that reads `<H>/src/h.ts`, `<storefront>/src/a.ts` and `<payments>/src/a.ts`. */
function crossTranscript(ws: Ws): {
  transcript: string;
  last: { uuid: string; timestamp: string };
} {
  const files = [
    path.join(ws.H, "src/h.ts"),
    path.join(ws.storefront, "src/a.ts"),
    path.join(ws.payments, "src/a.ts"),
  ];
  const at = (i: number) => `2026-01-02T00:00:0${i}.000Z`;
  const records = [
    userRecord("x-0", at(0), "read these files ".repeat(150)),
    ...files.map((f, i) => readRecord(`x-${i + 1}`, at(i + 1), f)),
  ];
  return {
    transcript: records.join("\n") + "\n",
    last: { uuid: `x-${files.length}`, timestamp: at(files.length) },
  };
}

const observation = (
  title: string,
  files_read: string[],
  files_modified: string[] = [],
): Digest["observations"][number] => ({
  type: "discovery",
  title,
  narrative: `${title}, in words.`,
  facts: [],
  files_read,
  files_modified,
});

const digestOf = (observations: Digest["observations"]): Digest => ({
  ...SAMPLE_DIGEST,
  observations,
  summary: { ...SAMPLE_DIGEST.summary, next_steps: "Ship the storefront fix" },
});

/** The digest journey 1 scripts: `Cross fix` across all three projects, `Clone note` on an unowned clone. */
const crossDigest = (ws: Ws): Digest =>
  digestOf([
    observation(
      "Cross fix",
      [path.join(ws.storefront, "src/a.ts"), "../payments-api/src/a.ts"],
      [path.join(ws.H, "src/h.ts")],
    ),
    observation("Clone note", [path.join(ws.H, "clones/u/x.ts")]),
  ]);

const BULLETS = ["Storefront bullet", "Payments bullet", "Cross bullet", "Lost bullet"];

/** A consolidation that adds `bullet` for proposal 1 and accepts it. */
const acceptFirst = (bullet: string) =>
  okStreamOf({
    edits: [{ op: "add", heading: "Memory", bullet, proposal: 1 }],
    proposals: [{ id: 1, verdict: "accepted", reason: "the code holds it" }],
    stale: [],
  });

/**
 * Journey 1's digest: storefront and H each seeded with one row the prompt shows, then `crossDigest` with one
 * proposal per project name (`storefront`, `payments-api`, `cross-repo`, `nowhere`) and stale flags on
 * storefront's row, an unshown storefront id and H's row by `hHandle(hid)`; consolidations scripted in name
 * order, then H's.
 */
function proposalJourney(ws: Ws, hHandle: (hid: number) => string) {
  const [sid] = seedMemory(ws.storefront, [
    { title: "Front seed", narrative: "Seeded front words.", filesRead: ["src/a.ts"] },
  ]);
  const [hid] = seedMemory(ws.H, [
    { title: "Home seed", narrative: "Seeded home words.", filesRead: ["src/h.ts"] },
  ]);
  const output: Digest = {
    ...crossDigest(ws),
    proposals: [
      { kind: "memory", bullet: "Storefront bullet", project: "storefront" },
      { kind: "memory", bullet: "Payments bullet", project: "payments-api" },
      { kind: "memory", bullet: "Cross bullet", project: "cross-repo" },
      { kind: "memory", bullet: "Lost bullet", project: "nowhere" },
    ],
    stale: [
      { id: `storefront#${sid}`, reason: "outdated" },
      { id: "storefront#999", reason: "unlisted" },
      { id: hHandle(hid!), reason: "replaced" },
    ],
  };
  const { transcript } = crossTranscript(ws);
  const j = journey(
    ws.H,
    [
      { lines: okStream(output) },
      { lines: okStreamOf({ edits: [], proposals: [], stale: [] }) },
      { lines: acceptFirst("Storefront bullet") },
      { lines: acceptFirst("Cross bullet") },
    ],
    { home: ws.home, cwd: ws.H, transcript },
  );
  return { ...j, sid: sid!, hid: hid! };
}

/** The `#<id>` lines `search <query>` prints in `root`. */
function searchIds(ws: Ws, root: string, query: string): number[] {
  return runCli(root, ["search", query], sessionless(ws))
    .stdout.split("\n")
    .filter((l) => l.startsWith("#"))
    .map((l) => Number(/^#(\d+)/.exec(l)![1]));
}

const getText = (ws: Ws, root: string, id: number) =>
  runCli(root, ["get", String(id)], sessionless(ws)).stdout;

/** The `stale:` line `get <id>` prints in `root`, or undefined. */
const staleLine = (ws: Ws, root: string, id: number) =>
  getText(ws, root, id)
    .split("\n")
    .find((l) => l.startsWith("stale: "));

const sessionStart = (ws: Ws, root: string) =>
  additionalContext(
    runHook("src/hooks/session-start.ts", JSON.stringify(claudeSessionStart(root)), root, {
      CRANK_HOME: ws.home,
    }).stdout,
  );

describe("cross-repo memory", () => {
  test("journey 1: a session started in H captures across projects", async () => {
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
    const stats = runCli(ws.H, ["stats"], { ...sessionless(ws), TZ: "UTC" });
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

    const storefrontCerebrum = path.join(ws.storefront, ".crank/cerebrum.md");
    const cerebrumText = fs.readFileSync(storefrontCerebrum, "utf-8");
    fs.rmSync(storefrontCerebrum);
    const noCerebrum = read(storefrontFile, "9c000006");
    expect(noCerebrum.status).toBe(0);
    expect(noCerebrum.stdout).not.toContain("Excerpt of");
    fs.writeFileSync(storefrontCerebrum, cerebrumText);

    const { sid, hid, job, fake } = proposalJourney(ws, (hid) => `#${hid}`);
    expect(job.status).toBe(0);
    const pCalls = fake.calls().filter((c) => c.argv.includes("-p"));
    expect(pCalls.map((c) => c.cwd)).toEqual(
      [path.join(ws.home, "run"), ws.payments, ws.storefront, ws.H].map((d) => fs.realpathSync(d)),
    );
    const bullets = (stdin: string) => BULLETS.filter((b) => stdin.includes(b));
    expect(pCalls.slice(1).map((c) => bullets(c.stdin))).toEqual([
      ["Payments bullet"],
      ["Storefront bullet"],
      ["Cross bullet", "Lost bullet"],
    ]);
    const sfCerebrum = fs.readFileSync(storefrontCerebrum, "utf-8");
    expect(sfCerebrum).toContain("Storefront bullet");
    expect(sfCerebrum).not.toContain("Cross bullet");
    expect(fs.readFileSync(path.join(ws.H, ".crank/cerebrum.md"), "utf-8")).toContain(
      "Cross bullet",
    );
    expect(staleLine(ws, ws.storefront, sid)).toContain("outdated");
    expect(staleLine(ws, ws.H, hid)).toContain("replaced");
    expect(runCli(ws.storefront, ["stats"], sessionless(ws)).stdout).toContain(
      "\n  stale:            1\n",
    );
    for (const root of [ws.storefront, ws.payments]) {
      const ids = searchIds(ws, root, "Cross fix");
      expect(ids).toHaveLength(1);
      const got = getText(ws, root, ids[0]!);
      expect(got).toContain("\nfiles read: src/a.ts\n");
      expect(got).toContain("\nfiles modified: (none)");
    }
    const [hCross] = searchIds(ws, ws.H, "Cross fix");
    const hGot = getText(ws, ws.H, hCross!);
    expect(hGot).toContain("\nfiles read: (none)\n");
    expect(hGot).toContain("\nfiles modified: src/h.ts");
    const clone = searchIds(ws, ws.H, "Clone note");
    expect(clone).toHaveLength(1);
    expect(getText(ws, ws.H, clone[0]!)).toContain("\nfiles read: (none)\n");

    const hStart = sessionStart(ws, ws.H);
    expect(hStart).toContain("- Search also covers linked projects: payments-api, storefront.");
    expect(hStart).toContain("Ship the storefront fix");
    expect(sessionStart(ws, ws.storefront)).not.toContain("Ship the storefront fix");

    const cli = (args: string[]) => runCli(ws.H, args, sessionless(ws));
    const [cid] = searchIds(ws, ws.storefront, "Cross fix");
    const cross = cli(["get", `storefront#${cid}`]);
    expect(cross.status).toBe(0);
    expect(lastLine(ws.storefront)).toMatchObject({
      channel: "get",
      requested: [cid],
      found: [cid],
    });
    expect(lastLine(ws.H)).toMatchObject({ channel: "get", requested: [], found: [] });
    expect(cross.stdout.split("\n")[0]).toMatch(
      new RegExp(`^storefront#${cid} \\d{4}-\\d\\d-\\d\\d discovery Cross fix$`),
    );
    expect(cross.stdout).toContain("\nfiles read: src/a.ts\n");
    expect(cli(["get", `#${hid}`, `storefront#${cid}`])).toMatchObject({
      status: 0,
      stdout: `${getText(ws, ws.H, hid)}\n${cross.stdout}`,
    });
    expect(cli(["get", `H#${hid}`]).stdout).toStartWith(`#${hid} `);

    const around = cli(["timeline", `storefront#${cid}`]);
    expect(around.status).toBe(0);
    const aroundLines = around.stdout.split("\n").filter(Boolean);
    expect(aroundLines.length).toBeGreaterThan(1);
    for (const line of aroundLines) expect(line).toMatch(/^storefront#\d+ /);
    expect(lastLine(ws.H)).toMatchObject({ channel: "timeline", anchor: cid, depth: 5, ids: [] });
    expect(cli(["timeline", "storefront#999999"])).toMatchObject({
      status: 1,
      stderr: "crank-mem: no observation storefront#999999.\n",
    });
    expect(cli(["timeline", "H#99999"])).toMatchObject({
      status: 1,
      stderr: "crank-mem: no observation #99999.\n",
    });

    const [backId] = seedMemory(ws.H, [
      {
        title: "Back office",
        narrative: "Seeded for the ledger check too.",
        filesRead: ["src/h.ts"],
      },
    ]);
    const [frontId] = seedMemory(ws.storefront, [
      { title: "Front only", narrative: "Seeded for the ledger check.", filesRead: ["src/b.ts"] },
    ]);
    const found = (...args: string[]) =>
      cli(["search", ...args])
        .stdout.split("\n")
        .filter(Boolean);
    const backLine = expect.stringMatching(new RegExp(`^#${backId} .* Back office$`));
    const frontLine = expect.stringMatching(new RegExp(`^storefront#${frontId} .* Front only$`));
    expect(found("Front only")).toEqual([frontLine]);
    expect(found("ledger")).toEqual([backLine, frontLine]);
    expect(found("ledger", "--limit", "1")).toEqual([backLine]);
    expect(found("Cross fix")).toEqual([expect.stringMatching(new RegExp(`^#${hCross} `))]);

    plantMemory(ws.payments, "newer");
    const paymentsUsage = usageLines(ws.payments).length;
    const hUsage = usageLines(ws.H).length;
    expect(cli(["get", "payments-api#1"])).toMatchObject({
      status: 1,
      stdout: "",
      stderr: "crank-mem: no observation found.\n",
    });
    expect(usageLines(ws.payments)).toHaveLength(paymentsUsage);
    expect(usageLines(ws.H)).toHaveLength(hUsage + 1);
    expect(lastLine(ws.H)).toMatchObject({ channel: "get", requested: [], found: [] });
    expect(cli(["get", `#${hid}`, "payments-api#1"])).toMatchObject({
      status: 0,
      stdout: getText(ws, ws.H, hid),
    });
    expect(cli(["timeline", "payments-api#1"])).toMatchObject({
      status: 1,
      stdout: "",
      stderr: MEMORY_NEWER_NOTE + "\n",
    });
    const closed = cli(["search", "Cross fix"]);
    expect(closed.stdout.split("\n").filter(Boolean)).toEqual([
      expect.stringMatching(new RegExp(`^#${hCross} `)),
    ]);
    expect(closed.stderr).not.toContain(MEMORY_NEWER_NOTE);
    expect(closed.stderr).not.toContain("payments");

    const sessioned = { CRANK_HOME: ws.home, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "sess-1" };
    expect(runCli(ws.H, ["search", "Front only"], sessioned).status).toBe(0);
    const searched = { channel: "search", session: "sess-1", query: "Front only" };
    expect(lastLine(ws.H)).toMatchObject({ ...searched, ids: [] });
    expect(lastLine(ws.storefront)).toMatchObject({ ...searched, ids: [frontId] });
    expect(runCli(ws.H, ["get", `storefront#${frontId}`], sessioned).status).toBe(0);
    const dash = await startDashboard(ws.home, ["--port", "0"]);
    try {
      const res = await dash.get(`/api/projects/${projectId(ws.storefront)}/usage?days=7`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { followThrough: unknown }).followThrough).toBe(1);
    } finally {
      await dash.stop();
    }
  }, 30_000);

  test("a linked store's graph list follows the pairs", () => {
    /** H's `search "src/h.ts"` lines, with H's row on `src/h.ts` citing `refs` and linking `links`. */
    const run = (refs: { project: string; path: string; kind: "read" }[], links: string[]) => {
      const ws = workspace();
      sessionStart(ws, ws.H);
      const [hid] = seedMemory(
        ws.H,
        [{ title: "Home pair", narrative: "Pairs the pay file.", filesRead: ["src/h.ts"], refs }],
        { links },
      );
      const [ledger] = seedMemory(ws.payments, [
        {
          title: "Ledger close",
          narrative: "Batches settle overnight.",
          filesRead: ["src/pay.ts"],
        },
        { title: "Pay home row", narrative: "Unpaired words here.", filesRead: ["src/h.ts"] },
      ]);
      const lines = runCli(ws.H, ["search", "src/h.ts"], sessionless(ws)).stdout;
      return { hid: hid!, ledger: ledger!, lines: lines.split("\n").filter(Boolean) };
    };
    const homeLine = (hid: number) => expect.stringMatching(new RegExp(`^#${hid} .* Home pair$`));

    const paired = run([{ project: "payments-api", path: "src/pay.ts", kind: "read" }], []);
    expect(paired.lines).toEqual([
      homeLine(paired.hid),
      expect.stringMatching(new RegExp(`^payments-api#${paired.ledger} .* Ledger close$`)),
    ]);
    const unpaired = run([], ["payments-api"]);
    expect(unpaired.lines).toEqual([homeLine(unpaired.hid)]);
  }, 30_000);

  test("a stale flag may name the session's project by name", () => {
    const ws = workspace();
    const { hid, job } = proposalJourney(ws, (hid) => `H#${hid}`);
    expect(job.status).toBe(0);
    expect(staleLine(ws, ws.H, hid)).toContain("replaced");
  }, 30_000);

  test("a modified file in another project links it from the entry project", () => {
    const ws = workspace();
    const { transcript } = crossTranscript(ws);
    const output = digestOf([
      observation("Front edit", [], [path.join(ws.storefront, "src/a.ts")]),
    ]);
    const { job, fake } = journey(ws.H, [{ lines: okStream(output) }], {
      home: ws.home,
      cwd: ws.H,
      transcript,
    });
    expect(job.status).toBe(0);
    expect(fake.calls().filter((c) => c.argv.includes("-p"))).toHaveLength(1);
    expect(sessionStart(ws, ws.H)).toContain("- Search also covers linked projects: storefront.");
    expect(searchIds(ws, ws.H, "Front edit")).toEqual([]);
    const stats = runCli(ws.storefront, ["stats"], { CRANK_HOME: ws.home }).stdout;
    expect(stats).toContain("  month cost:       $0.00 (list price)");
    expect(stats).toMatch(/ {2}last digest: {6}\d+s ago\n/);
  }, 30_000);

  test("each written store is embedded and snapshotted", () => {
    const ws = workspace();
    fs.symlinkSync(realModelsDir(), path.join(ws.home, "models"));
    const { transcript } = crossTranscript(ws);
    const output = digestOf([
      observation("Both reads", [path.join(ws.storefront, "src/a.ts"), "../payments-api/src/a.ts"]),
    ]);
    const { job } = journey(ws.H, [{ lines: okStream(output) }], {
      home: ws.home,
      cwd: ws.H,
      transcript,
    });
    expect(job.status).toBe(0);
    for (const root of [ws.storefront, ws.payments]) {
      const stats = runCli(root, ["stats"], { CRANK_HOME: ws.home }).stdout;
      expect(stats).toContain("\n  unembedded:       0\n");
      expect(fs.readdirSync(path.join(root, ".crank/backups/memory"))).toHaveLength(1);
    }
  }, 90_000);

  test("a proposal alone gives its project a share", () => {
    const ws = workspace();
    const { transcript } = crossTranscript(ws);
    const output: Digest = {
      ...digestOf([observation("Home only", [path.join(ws.H, "src/h.ts")])]),
      proposals: [{ kind: "memory", bullet: "Front only", project: "storefront" }],
    };
    const { job, fake } = journey(
      ws.H,
      [{ lines: okStream(output) }, { lines: okStreamOf({ edits: [], proposals: [], stale: [] }) }],
      { home: ws.home, cwd: ws.H, transcript },
    );
    expect(job.status).toBe(0);
    const front = fake
      .calls()
      .filter((c) => c.argv.includes("-p") && c.cwd === fs.realpathSync(ws.storefront));
    expect(front).toHaveLength(1);
    expect(front[0]!.stdin).toContain("Front only");
  }, 30_000);

  test("a share already at the session's position is not written twice", () => {
    const ws = workspace();
    const { transcript, last } = crossTranscript(ws);
    seedMemory(ws.storefront, [], { session: "s1", next: last });
    const { job } = journey(ws.H, [{ lines: okStream(crossDigest(ws)) }], {
      home: ws.home,
      cwd: ws.H,
      transcript,
    });
    expect(job.status).toBe(0);
    expect(searchIds(ws, ws.storefront, "Cross fix")).toEqual([]);
    expect(searchIds(ws, ws.H, "Cross fix")).toHaveLength(1);
    expect(searchIds(ws, ws.payments, "Cross fix")).toHaveLength(1);
  }, 30_000);

  test("an entry store that will not open writes no share", () => {
    const run = (setUp: (ws: Ws) => () => void) => {
      const ws = workspace();
      const { transcript } = crossTranscript(ws);
      const j = journey(ws.H, [{ lines: okStream(crossDigest(ws)) }], {
        home: ws.home,
        cwd: ws.H,
        transcript,
        skipJob: true,
      });
      const restore = setUp(ws);
      try {
        const job = rerun(j);
        const search = runCli(ws.storefront, ["search", "Cross fix"], { CRANK_HOME: ws.home });
        return { job, search };
      } finally {
        restore();
      }
    };

    const unreadable = run((ws) => {
      plantMemory(ws.H, "unreadable");
      return () => {};
    });
    expect(unreadable.job.status).toBe(1);
    expect(unreadable.search.stdout).not.toContain("Cross fix");

    const readOnly = run((ws) => {
      seedMemory(ws.H, []);
      const db = memoryPath(ws.H);
      fs.chmodSync(db, 0o444);
      return () => fs.chmodSync(db, 0o644);
    });
    expect(readOnly.job.status).not.toBe(0);
    expect(readOnly.search.stdout.split("\n").filter((l) => l.startsWith("#"))).toHaveLength(1);
  }, 30_000);

  test("a share is skipped for a project with digests off, a newer store, or a store that will not open", () => {
    const run = (setUp: (ws: Ws) => () => void) => {
      const ws = workspace();
      const { transcript } = crossTranscript(ws);
      const output = digestOf([
        observation(
          "Cross fix",
          [path.join(ws.storefront, "src/a.ts"), path.join(ws.payments, "src/a.ts")],
          [path.join(ws.H, "src/h.ts")],
        ),
      ]);
      const restore = setUp(ws);
      try {
        const { job } = journey(ws.H, [{ lines: okStream(output) }], {
          home: ws.home,
          cwd: ws.H,
          transcript,
        });
        const search = (root: string) =>
          runCli(root, ["search", "Cross fix"], { CRANK_HOME: ws.home });
        const hits = (root: string) =>
          search(root)
            .stdout.split("\n")
            .filter((l) => l.includes("Cross fix")).length;
        return { ws, job, search, hits };
      } finally {
        restore();
      }
    };

    const off = run((ws) => {
      fs.rmSync(path.join(ws.storefront, ".crank/config.local.json"));
      return () => {};
    });
    expect(off.job.status).toBe(0);
    expect(off.search(off.ws.storefront).stdout).not.toContain("Cross fix");
    expect(off.search(off.ws.storefront).stdout).toContain("crank-mem: no memory exists yet.");
    expect([off.hits(off.ws.H), off.hits(off.ws.payments)]).toEqual([1, 1]);
    expect(off.job.stderr).not.toContain("share for storefront");

    const newer = run((ws) => {
      plantMemory(ws.storefront, "newer");
      return () => {};
    });
    expect(newer.job.status).toBe(0);
    expect(newer.job.stderr).not.toContain("storefront");
    const newerSearch = newer.search(newer.ws.storefront);
    expect([newerSearch.status, newerSearch.stdout]).toEqual([1, ""]);

    const older = run((ws) => {
      const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite;
      const db = new mod.DatabaseSync(memoryPath(ws.storefront));
      db.exec(V1_DDL);
      db.exec(V2_DDL);
      db.exec("PRAGMA user_version = 2");
      db.close();
      return () => {};
    });
    expect(older.job.status).toBe(0);
    const snapshots = fs.readdirSync(path.join(older.ws.storefront, ".crank/backups/memory"));
    expect(snapshots.filter((f) => f.endsWith("-v2.db"))).toHaveLength(1);
    expect(older.hits(older.ws.storefront)).toBe(1);

    const skipLine = (stderr: string, reason: string) =>
      stderr
        .split("\n")
        .filter((l) => l === `crank-mem: share for storefront skipped (${reason}).`);
    const unreadable = run((ws) => {
      plantMemory(ws.storefront, "unreadable");
      return () => {};
    });
    expect(unreadable.job.status).toBe(0);
    expect(skipLine(unreadable.job.stderr, "unreadable")).toHaveLength(1);
    expect([unreadable.hits(unreadable.ws.H), unreadable.hits(unreadable.ws.payments)]).toEqual([
      1, 1,
    ]);

    const readOnly = run((ws) => {
      seedMemory(ws.storefront, []);
      const db = memoryPath(ws.storefront);
      fs.chmodSync(db, 0o444);
      return () => fs.chmodSync(db, 0o644);
    });
    expect(readOnly.job.status).toBe(0);
    expect(skipLine(readOnly.job.stderr, "ERR_SQLITE_ERROR")).toHaveLength(1);
    expect([readOnly.hits(readOnly.ws.H), readOnly.hits(readOnly.ws.payments)]).toEqual([1, 1]);
  }, 90_000);

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
    const [frontId] = seedMemory(ws.storefront, [{ title: "Front fact", filesRead: ["src/a.ts"] }]);
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

    const [homeId] = seedMemory(ws.H, [{ title: "Home only note", filesRead: ["src/h.ts"] }], {
      links: ["storefront"],
    });
    const lines = (cwd: string, args: string[]) =>
      runCli(cwd, ["search", ...args], sessionless(ws))
        .stdout.split("\n")
        .filter(Boolean);
    expect(lines(ws.H, ["Pay fact", "--project", "payments-api"])).toEqual([
      expect.stringMatching(new RegExp(`^payments-api#${payFactId} .* Pay fact$`)),
    ]);
    expect(lines(ws.H, ["Home only note", "--project", "H"])).toEqual([
      expect.stringMatching(new RegExp(`^#${homeId} .* Home only note$`)),
    ]);
    const nowhere = runCli(ws.H, ["search", "x", "--project", "nowhere"], sessionless(ws));
    expect(nowhere).toMatchObject({
      status: 1,
      stdout: "",
      stderr: "crank-mem: no project nowhere.\n",
    });
    const outside = runCli(os.tmpdir(), ["search", "x", "--project", "payments-api"], {
      CRANK_HOME: ws.home,
    });
    expect([outside.status, outside.stderr]).toEqual([
      1,
      "crank-mem: not initialized here — run `crank-mem init` first.\n",
    ]);

    const line = (prefix: string, id: number | undefined, title: string) =>
      expect.stringMatching(new RegExp(`^${prefix}#${id} .* ${title}$`));
    const fromStore = lines(ws.storefront, ["fact", "--file", "src/a.ts"]);
    expect(fromStore).toHaveLength(3);
    expect(fromStore).toEqual(
      expect.arrayContaining([
        line("", storefrontId, "Storefront fact"),
        line("", frontId, "Front fact"),
        line("payments-api", payFactId, "Pay fact"),
      ]),
    );
    const fromHome = lines(ws.H, ["fact", "--file", payFile]);
    expect(fromHome).toContainEqual(line("storefront", storefrontId, "Storefront fact"));
    expect(fromHome.filter((l) => l.startsWith("payments-api#"))).toEqual([]);
    expect(lastLine(ws.H)).toMatchObject({ channel: "search", file: "src/pay.ts" });
    const unowned = runCli(
      ws.H,
      ["search", "fact", "--file", path.join(ws.scratch, "a.ts")],
      sessionless(ws),
    );
    expect([unowned.status, unowned.stdout]).toEqual([0, ""]);
    expect(lines(ws.H, ["fact", "--project", "payments-api", "--file", storefrontFile])).toEqual([
      line("payments-api", payFactId, "Pay fact"),
    ]);
    const ownerOnly = lines(ws.H, ["fact", "--project", "storefront", "--file", storefrontFile]);
    expect(ownerOnly).toHaveLength(2);
    expect(ownerOnly).toEqual(
      expect.arrayContaining([
        line("storefront", storefrontId, "Storefront fact"),
        line("storefront", frontId, "Front fact"),
      ]),
    );

    const sessioned = { CRANK_HOME: ws.home, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "sess-2" };
    expect(
      runCli(ws.H, ["search", "Pay fact", "--project", "payments-api"], sessioned).status,
    ).toBe(0);
    const asked = { session: "sess-2", channel: "search", query: "Pay fact", file: null };
    expect(lastLine(ws.payments)).toMatchObject({ ...asked, ids: [payFactId] });
    expect(lastLine(ws.H)).toMatchObject({ ...asked, ids: [] });

    fs.writeFileSync(paymentsFile, "export function charge() {}\n");
    const homeLines = usageLines(ws.H).length;
    const fromH = runCli(ws.H, ["outline", paymentsFile], sessionless(ws));
    expect(fromH.status).toBe(0);
    expect(fromH.stdout).toContain("charge");
    expect(lastLine(ws.payments)).toMatchObject({ channel: "outline", path: "src/a.ts" });
    expect(usageLines(ws.H)).toHaveLength(homeLines);
    const stores = [ws.H, ws.storefront, ws.payments];
    const usageText = () =>
      stores.map((r) => fs.readFileSync(path.join(r, ".crank/usage.jsonl"), "utf-8"));
    const textBefore = usageText();
    const scratchFile = path.join(ws.scratch, "a.ts");
    expect(runCli(ws.H, ["outline", scratchFile], sessionless(ws))).toEqual({
      status: 1,
      stdout: "",
      stderr: `crank-mem: ${scratchFile} is outside every installed project.\n`,
    });
    expect(usageText()).toEqual(textBefore);
    expect(fs.existsSync(path.join(ws.scratch, ".crank"))).toBe(false);
    expect(runCli(os.tmpdir(), ["outline", paymentsFile], sessionless(ws)).status).toBe(0);
    const unfolded = runCli(ws.H, ["unfold", paymentsFile, "charge"], sessionless(ws));
    expect(unfolded.status).toBe(0);
    expect(unfolded.stdout).toContain("export function charge");

    const worktreeFile = path.join(ws.worktree, "src/a.ts");
    fs.writeFileSync(worktreeFile, "export function refund() {}\n");
    const fromWorktree = runCli(ws.H, ["outline", worktreeFile], sessionless(ws));
    expect(fromWorktree.status).toBe(0);
    expect(fromWorktree.stdout).toContain("refund");
    expect(fromWorktree.stdout).not.toContain("charge");
    expect(lastLine(ws.payments)).toMatchObject({ channel: "outline", path: "src/a.ts" });
  }, 30_000);

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

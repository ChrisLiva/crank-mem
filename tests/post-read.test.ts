import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  REPO_ROOT,
  buildGraph,
  childEnv,
  killDaemon,
  makeCrankHome,
  makeCrankProject,
  makeProject,
  plantMemory,
  runCli,
  runHook,
  seedMemory,
  setMtime,
  stopDigests,
  type HookRun,
} from "./helpers.ts";
import { workspace } from "./workspace.ts";
import {
  claudePostBash,
  claudePostRead,
  claudePostWrite,
  claudeSessionStart,
} from "./fixtures/payloads.ts";
import { CODE_BULLET } from "../src/hooks/lib/injection.ts";

const HOOK = "src/hooks/post-read.ts";
const TRANSCRIPT = "/u/.claude/projects/-proj/551be959.jsonl";
const HOUR = 3_600_000;

/** A project whose src/a.ts has `rows` observations, its mtime an hour before the seed. */
function seeded(rows = 7, title = (i: number) => `Read a ${i}`): { root: string; seedMs: number } {
  const root = makeCrankProject({
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 1;\n",
  });
  const seedMs = Date.now();
  seedMemory(
    root,
    Array.from({ length: rows }, (_, i) => ({ title: title(i), filesRead: ["src/a.ts"] })),
  );
  setMtime(path.join(root, "src/a.ts"), seedMs - HOUR);
  return { root, seedMs };
}

function run(root: string, payload: object, env: Record<string, string> = {}): HookRun {
  return runHook(HOOK, JSON.stringify(payload), root, { CRANK_HOME: makeCrankHome(), ...env });
}

function context(r: HookRun): string {
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  expect(out.hookEventName).toBe("PostToolUse");
  return out.additionalContext;
}

describe("post-read file history", () => {
  test("an unwritable seen marker still shows the history, silently", () => {
    const { root } = seeded();
    const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crank-homefile-")), "home");
    fs.writeFileSync(home, "a regular file");
    const r = run(root, claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT), {
      CRANK_HOME: home,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(context(r)).toStartWith("History of src/a.ts (open one: `crank-mem get <id>`):\n#");
  });

  test("a Bash read names the same history as a Read", () => {
    const { root } = seeded();
    const read = run(root, claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT));
    expect(read.status).toBe(0);
    const viaRead = context(read);
    // The newest five lines, newest first.
    expect(viaRead).toStartWith("History of src/a.ts (open one: `crank-mem get <id>`):\n#");
    const lines = viaRead.split("\n").slice(1);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^#\d+ \d{4}-\d\d-\d\d discovery Read a 6$/);
    const viaBash = context(run(root, claudePostBash(root, "sed -n '1,20p' src/a.ts", TRANSCRIPT)));
    expect(viaBash).toBe(viaRead);
    const viaUnfold = context(
      run(root, claudePostBash(root, "crank-mem unfold src/a.ts f", TRANSCRIPT)),
    );
    expect(viaUnfold).toBe(viaRead);
  }, 20_000);

  test("sections stop at 1,536 bytes", () => {
    const root = makeCrankProject({ "src/a.ts": "a\n", "src/b.ts": "b\n" });
    const seedMs = Date.now();
    const long = (f: string) => (i: number) => `${f}${i} `.padEnd(200, "x");
    seedMemory(
      root,
      Array.from({ length: 20 }, (_, i) => ({ title: long("a")(i), filesRead: ["src/a.ts"] })),
    );
    seedMemory(
      root,
      Array.from({ length: 20 }, (_, i) => ({ title: long("b")(i), filesRead: ["src/b.ts"] })),
    );
    for (const f of ["src/a.ts", "src/b.ts"]) setMtime(path.join(root, f), seedMs - HOUR);
    const ctx = context(run(root, claudePostBash(root, "cat src/a.ts src/b.ts", TRANSCRIPT)));
    expect(ctx).toContain("History of src/a.ts (open one: `crank-mem get <id>`):");
    expect(ctx).not.toContain("History of src/b.ts");
    expect(Buffer.byteLength(ctx)).toBeLessThanOrEqual(1536);
  });
});

describe("post-read stale rows", () => {
  test("a file's history leaves out a stale row", () => {
    const root = makeCrankProject({ "src/a.ts": "export const a = 1;\n" });
    const seedMs = Date.now();
    const [a] = seedMemory(root, [
      { title: "Lock retry is two seconds", filesRead: ["src/a.ts"] },
      { title: "Lock files live in .crank", filesRead: ["src/a.ts"] },
    ]) as [number];
    seedMemory(root, [], { stale: [{ id: a, reason: "retry is 5 s now" }] });
    setMtime(path.join(root, "src/a.ts"), seedMs - HOUR);
    const ctx = context(run(root, claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT)));
    expect(ctx).toMatch(
      /^History of src\/a\.ts \(open one: `crank-mem get <id>`\):\n#\d+ \S+ discovery Lock files live in \.crank$/,
    );
  });
});

describe("post-read once per agent per session", () => {
  test("a repeat read is silent; a subagent and another session see it again", () => {
    const { root } = seeded();
    const env = { CRANK_HOME: makeCrankHome() };
    const file = path.join(root, "src/a.ts");
    expect(context(run(root, claudePostRead(root, file, TRANSCRIPT), env))).toStartWith(
      "History of src/a.ts (open one: `crank-mem get <id>`):",
    );
    expect(run(root, claudePostRead(root, file, TRANSCRIPT), env).stdout).toBe("");
    expect(context(run(root, claudePostRead(root, file, TRANSCRIPT, "a1b2"), env))).toStartWith(
      "History of src/a.ts (open one: `crank-mem get <id>`):",
    );
    const other = "/u/.claude/projects/-proj/7c2e9f14.jsonl";
    expect(context(run(root, claudePostRead(root, file, other), env))).toStartWith(
      "History of src/a.ts (open one: `crank-mem get <id>`):",
    );
  });

  test("a marker from before absolute paths is read as empty", () => {
    const { root } = seeded();
    const home = makeCrankHome();
    fs.mkdirSync(path.join(home, "seen"));
    fs.writeFileSync(path.join(home, "seen/551be959-main.seen"), "src/a.ts\n");
    const r = run(root, claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT), {
      CRANK_HOME: home,
    });
    expect(context(r)).toStartWith("History of src/a.ts (open one: `crank-mem get <id>`):\n#");
  });

  test("parallel reads of different files each mark their file", async () => {
    const names = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    const root = makeCrankProject(Object.fromEntries(names.map((n) => [n, "export {};\n"])));
    seedMemory(
      root,
      names.map((n) => ({ title: `Read ${n}`, filesRead: [n] })),
    );
    const env = { CRANK_HOME: makeCrankHome() };
    const payload = (n: string) => claudePostRead(root, path.join(root, n), TRANSCRIPT);
    const children = names.map((n) =>
      Bun.spawn(["bun", path.join(REPO_ROOT, HOOK)], {
        cwd: root,
        env: childEnv(env),
        stdin: new Blob([JSON.stringify(payload(n))]),
        stdout: "pipe",
        stderr: "ignore",
      }),
    );
    const outs = await Promise.all(
      children.map(async (c) => {
        await c.exited;
        return new Response(c.stdout).text();
      }),
    );
    for (const [i, out] of outs.entries()) {
      expect(context({ status: 0, stdout: out, stderr: "" })).toStartWith(
        `History of ${names[i]} (open one: \`crank-mem get <id>\`):`,
      );
    }
    expect(names.map((n) => run(root, payload(n), env).stdout)).toEqual(names.map(() => ""));
  }, 20_000);
});

describe("post-read change tag", () => {
  test("a file written after its newest observation is tagged, an older one is not, and a deleted one shows no history", () => {
    const { root, seedMs } = seeded();
    const file = path.join(root, "src/a.ts");
    setMtime(file, seedMs + HOUR);
    expect(context(run(root, claudePostRead(root, file, TRANSCRIPT)))).toStartWith(
      "History of src/a.ts (open one: `crank-mem get <id>`): [file changed since]\n#",
    );
    setMtime(file, seedMs - HOUR);
    expect(context(run(root, claudePostRead(root, file, TRANSCRIPT)))).toStartWith(
      "History of src/a.ts (open one: `crank-mem get <id>`):\n#",
    );
    seedMemory(root, [{ title: "Gone", filesRead: ["src/gone.ts"] }]);
    expect(run(root, claudePostBash(root, "cat src/gone.ts", TRANSCRIPT)).stdout).toBe("");
  });
});

describe("post-read stays silent", () => {
  test("no read, no rows, outside, sensitive, no store, a bad store or no transcript: empty stdout, exit 0", () => {
    const { root } = seeded();
    seedMemory(root, [{ title: "Env", filesRead: [".env"] }]);
    const bare = makeCrankProject({ "src/a.ts": "a\n" });
    const garbage = makeCrankProject({ "src/a.ts": "a\n" });
    plantMemory(garbage, "unreadable");
    const noTranscript: Record<string, unknown> = {
      ...claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT),
    };
    delete noTranscript.transcript_path;
    const cases: Array<[string, string, object]> = [
      ["grep", root, claudePostBash(root, "grep foo src/a.ts", TRANSCRIPT)],
      ["no rows", root, claudePostBash(root, "cat src/b.ts", TRANSCRIPT)],
      ["outside", root, claudePostRead(root, "/elsewhere/a.ts", TRANSCRIPT)],
      [".env", root, claudePostRead(root, path.join(root, ".env"), TRANSCRIPT)],
      ["no store", bare, claudePostRead(bare, path.join(bare, "src/a.ts"), TRANSCRIPT)],
      ["text store", garbage, claudePostRead(garbage, path.join(garbage, "src/a.ts"), TRANSCRIPT)],
      ["no transcript", root, noTranscript],
    ];
    for (const [name, cwd, payload] of cases) {
      const r = run(cwd, payload);
      expect([name, r.status, r.stdout]).toEqual([name, 0, ""]);
    }
    expect(fs.existsSync(path.join(bare, ".crank/memory.db"))).toBe(false);
  });
});

describe("post-read under both runtimes", () => {
  test("node and bun print the same history from a store with no -wal or -shm", () => {
    const { root } = seeded();
    const db = path.join(root, ".crank/memory.db");
    const sidecars = () => [fs.existsSync(`${db}-wal`), fs.existsSync(`${db}-shm`)];
    expect(sidecars()).toEqual([false, false]);
    const input = JSON.stringify(claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT));
    const viaNode = spawnSync(
      "node",
      ["--disable-warning=ExperimentalWarning", path.join(REPO_ROOT, HOOK)],
      {
        input,
        encoding: "utf-8",
        env: childEnv({ CRANK_HOME: makeCrankHome() }),
      },
    );
    expect(sidecars()).toEqual([false, false]);
    const viaBun = runHook(HOOK, input, root, { CRANK_HOME: makeCrankHome() });
    expect([viaNode.status, viaBun.status]).toEqual([0, 0]);
    expect(viaNode.stdout).not.toBe("");
    expect(viaNode.stdout).toBe(viaBun.stdout);
  });
});

const LIB = "export function helper() {}\nexport function other() {}\n";

/** A file importing `names` from `lib` and calling each once. */
function caller(names: string[], lib = "./lib"): string {
  const calls = names.map((n) => `  ${n}();`).join("\n");
  return `import { ${names.join(", ")} } from "${lib}";\nexport function run() {\n${calls}\n}\n`;
}

/** The "Used by" section of a call's context, or null. */
function usedBy(ctx: string): string | null {
  return ctx.split("\n\n").find((section) => section.startsWith("Used by")) ?? null;
}

/**
 * A project of `files` with its graph built and `src/lib.ts` carrying `rows` observations, its
 * mtime an hour before them. The graph is built after the mtime is set, so the parse stamp matches.
 */
function graphed(files: Record<string, string>, rows = 0): string {
  const root = makeCrankProject({ "src/lib.ts": LIB, ...files });
  const seedMs = Date.now();
  if (rows > 0)
    seedMemory(
      root,
      Array.from({ length: rows }, (_, i) => ({
        title: `Read lib ${i}`,
        filesRead: ["src/lib.ts"],
      })),
    );
  setMtime(path.join(root, "src/lib.ts"), seedMs - HOUR);
  buildGraph(root);
  return root;
}

const HEAD = "History of src/lib.ts (open one: `crank-mem get <id>`):\n";
const HISTORY = `${HEAD}#`;

describe("post-read Used by", () => {
  test("a read lists its caller files with counts after its history, once per agent per session", () => {
    const root = graphed(
      { "src/a.ts": caller(["helper"]), "src/b.ts": caller(["helper", "other"]) },
      2,
    );
    const env = { CRANK_HOME: makeCrankHome() };
    const read = () =>
      run(root, claudePostRead(root, path.join(root, "src/lib.ts"), TRANSCRIPT), env);
    const ctx = context(read());
    expect(ctx).toStartWith(HISTORY);
    const [history, section, ...rest] = ctx.split("\n\n");
    expect(history).toStartWith(HISTORY);
    expect(section).toBe(
      "Used by (crank-mem impact src/lib.ts):\n- src/b.ts (2 calls)\n- src/a.ts (1 call)",
    );
    expect(rest).toEqual([]);
    expect(read().stdout).toBe("");
  });

  test("a file with no history still shows it, and a file with no callers shows none", () => {
    const root = graphed({ "src/a.ts": caller(["helper"]) });
    expect(fs.existsSync(path.join(root, ".crank/memory.db"))).toBe(false);
    const lib = run(root, claudePostRead(root, path.join(root, "src/lib.ts"), TRANSCRIPT));
    expect(context(lib)).toBe("Used by (crank-mem impact src/lib.ts):\n- src/a.ts (1 call)");
    expect(run(root, claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT)).stdout).toBe(
      "",
    );
  });

  test("a file touched after its parse shows none, and a store that is gone leaves today's output", () => {
    const root = graphed({ "src/a.ts": caller(["helper"]) }, 2);
    const file = path.join(root, "src/lib.ts");
    const read = () => run(root, claudePostRead(root, file, TRANSCRIPT));
    const stamp = fs.statSync(file).mtimeMs;
    setMtime(file, stamp + 5000);
    expect(usedBy(context(read()))).toBeNull();
    setMtime(file, stamp);
    expect(usedBy(context(read()))).not.toBeNull();

    for (const name of ["code.db", "code.db-wal", "code.db-shm"])
      fs.rmSync(path.join(root, ".crank", name), { force: true });
    const bare = context(
      run(root, claudePostRead(root, file, TRANSCRIPT), { CRANK_HOME: makeCrankHome() }),
    );
    expect(bare).toStartWith(HISTORY);
    expect(bare).not.toContain("Used by");
    expect(fs.existsSync(path.join(root, ".crank/code.db"))).toBe(false);
  });

  test("seven caller files print five, and long paths print only what fits in 512 bytes", () => {
    const names = [1, 2, 3, 4, 5, 6, 7].map((n) => `c${n}`);
    const short = graphed(
      Object.fromEntries(names.map((n) => [`src/${n}.ts`, caller(["helper"])])),
    );
    const five = usedBy(
      context(run(short, claudePostRead(short, path.join(short, "src/lib.ts"), TRANSCRIPT))),
    )!;
    expect(five.split("\n").slice(1)).toEqual(
      names.slice(0, 5).map((n) => `- src/${n}.ts (1 call)`),
    );

    const deep = "d".repeat(110);
    const long = graphed(
      Object.fromEntries(names.map((n) => [`src/${deep}/${n}.ts`, caller(["helper"], "../lib")])),
    );
    const cut = usedBy(
      context(run(long, claudePostRead(long, path.join(long, "src/lib.ts"), TRANSCRIPT))),
    )!;
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(512);
    // The header is 38 B and each line 131 B: three lines and their newlines take 434 B, a fourth would reach 566 B.
    expect(cut.split("\n")).toEqual([
      "Used by (crank-mem impact src/lib.ts):",
      ...names.slice(0, 3).map((n) => `- src/${deep}/${n}.ts (1 call)`),
    ]);
  }, 20_000);

  test("history, Used by and another project's excerpt print in that order under 4,096 bytes, and an unreadable code.db drops only Used by", () => {
    const ws = workspace();
    const lib = path.join(ws.payments, "src/lib.ts");
    for (const [rel, text] of Object.entries({
      "src/lib.ts": LIB,
      "src/c1.ts": caller(["helper"]),
      "src/c2.ts": caller(["helper", "other"]),
    }))
      fs.writeFileSync(path.join(ws.payments, rel), text);
    seedMemory(
      ws.payments,
      Array.from({ length: 5 }, (_, i) => ({
        title: `l${i} `.padEnd(200, "x"),
        filesRead: ["src/lib.ts"],
      })),
    );
    setMtime(lib, Date.now() - HOUR);
    buildGraph(ws.payments);
    const read = () =>
      run(ws.H, claudePostRead(ws.H, lib, TRANSCRIPT), { CRANK_HOME: makeCrankHome() });

    const ctx = context(read());
    const order = [HEAD, `Used by (crank-mem impact ${lib}):`, "Excerpt of "].map((m) =>
      ctx.indexOf(m),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(Buffer.byteLength(ctx)).toBeLessThanOrEqual(4096);

    const db = path.join(ws.payments, ".crank/code.db");
    fs.chmodSync(db, 0o000);
    try {
      const locked = read();
      expect([locked.status, locked.stderr]).toEqual([0, ""]);
      const without = context(locked);
      expect(without).toStartWith(HEAD);
      expect(without).toContain("Excerpt of ");
      expect(without).not.toContain("Used by");
    } finally {
      fs.chmodSync(db, 0o644);
    }
  }, 20_000);

  test("a read in another project prints an impact command that answers about that file from the start project", () => {
    const ws = workspace();
    const lib = path.join(ws.payments, "src/lib.ts");
    for (const [root, rel, text] of [
      [ws.payments, "src/lib.ts", LIB],
      [ws.payments, "src/c1.ts", caller(["helper"])],
      [ws.H, "src/lib.ts", "export function onlyHere() {}\n"],
    ] as const) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    setMtime(lib, Date.now() - HOUR);
    buildGraph(ws.payments);
    buildGraph(ws.H);
    const env = { CRANK_HOME: makeCrankHome() };

    const section = usedBy(context(run(ws.H, claudePostRead(ws.H, lib, TRANSCRIPT), env)))!;
    const printed = /^Used by \(crank-mem (impact .+)\):/.exec(section)![1]!.split(" ");
    const answer = runCli(ws.H, printed, env);
    expect(answer.status).toBe(0);
    expect(answer.stdout).toContain("src/c1.ts");
    expect(answer.stdout).not.toContain("onlyHere");

    const own = path.join(ws.H, "src/lib.ts");
    setMtime(own, Date.now() - HOUR);
    buildGraph(ws.H);
    fs.writeFileSync(path.join(ws.H, "src/user.ts"), caller(["onlyHere"]));
    buildGraph(ws.H);
    const mine = usedBy(context(run(ws.H, claudePostRead(ws.H, own, TRANSCRIPT), env)));
    expect(mine?.split("\n")[0]).toBe("Used by (crank-mem impact src/lib.ts):");
  }, 30_000);
});

describe("post-read journey: init to Used by", () => {
  test("a new caller reaches callers, a Claude Read and impact, once", () => {
    const { root, codexHome } = makeProject({ "src/lib.ts": LIB });
    const home = makeCrankHome();
    // A stop state keeps init's daemon from parsing under the test, so the pending clause is stable
    // and the on-demand refresh does the parse; killDaemon ends one that started anyway.
    stopDigests(home);
    const env = { CRANK_HOME: home, CODEX_HOME: codexHome };
    const hook = (file: string, payload: object) =>
      runHook(file, JSON.stringify(payload), root, env);
    try {
      expect(runCli(root, ["init", "--yes", "--codex", "skip"], env).status).toBe(0);

      const start = hook("src/hooks/session-start.ts", claudeSessionStart(root));
      const pointer = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
      expect(pointer).toContain(CODE_BULLET);
      expect(pointer).toMatch(
        /symbol line ranges \(symbols for \d+ files are still being parsed\)/,
      );

      const file = path.join(root, "src/c.ts");
      fs.writeFileSync(file, caller(["helper"]));
      expect(hook("src/hooks/post-write.ts", claudePostWrite(root, file)).status).toBe(0);

      const callers = runCli(root, ["callers", "helper"], env);
      expect(callers.status).toBe(0);
      expect(callers.stdout).toContain("src/c.ts");

      const read = () =>
        hook(HOOK, claudePostRead(root, path.join(root, "src/lib.ts"), TRANSCRIPT));
      expect(context(read())).toBe("Used by (crank-mem impact src/lib.ts):\n- src/c.ts (1 call)");
      expect(read().stdout).toBe("");

      const impact = runCli(root, ["impact", "helper"], env);
      expect(impact.status).toBe(0);
      expect(impact.stdout).toContain("src/c.ts");
    } finally {
      killDaemon(home);
    }
  }, 60_000);
});

const LOOKUP_LIB = [
  "export function loadConfig() {}",
  "export function saveConfig() {}",
  "export function unusedThing() {}",
  "export function dupName() {}",
  "export interface ConfigShape {}",
  "",
].join("\n");

/** A graphed project where two files call `loadConfig`, one calls `saveConfig`, and `dupName` has two definitions. */
function lookupProject(extra: Record<string, string> = {}, rows = 0): string {
  return graphed(
    {
      "src/lib.ts": LOOKUP_LIB,
      "src/other.ts": "export function dupName() {}\n",
      "src/a.ts": caller(["loadConfig"]),
      "src/b.ts": caller(["loadConfig", "saveConfig"]),
      ...extra,
    },
    rows,
  );
}

const callersLine = (name: string, counts: string, at: string) =>
  `Callers of ${name} (crank-mem callers ${name}): ${counts}; defined at ${at}.`;
const LOAD = callersLine("loadConfig", "2 call sites in 2 files", "src/lib.ts:1-1");
const SAVE = callersLine("saveConfig", "1 call site in 1 file", "src/lib.ts:2-2");

/** The project's symbol-lookup usage lines, oldest first, without their time. */
function lookups(root: string): Array<Record<string, unknown>> {
  const file = path.join(root, ".crank/usage.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => line.channel === "symbol-lookup")
    .map(({ ts: _ts, ...rest }) => rest);
}

const SESSION = "551be959-1111-2222-3333-444455556666";
const lookupLine = (symbols: string[], shown: string[], bytes: number) => ({
  v: 1,
  agent: "claude",
  session: SESSION,
  channel: "symbol-lookup",
  tool: "Bash",
  symbols,
  shown,
  bytes,
});

describe("post-read callers pointer", () => {
  test("a grep for a function name adds its callers line with the counts callers prints, once per agent per session", () => {
    const root = lookupProject();
    const env = { CRANK_HOME: makeCrankHome() };
    const grep = (command: string, extra: object = {}) =>
      run(root, { ...claudePostBash(root, command, TRANSCRIPT), ...extra }, env);

    const first = grep('rg -n "loadConfig" src');
    expect([first.status, first.stderr]).toEqual([0, ""]);
    expect(context(first)).toBe(LOAD);
    const cli = runCli(root, ["callers", "loadConfig"]);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("2 call sites in 2 files.");

    expect(grep("git grep -n loadConfig").stdout).toBe("");
    expect(context(grep("grep -rn 'saveConfig(' src"))).toBe(SAVE);
    const sub = { agent_id: "sub1", agent_type: "general-purpose" };
    expect(context(grep("rg loadConfig", sub))).toBe(LOAD);
    expect(grep("rg loadConfig", sub).stdout).toBe("");

    expect(lookups(root)).toEqual([
      lookupLine(["loadConfig"], ["loadConfig"], Buffer.byteLength(LOAD)),
      lookupLine(["loadConfig"], [], 0),
      lookupLine(["saveConfig"], ["saveConfig"], Buffer.byteLength(SAVE)),
      lookupLine(["loadConfig"], ["loadConfig"], Buffer.byteLength(LOAD)),
      lookupLine(["loadConfig"], [], 0),
    ]);
  }, 20_000);

  test("names print in pattern order, and an ambiguous, uncalled or stale name prints no line but is recorded", () => {
    const root = lookupProject();
    const grep = (command: string) =>
      run(root, claudePostBash(root, command, TRANSCRIPT), { CRANK_HOME: makeCrankHome() });

    expect(context(grep('rg "\\bsaveConfig\\b|loadConfig" src; rg unusedThing'))).toBe(
      `${SAVE}\n${LOAD}`,
    );
    expect(grep("rg dupName src").stdout).toBe("");
    expect(grep("rg unusedThing src").stdout).toBe("");
    expect(runCli(root, ["callers", "unusedThing"]).stdout).toContain("0 call sites in 0 files.");

    const lib = path.join(root, "src/lib.ts");
    setMtime(lib, fs.statSync(lib).mtimeMs + 5000);
    const stale = grep("rg loadConfig src");
    expect([stale.status, stale.stdout, stale.stderr]).toEqual([0, "", ""]);

    expect(lookups(root)).toEqual([
      lookupLine(
        ["saveConfig", "loadConfig", "unusedThing"],
        ["saveConfig", "loadConfig"],
        Buffer.byteLength(`${SAVE}\n${LOAD}`),
      ),
      lookupLine(["dupName"], [], 0),
      lookupLine(["unusedThing"], [], 0),
      lookupLine(["loadConfig"], [], 0),
    ]);
  }, 20_000);

  test("a grep that names no function, method or class of the graph is silent and records nothing", () => {
    const root = lookupProject();
    const commands = [
      "rg notASymbol src",
      'rg "loadConfig|notASymbol" src',
      "rg ConfigShape src",
      "bun test | grep loadConfig",
      'rg "function loadConfig" src',
    ];
    for (const command of commands) {
      const r = run(root, claudePostBash(root, command, TRANSCRIPT));
      expect([command, r.status, r.stdout, r.stderr]).toEqual([command, 0, "", ""]);
    }
    const read = run(root, claudePostRead(root, path.join(root, "src/a.ts"), TRANSCRIPT));
    expect([read.status, read.stderr]).toEqual([0, ""]);
    expect(lookups(root)).toEqual([]);

    const bare = makeCrankProject({ "src/lib.ts": LOOKUP_LIB, "src/a.ts": caller(["loadConfig"]) });
    const none = run(bare, claudePostBash(bare, "rg loadConfig src", TRANSCRIPT));
    expect([none.status, none.stdout, none.stderr]).toEqual([0, "", ""]);
    expect(lookups(bare)).toEqual([]);
    expect(fs.existsSync(path.join(bare, ".crank/code.db"))).toBe(false);
  }, 20_000);

  test("a call that reads a file and greps a symbol shows the file's sections, then the callers section", () => {
    const root = lookupProject({}, 2);
    const r = run(
      root,
      claudePostBash(root, "sed -n 1,5p src/lib.ts; rg -n loadConfig src", TRANSCRIPT),
    );
    const sections = context(r).split("\n\n");
    expect(sections).toHaveLength(3);
    expect(sections[0]).toStartWith(HISTORY);
    expect(sections[1]).toStartWith("Used by (crank-mem impact src/lib.ts):\n");
    expect(sections[2]).toBe(LOAD);
    expect(lookups(root)).toEqual([
      lookupLine(["loadConfig"], ["loadConfig"], Buffer.byteLength(LOAD)),
    ]);
  }, 20_000);

  test("the section holds only the lines that fit in 512 bytes, and is dropped whole when the call would reach 4,096", () => {
    const long = [1, 2, 3, 4].map((n) => `longName${n}${"X".repeat(60)}`);
    const libs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `l${n}`);
    const deep = "d".repeat(110);
    const files: Record<string, string> = {
      "src/names.ts": long.map((n) => `export function ${n}() {}\n`).join(""),
      "src/uses.ts": caller(long, "./names"),
    };
    for (const lib of libs) {
      files[`src/${lib}.ts`] = `export function ${lib}Helper() {}\n`;
      for (const c of [1, 2, 3])
        files[`src/${deep}/${lib}c${c}.ts`] = caller([`${lib}Helper`], `../${lib}`);
    }
    const root = lookupProject(files);
    const line = (i: number) =>
      callersLine(long[i]!, "1 call site in 1 file", `src/names.ts:${i + 1}-${i + 1}`);
    const greps = long.map((n) => `rg ${n} src`).join("; ");

    const fit = context(run(root, claudePostBash(root, greps, TRANSCRIPT)));
    // Each line is 223 B: two and their newline take 447 B, a third would reach 671 B.
    expect(fit).toBe(`${line(0)}\n${line(1)}`);
    expect(Buffer.byteLength(fit)).toBeLessThanOrEqual(512);

    const reads = libs.map((lib) => `sed -n 1p src/${lib}.ts`).join("; ");
    const alone = context(run(root, claudePostBash(root, reads, TRANSCRIPT)));
    expect(alone.split("\n\n")).toHaveLength(libs.length);
    // The fixture must leave no room: the reads' sections plus the callers section reach the cap.
    expect(Buffer.byteLength(`${alone}\n\n${fit}`)).toBeGreaterThanOrEqual(4096);
    const both = context(run(root, claudePostBash(root, `${reads}; ${greps}`, TRANSCRIPT)));
    expect(both).toBe(alone);

    expect(lookups(root)).toEqual([
      lookupLine(long, long.slice(0, 2), Buffer.byteLength(fit)),
      lookupLine(long, [], 0),
    ]);
  }, 30_000);
});

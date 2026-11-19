import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  makeCrankProject,
  runHook,
  enableDebugConfig,
  holdCodeDb,
  hookContext,
  queryCodeDb,
  readDebugLog,
} from "./helpers.ts";
import {
  claudeSessionStart,
  claudePostWrite,
  claudePostRead,
  claudeSessionEnd,
  claudeStop,
  claudeSubagentStart,
  codexApplyPatch,
} from "./fixtures/payloads.ts";

const SESSION_START = "src/hooks/session-start.ts";
const POST_WRITE = "src/hooks/post-write.ts";
const THROWING = "tests/fixtures/throwing-hook.ts";

describe("debug logging (black-box)", () => {
  test("enabled: one record per hook run, with outcome and duration", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;", "b.ts": "const b = 2;" });
    enableDebugConfig(root);
    runHook(SESSION_START, JSON.stringify(claudeSessionStart(root)));
    runHook(POST_WRITE, JSON.stringify(claudePostWrite(root, "a.ts")));

    const records = readDebugLog(root);
    expect(records.map((r) => r.hook)).toEqual(["session-start", "post-write"]);
    for (const r of records) {
      expect(r.ok).toBe(true);
      expect(typeof r.ms).toBe("number");
      expect(typeof r.ts).toBe("string");
    }

    const refresh = records[0]!.events.find((e) => e.event === "graph-refresh");
    expect(refresh!.added).toBe(2);
    expect(refresh!.removed).toBe(0);
    expect(refresh!.partial).toBe(false);
    const injected = records[0]!.events.find((e) => e.event === "injected");
    expect(injected!.fileCount).toBe(2);
    expect(injected!.source).toBe("startup");
    expect(injected!.injectionTokens).toBeGreaterThan(0);
    expect(Object.keys(injected!).filter((k) => k.startsWith("journal"))).toEqual([]);

    const writeEvents = records[1]!.events;
    expect(writeEvents.find((e) => e.event === "reindex")).toMatchObject({ paths: ["a.ts"] });
  });

  test("a payload without cwd finds the project from the process cwd, and every hook logs a record", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    enableDebugConfig(root);
    const transcript = path.join(root, "t.jsonl");
    const hooks: Array<[string, Record<string, unknown>]> = [
      ["session-start", claudeSessionStart(root)],
      ["subagent-start", claudeSubagentStart(root)],
      ["post-write", claudePostWrite(root, "a.ts")],
      ["post-read", claudePostRead(root, "a.ts", transcript)],
      ["stop", claudeStop(root)],
      ["session-end", claudeSessionEnd(root, transcript)],
    ];
    for (const [hook, payload] of hooks) {
      const { cwd: _, ...withoutCwd } = payload;
      const run = runHook(`src/hooks/${hook}.ts`, JSON.stringify(withoutCwd), root);
      expect(run.status).toBe(0);
    }
    const records = readDebugLog(root);
    expect(records.map((r) => r.hook)).toEqual(hooks.map(([hook]) => hook));
    for (const r of records) expect(r.ok).toBe(true);
  });

  test("CRANK_DEBUG=1 enables logging when config says off, and CRANK_DEBUG=0 disables it when config says on", () => {
    const off = makeCrankProject({ "a.ts": "const a = 1;" });
    runHook(SESSION_START, JSON.stringify(claudeSessionStart(off)), undefined, {
      CRANK_DEBUG: "1",
    });
    expect(readDebugLog(off)).toHaveLength(1);

    const on = makeCrankProject({ "a.ts": "const a = 1;" });
    enableDebugConfig(on);
    runHook(SESSION_START, JSON.stringify(claudeSessionStart(on)), undefined, {
      CRANK_DEBUG: "0",
    });
    expect(readDebugLog(on)).toHaveLength(0);
  });

  test("sensitive paths are redacted, never written to the log", () => {
    const root = makeCrankProject({ ".env": "SECRET=hunter2\n" });
    enableDebugConfig(root);
    runHook(POST_WRITE, JSON.stringify(claudePostWrite(root, ".env")));

    const raw = fs.readFileSync(path.join(root, ".crank/debug.log"), "utf-8");
    expect(raw).toContain("<redacted>");
    expect(raw).not.toContain(".env");
    expect(raw).not.toContain("hunter2");
    expect(queryCodeDb(root, "SELECT path FROM files WHERE path = '.env'")).toEqual([]);
  });

  test("post-write under a held code.db: exit 0, records the skip and no reindex", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    enableDebugConfig(root);
    runHook(SESSION_START, JSON.stringify(claudeSessionStart(root)));
    const release = holdCodeDb(root);
    try {
      const run = runHook(POST_WRITE, JSON.stringify(claudePostWrite(root, "a.ts")));
      expect(run.status).toBe(0);
    } finally {
      release();
    }

    const events = readDebugLog(root)[1]!.events;
    expect(events.find((e) => String(e.event).startsWith("graph"))).toMatchObject({
      event: "graph-skip",
      status: "busy",
    });
    expect(events.some((e) => e.event === "reindex")).toBe(false);
  });

  test("a throwing hook body: exit 0, stderr message, full stack in the log", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    enableDebugConfig(root);

    const run = runHook(THROWING, JSON.stringify(claudeSessionStart(root)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("boom from hook body");

    const record = readDebugLog(root)[0]!;
    expect(record.ok).toBe(false);
    expect(record.error).toContain("boom from hook body");
    // A stack, not just the message.
    expect(record.error).toContain("throwing-hook.ts");
  });

  // The one event that catches a matcher or payload mismatch (ADR 0003). It is
  // only useful if a broken payload looks different from the everyday case of
  // editing a file the index does not cover.
  describe("post-write records why a write produced nothing to index", () => {
    const noOps = (root: string) =>
      readDebugLog(root)[0]!.events.find((e) => e.event === "no-write-ops");

    test("a write that produces nothing to index records its reason and never opens the store: outside-root with the directory, no-path, owner-root, crank-internal, apply_patch skips and unhandled-tool", () => {
      const root = makeCrankProject({ "a.ts": "const a = 1;" });
      const outside = path.join(os.tmpdir(), "elsewhere", ".env");
      enableDebugConfig(root);

      const run = runHook(POST_WRITE, JSON.stringify(claudePostWrite(root, outside)));
      expect(run.status).toBe(0);
      expect(noOps(root)).toMatchObject({
        reason: "outside-root",
        dir: path.join(os.tmpdir(), "elsewhere"),
      });
      expect(fs.readFileSync(path.join(root, ".crank/debug.log"), "utf-8")).not.toContain(".env");
      expect(fs.existsSync(path.join(root, ".crank/code.db"))).toBe(false);

      const reasonOf = (payload: (root: string) => object) => {
        const project = makeCrankProject({ "a.ts": "const a = 1;" });
        enableDebugConfig(project);
        const run = runHook(POST_WRITE, JSON.stringify(payload(project)));
        expect(run.status).toBe(0);
        expect(run.stdout).toBe("");
        expect(fs.existsSync(path.join(project, ".crank/code.db"))).toBe(false);
        const events = readDebugLog(project)[0]!.events.map((e) => String(e.event));
        expect(events.filter((e) => e.startsWith("graph") || e === "reindex")).toEqual([]);
        return noOps(project);
      };
      expect(reasonOf((p: string) => claudePostWrite(p, ".crank/cerebrum.md"))).toMatchObject({
        tool: "Write",
        reason: "crank-internal",
      });
      expect(
        reasonOf((p: string) => ({
          ...claudePostWrite(p, "a.ts"),
          tool_input: { content: "..." },
        })),
      ).toMatchObject({ tool: "Write", reason: "no-path" });
      expect(reasonOf((p: string) => claudePostWrite(p, p))).toMatchObject({
        tool: "Write",
        reason: "owner-root",
      });
      expect(
        reasonOf((p: string) => ({ ...claudePostWrite(p, "a.ts"), tool_name: "Bash" })),
      ).toMatchObject({ tool: "Bash", reason: "unhandled-tool" });
      const patch = [
        "*** Begin Patch",
        "*** Update File: .crank/cerebrum.md",
        "+x",
        `*** Add File: ${path.join(os.tmpdir(), "elsewhere", "b.ts")}`,
        "+y",
        "*** End Patch",
      ].join("\n");
      expect(reasonOf((p: string) => codexApplyPatch(p, patch))).toMatchObject({
        tool: "apply_patch",
        reason: "crank-internal",
      });
      const headerless = "*** Begin Patch\n+z\n*** End Patch";
      expect(reasonOf((p: string) => codexApplyPatch(p, headerless))).toMatchObject({
        tool: "apply_patch",
        reason: "no-path",
      });
    });
  });

  test("an unwritable log never breaks the hook", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    enableDebugConfig(root);
    // A directory where the log file goes: every append fails.
    fs.mkdirSync(path.join(root, ".crank/debug.log"));

    const run = runHook(SESSION_START, JSON.stringify(claudeSessionStart(root)));
    expect(hookContext(run)).toContain("## crank-mem (project memory)");
  });

  test("an oversized log is restarted rather than grown without bound", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    enableDebugConfig(root);
    const logPath = path.join(root, ".crank/debug.log");
    fs.writeFileSync(logPath, "x".repeat(1024 * 1024 + 1));

    runHook(SESSION_START, JSON.stringify(claudeSessionStart(root)));
    expect(fs.statSync(logPath).size).toBeLessThan(1024 * 1024);
    expect(readDebugLog(root).map((r) => r.hook)).toEqual(["session-start"]);
  });
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  makeCrankProject,
  makeCrankHome,
  runHook,
  enableDebugConfig,
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
import { openCodeDb } from "../src/hooks/lib/code-db.ts";

const SESSION_START = "src/hooks/session-start.ts";
const POST_WRITE = "src/hooks/post-write.ts";
const THROWING = "tests/fixtures/throwing-hook.ts";

/** Hold code.db's write lock so the next writer times out; returns the release. */
function holdStore(root: string): () => void {
  const opened = openCodeDb(root, "write");
  expect(opened.status).toBe("open");
  opened.db!.exec("BEGIN IMMEDIATE");
  return () => {
    opened.db!.exec("ROLLBACK");
    opened.db!.close();
  };
}

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

    // Session start records the refresh counters and the injection size.
    const refresh = records[0]!.events.find((e: any) => e.event === "graph-refresh");
    expect(refresh.added).toBe(2);
    expect(refresh.removed).toBe(0);
    expect(refresh.partial).toBe(false);
    const injected = records[0]!.events.find((e: any) => e.event === "injected");
    expect(injected.fileCount).toBe(2);
    expect(injected.source).toBe("startup");
    expect(injected.injectionTokens).toBeGreaterThan(0);
    // Session start never reads journal.md, so the event carries no journal counts.
    expect(Object.keys(injected).filter((k) => k.startsWith("journal"))).toEqual([]);

    // A write lands in code.db.
    const writeEvents = records[1]!.events;
    expect(writeEvents.find((e: any) => e.event === "reindex")).toMatchObject({ paths: ["a.ts"] });
  });

  test("a payload without cwd finds the project from the process cwd, and every hook logs a record", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    enableDebugConfig(root);
    const transcript = path.join(root, "t.jsonl");
    const hooks: Array<[string, object]> = [
      ["session-start", claudeSessionStart(root)],
      ["subagent-start", claudeSubagentStart(root)],
      ["post-write", claudePostWrite(root, "a.ts")],
      ["post-read", claudePostRead(root, "a.ts", transcript)],
      ["stop", claudeStop(root)],
      ["session-end", claudeSessionEnd(root, transcript)],
    ];
    for (const [hook, payload] of hooks) {
      const { cwd: _, ...withoutCwd } = payload as Record<string, unknown>;
      const run = runHook(`src/hooks/${hook}.ts`, JSON.stringify(withoutCwd), root);
      expect(run.status).toBe(0);
    }
    const records = readDebugLog(root);
    expect(records.map((r) => r.hook)).toEqual(hooks.map(([hook]) => hook));
    for (const r of records) expect(r.ok).toBe(true);
  });

  test("a cwd outside any project leaves stop, session-end, post-write and post-read silent", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "crank-bare-"));
    const home = makeCrankHome();
    const transcript = path.join(bare, "t.jsonl");
    const hooks: Array<[string, object]> = [
      ["stop", claudeStop(bare)],
      ["session-end", claudeSessionEnd(bare, transcript)],
      ["post-write", claudePostWrite(bare, "a.ts")],
      ["post-read", claudePostRead(bare, "a.ts", transcript)],
    ];
    for (const [hook, payload] of hooks) {
      const run = runHook(`src/hooks/${hook}.ts`, JSON.stringify(payload), bare, {
        CRANK_HOME: home,
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe("");
    }
    expect(fs.existsSync(path.join(home, "spool"))).toBe(false);
  });

  test("CRANK_DEBUG=1 enables logging when config says off", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    runHook(SESSION_START, JSON.stringify(claudeSessionStart(root)), undefined, {
      CRANK_DEBUG: "1",
    });
    expect(readDebugLog(root)).toHaveLength(1);
  });

  test("CRANK_DEBUG=0 disables logging when config says on", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    enableDebugConfig(root);
    runHook(SESSION_START, JSON.stringify(claudeSessionStart(root)), undefined, {
      CRANK_DEBUG: "0",
    });
    expect(readDebugLog(root)).toHaveLength(0);
  });

  test("sensitive paths are redacted, never written to the log", () => {
    const root = makeCrankProject({ ".env": "SECRET=hunter2\n" });
    enableDebugConfig(root);
    runHook(POST_WRITE, JSON.stringify(claudePostWrite(root, ".env")));

    const raw = fs.readFileSync(path.join(root, ".crank/debug.log"), "utf-8");
    expect(raw).toContain("<redacted>");
    expect(raw).not.toContain(".env");
    expect(raw).not.toContain("hunter2");
    const opened = openCodeDb(root, "read");
    expect(opened.status).toBe("open");
    try {
      expect(opened.db!.prepare("SELECT path FROM files WHERE path = '.env'").all()).toEqual([]);
    } finally {
      opened.db!.close();
    }
  });

  test("post-write under a held code.db: exit 0, records the skip and no reindex", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    enableDebugConfig(root);
    runHook(SESSION_START, JSON.stringify(claudeSessionStart(root)));
    const release = holdStore(root);
    try {
      const run = runHook(POST_WRITE, JSON.stringify(claudePostWrite(root, "a.ts")));
      expect(run.status).toBe(0);
    } finally {
      release();
    }

    const events = readDebugLog(root)[1]!.events;
    expect(events.find((e: any) => String(e.event).startsWith("graph"))).toMatchObject({
      event: "graph-skip",
      status: "busy",
    });
    expect(events.some((e: any) => e.event === "reindex")).toBe(false);
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
    // A stack, not just the message — the reason stderr alone was not enough.
    expect(record.error).toContain("throwing-hook.ts");
  });

  // The one event that catches a matcher or payload mismatch (ADR 0003). It is
  // only useful if a broken payload looks different from the everyday case of
  // editing a file the index does not cover.
  describe("post-write records why a write produced nothing to index", () => {
    const noOps = (root: string) =>
      readDebugLog(root)[0]!.events.find((e: any) => e.event === "no-write-ops");

    test("a file outside the project root: outside-root, with the directory", () => {
      const root = makeCrankProject({ "a.ts": "const a = 1;" });
      const outside = path.join(os.tmpdir(), "elsewhere", ".env");
      enableDebugConfig(root);

      const run = runHook(POST_WRITE, JSON.stringify(claudePostWrite(root, outside)));
      expect(run.status).toBe(0);
      expect(noOps(root)).toMatchObject({
        reason: "outside-root",
        dir: path.join(os.tmpdir(), "elsewhere"),
      });
      // The directory reaches the log without any filename.
      expect(fs.readFileSync(path.join(root, ".crank/debug.log"), "utf-8")).not.toContain(".env");
      expect(fs.existsSync(path.join(root, ".crank/code.db"))).toBe(false);
    });

    test("a write under .crank/: crank-internal, and the store is never opened", () => {
      const root = makeCrankProject({ "a.ts": "const a = 1;" });
      enableDebugConfig(root);
      // A held store would stall any writer — reaching it at all is the failure.
      runHook(SESSION_START, JSON.stringify(claudeSessionStart(root)));
      const release = holdStore(root);
      let events: any[];
      try {
        const run = runHook(
          POST_WRITE,
          JSON.stringify(claudePostWrite(root, ".crank/cerebrum.md")),
        );
        expect(run.status).toBe(0);
        expect(run.stdout).toBe("");
        events = readDebugLog(root)[1]!.events;
      } finally {
        release();
      }
      expect(events.find((e: any) => e.event === "no-write-ops")).toMatchObject({
        reason: "crank-internal",
      });
      expect(events.some((e: any) => String(e.event).startsWith("graph"))).toBe(false);
      expect(events.some((e: any) => e.event === "reindex")).toBe(false);
    });

    test("a payload with no file_path: no-path, not a benign reason", () => {
      const root = makeCrankProject({ "a.ts": "const a = 1;" });
      enableDebugConfig(root);
      const payload = { ...claudePostWrite(root, "a.ts"), tool_input: { content: "..." } };

      const run = runHook(POST_WRITE, JSON.stringify(payload));
      expect(run.status).toBe(0);
      expect(noOps(root)).toMatchObject({ tool: "Write", reason: "no-path" });
    });

    test("a write to the project root itself: owner-root, with the root", () => {
      const root = makeCrankProject({ "a.ts": "const a = 1;" });
      enableDebugConfig(root);

      const run = runHook(POST_WRITE, JSON.stringify(claudePostWrite(root, root)));
      expect(run.status).toBe(0);
      expect(noOps(root)).toMatchObject({ tool: "Write", reason: "owner-root", dir: root });
    });

    test("an apply_patch whose every path is unindexable reports its first skip", () => {
      const root = makeCrankProject({ "a.ts": "const a = 1;" });
      enableDebugConfig(root);
      const patch = [
        "*** Begin Patch",
        "*** Update File: .crank/cerebrum.md",
        "+x",
        `*** Add File: ${path.join(os.tmpdir(), "elsewhere", "b.ts")}`,
        "+y",
        "*** End Patch",
      ].join("\n");

      const run = runHook(POST_WRITE, JSON.stringify(codexApplyPatch(root, patch)));
      expect(run.status).toBe(0);
      expect(noOps(root)).toMatchObject({ tool: "apply_patch", reason: "crank-internal" });

      const headerless = "*** Begin Patch\n+z\n*** End Patch";
      expect(runHook(POST_WRITE, JSON.stringify(codexApplyPatch(root, headerless))).status).toBe(0);
      expect(
        readDebugLog(root)[1]!.events.find((e: any) => e.event === "no-write-ops"),
      ).toMatchObject({ tool: "apply_patch", reason: "no-path" });
    });

    test("a tool the hook does not handle: unhandled-tool", () => {
      const root = makeCrankProject({ "a.ts": "const a = 1;" });
      enableDebugConfig(root);
      const payload = { ...claudePostWrite(root, "a.ts"), tool_name: "Bash" };

      const run = runHook(POST_WRITE, JSON.stringify(payload));
      expect(run.status).toBe(0);
      expect(noOps(root)).toMatchObject({ tool: "Bash", reason: "unhandled-tool" });
    });
  });

  test("an unwritable log never breaks the hook", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    enableDebugConfig(root);
    // A directory where the log file goes: every append fails.
    fs.mkdirSync(path.join(root, ".crank/debug.log"));

    const run = runHook(SESSION_START, JSON.stringify(claudeSessionStart(root)));
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain(
      "## crank-mem (project memory)",
    );
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

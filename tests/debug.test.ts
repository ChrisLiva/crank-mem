import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeCrankProject, runHook, enableDebugConfig, readDebugLog } from "./helpers.ts";
import { claudeSessionStart, claudePostWrite } from "./fixtures/payloads.ts";
import { loadIndex } from "../src/hooks/lib/store.ts";

const SESSION_START = "src/hooks/session-start.ts";
const POST_WRITE = "src/hooks/post-write.ts";
const THROWING = "tests/fixtures/throwing-hook.ts";

/** Hold the index lock so the next writer times out (fresh, live-pid body). */
function holdLock(root: string): void {
  fs.writeFileSync(
    path.join(root, ".crank/anatomy-index.lock"),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() + 60_000 }),
  );
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
    const refresh = records[0]!.events.find((e: any) => e.event === "refresh");
    expect(refresh.added).toBe(2);
    expect(refresh.removed).toBe(0);
    expect(refresh.partial).toBe(false);
    const injected = records[0]!.events.find((e: any) => e.event === "injected");
    expect(injected.fileCount).toBe(2);
    expect(injected.source).toBe("startup");
    expect(injected.injectionTokens).toBeGreaterThan(0);
    // Session start never reads journal.md, so the event carries no journal counts.
    expect(Object.keys(injected).filter((k) => k.startsWith("journal"))).toEqual([]);

    // A lock taken without contention commits and is not logged as a wait.
    const writeEvents = records[1]!.events;
    expect(writeEvents.find((e: any) => e.event === "reindex").committed).toBe(true);
    expect(writeEvents.some((e: any) => e.event === "lock-waited")).toBe(false);
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
    expect(loadIndex(path.join(root, ".crank")).files[".env"]).toBeUndefined();
  });

  test("post-write under a held lock: exit 0, records the timeout and committed=false", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    enableDebugConfig(root);
    holdLock(root);

    const run = runHook(POST_WRITE, JSON.stringify(claudePostWrite(root, "a.ts")));
    expect(run.status).toBe(0);

    const events = readDebugLog(root)[0]!.events;
    expect(events.some((e: any) => e.event === "lock-timeout")).toBe(true);
    expect(events.find((e: any) => e.event === "reindex").committed).toBe(false);
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
      expect(fs.existsSync(path.join(root, ".crank/anatomy-index.json"))).toBe(false);
    });

    test("a write under .crank/: crank-internal, and the index lock is never taken", () => {
      const root = makeCrankProject({ "a.ts": "const a = 1;" });
      enableDebugConfig(root);
      // A held lock would stall any writer — reaching it at all is the failure.
      holdLock(root);

      const run = runHook(POST_WRITE, JSON.stringify(claudePostWrite(root, ".crank/cerebrum.md")));
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");

      const events = readDebugLog(root)[0]!.events;
      expect(events.find((e: any) => e.event === "no-write-ops")).toMatchObject({
        reason: "crank-internal",
      });
      expect(events.some((e: any) => e.event === "lock-timeout")).toBe(false);
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
      "`.crank/anatomy.md` indexes 1 file(s)",
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

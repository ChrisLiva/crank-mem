import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeCrankProject, runHook } from "./helpers.ts";
import { claudeSessionStart, claudeStop } from "./fixtures/payloads.ts";

const HOOK = "src/hooks/stop.ts";

/** Build the initial index (records each file's mtime) as a real session would. */
function seedIndex(root: string): void {
  runHook("src/hooks/session-start.ts", JSON.stringify(claudeSessionStart(root)));
}
function setMtime(p: string, ms: number): void {
  fs.utimesSync(p, new Date(ms), new Date(ms));
}
function cerebrum(root: string): string {
  return path.join(root, ".crank/cerebrum.md");
}
function markerPath(root: string): string {
  return path.join(root, ".crank/cerebrum-nudge.json");
}
function nudge(stdout: string): string | undefined {
  try {
    return JSON.parse(stdout)?.hookSpecificOutput?.additionalContext;
  } catch {
    return undefined;
  }
}

const THREE = { "a.ts": "const a = 1;", "b.ts": "const b = 2;", "c.ts": "const c = 3;" };
// Any epoch well before the files were written: every indexed file is "changed".
const STALE = 1000;
// Any time after the files were written: cerebrum is fresher than all of them.
const FRESH = Date.now() + 1_000_000_000;

describe("stop hook (black-box)", () => {
  test("nudges when enough files changed since cerebrum was updated", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    const ctx = nudge(run.stdout);
    expect(ctx).toContain("crank-mem");
    expect(ctx).toContain("cerebrum");
    expect(ctx).toContain("3 file");
    expect(fs.existsSync(markerPath(root))).toBe(true);
  });

  test("stays quiet when cerebrum is fresher than every file", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(fs.existsSync(markerPath(root))).toBe(false);
  });

  test("stays quiet below the file threshold", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" }); // one file < NUDGE_STEP
    seedIndex(root);
    setMtime(cerebrum(root), STALE);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("debounces: a second stop with no new changes is silent", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);

    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("crank-mem");
    const second = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(second.status).toBe(0);
    expect(second.stdout).toBe("");
  });

  test("re-nudges once NUDGE_STEP more files have changed", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("crank-mem");

    // Three more files change; cerebrum is still untouched.
    for (const f of ["d.ts", "e.ts", "f.ts"]) {
      fs.writeFileSync(path.join(root, f), "export const x = 1;");
    }
    seedIndex(root); // re-index picks up the new files
    setMtime(cerebrum(root), STALE); // re-assert: session-start never edits cerebrum, but be explicit

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain("6 file");
  });

  test("updating cerebrum resets the nudge", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("crank-mem");

    // Agent records a learning: cerebrum becomes fresher than every file.
    setMtime(cerebrum(root), FRESH);
    const after = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(after.stdout).toBe("");
  });

  test("stop_hook_active is respected (no stacking)", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root, true)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("no cerebrum.md: exit 0, silent", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    fs.rmSync(cerebrum(root));

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("garbage stdin: exit 0", () => {
    expect(runHook(HOOK, "]]garbage").status).toBe(0);
  });

  test("empty stdin: exit 0", () => {
    expect(runHook(HOOK, "").status).toBe(0);
  });
});

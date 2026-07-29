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
function longCerebrum(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `- entry ${i}`).join("\n");
}
/** Few lines, lots of prose: under the line guideline, over the token one. */
function fatCerebrum(chars: number): string {
  return Array.from({ length: 10 }, (_, i) => `- entry ${i} ${"x".repeat(chars / 10)}`).join("\n");
}
function journal(root: string): string {
  return path.join(root, ".crank/journal.md");
}
/** Seed a journal at the given mtime (makeCrankProject leaves it absent). */
function writeJournal(root: string, mtimeMs: number): void {
  fs.writeFileSync(journal(root), "# Journal\n\n- 2026-07-01: earlier session\n");
  setMtime(journal(root), mtimeMs);
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

  test("nudges to prune when cerebrum grows past the line guideline", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), longCerebrum(160));
    setMtime(cerebrum(root), FRESH); // fresher than every file: record nudge not due

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain("160 lines");
    expect(ctx).toContain("Prune");
    // Names the concrete deficit to the target, not just the overage.
    expect(ctx).toContain("cut at least 55");
    expect(ctx).not.toContain("file(s) have changed");
  });

  test("prune nudge fires once, then again only after cerebrum is edited", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), longCerebrum(160));
    setMtime(cerebrum(root), FRESH);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("Prune");

    // Same cerebrum version: silent.
    const second = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(second.stdout).toBe("");

    // Edited but still over the guideline: one fresh nudge on the new version.
    setMtime(cerebrum(root), FRESH + 5000);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("Prune");
  });

  test("nudges to prune a short but token-heavy cerebrum", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), fatCerebrum(13000)); // 10 lines, ~3280 tokens
    setMtime(cerebrum(root), FRESH); // fresher than every file: record nudge not due

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain("tokens");
    expect(ctx).toContain("Prune");
    expect(ctx).toContain("under ~2100"); // token target with headroom
    expect(ctx).not.toContain("lines"); // only the measure that tripped is named
  });

  test("stays quiet at the guideline exactly", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), longCerebrum(150));
    setMtime(cerebrum(root), FRESH);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.stdout).toBe("");
  });

  test("record and prune nudges combine when both are due", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), longCerebrum(160));
    setMtime(cerebrum(root), STALE); // older than every file: record nudge also due

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain("3 file");
    expect(ctx).toContain("160 lines");
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

  test("no cerebrum.md but a stale journal: journal part still fires", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    fs.rmSync(cerebrum(root));
    writeJournal(root, STALE);

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain("journal.md");
    expect(ctx).not.toContain("cerebrum");
  });

  test("empty stdin: exit 0", () => {
    expect(runHook(HOOK, "").status).toBe(0);
  });
});

describe("journal nudge (black-box)", () => {
  test("fires when enough files changed since the last journal entry", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH); // record/prune not due — journal part alone
    writeJournal(root, STALE);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    const ctx = nudge(run.stdout);
    expect(ctx).toContain("3 file(s) changed since the last .crank/journal.md entry");
    expect(ctx).toContain("YYYY-MM-DD");
    expect(ctx).not.toContain("cerebrum");
  });

  test("stays quiet when the journal is fresher than every file", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    writeJournal(root, FRESH);

    expect(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout).toBe("");
  });

  test("debounces until NUDGE_STEP more files change", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    writeJournal(root, STALE);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("3 file(s) changed");

    // No new changes: silent.
    expect(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout).toBe("");

    // Three more files, journal still untouched: re-nudge with the new count.
    for (const f of ["d.ts", "e.ts", "f.ts"]) {
      fs.writeFileSync(path.join(root, f), "export const x = 1;");
    }
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("6 file(s) changed");
  });

  test("appending an entry quiets it", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    writeJournal(root, STALE);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("journal.md");

    fs.appendFileSync(journal(root), "- 2026-07-29: recorded where I left off\n");
    setMtime(journal(root), FRESH);
    expect(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout).toBe("");
  });

  // The two measures are deliberately independent: recording a learning is not
  // logging where you left off.
  test("a fresh cerebrum does not quiet a stale journal", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    writeJournal(root, STALE);

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain("journal.md entry");
    expect(ctx).not.toContain("file(s) have changed"); // record part absent
  });

  test("combines with the record and prune parts in one message", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), longCerebrum(160));
    setMtime(cerebrum(root), STALE);
    writeJournal(root, STALE);

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain("file(s) have changed"); // record
    expect(ctx).toContain("journal.md entry"); // journal
    expect(ctx).toContain("160 lines"); // prune
  });

  // A trim rewrites journal.md and restores its mtime. Real filesystems keep
  // sub-millisecond mtimes, and the debounce compares them for equality — so a
  // lossy restore would re-arm the nudge every time the file is trimmed.
  test("a session-start trim does not re-arm the debounce", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    fs.writeFileSync(
      journal(root),
      "# Journal\n" + Array.from({ length: 25 }, (_, i) => `- entry ${i}`).join("\n") + "\n"
    );
    // Sub-millisecond mtime, as a real write produces.
    fs.utimesSync(journal(root), STALE / 1000 + 0.0004999, STALE / 1000 + 0.0004999);

    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("journal.md");
    seedIndex(root); // session start trims the 25 entries down to 20
    expect(fs.readFileSync(journal(root), "utf-8").match(/^- /gm)!.length).toBe(20);

    setMtime(cerebrum(root), FRESH);
    expect(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout).toBe("");
  });

  test("no journal.md (pre-upgrade install): silent about the journal", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), STALE); // record due, journal absent

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain("cerebrum");
    expect(ctx).not.toContain("journal");
  });
});

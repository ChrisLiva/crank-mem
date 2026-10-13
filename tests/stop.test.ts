import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { enableDebugConfig, makeCrankProject, readDebugLog, runHook } from "./helpers.ts";
import { claudeSessionStart, claudeStop } from "./fixtures/payloads.ts";
import { BACKUP_KEEP, NUDGE_STEP } from "../src/hooks/lib/cerebrum-nudge.ts";

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
function backupDir(root: string): string {
  return path.join(root, ".crank/backups/cerebrum");
}
function backups(root: string): string[] {
  return fs.readdirSync(backupDir(root)).sort();
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

/** N source files named f<offset>.ts onward — sized to the nudge threshold. */
function fileSet(n: number, offset = 0): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`f${offset + i}.ts`, `const x${offset + i} = 1;`])
  );
}
const ENOUGH = fileSet(NUDGE_STEP);
// Any epoch well before the files were written: every indexed file is "changed".
const STALE = 1000;
// Any time after the files were written: cerebrum is fresher than all of them.
const FRESH = Date.now() + 1_000_000_000;

describe("stop hook (black-box)", () => {
  test("nudges when enough files changed since cerebrum was updated", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    const ctx = nudge(run.stdout);
    expect(ctx).toContain("crank-mem");
    expect(ctx).toContain("cerebrum");
    expect(ctx).toContain(`${NUDGE_STEP} file`);
    expect(fs.existsSync(markerPath(root))).toBe(true);
  });

  test("stays quiet when cerebrum is fresher than every file", () => {
    const root = makeCrankProject(ENOUGH);
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
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);

    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("crank-mem");
    const second = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(second.status).toBe(0);
    expect(second.stdout).toBe("");
  });

  test("re-nudges once NUDGE_STEP more files have changed", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("crank-mem");

    // NUDGE_STEP more files change; cerebrum is still untouched.
    for (const [f, src] of Object.entries(fileSet(NUDGE_STEP, NUDGE_STEP))) {
      fs.writeFileSync(path.join(root, f), src);
    }
    seedIndex(root); // re-index picks up the new files
    setMtime(cerebrum(root), STALE); // re-assert: session-start never edits cerebrum, but be explicit

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain(`${NUDGE_STEP * 2} file`);
  });

  test("updating cerebrum resets the nudge", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("crank-mem");

    // Agent records a learning: cerebrum becomes fresher than every file.
    setMtime(cerebrum(root), FRESH);
    const after = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(after.stdout).toBe("");
  });

  test("nudges to prune when cerebrum grows past the line guideline", () => {
    const root = makeCrankProject(ENOUGH);
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

  test("prune nudge goes quiet once cerebrum shrinks, even if still oversized", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), longCerebrum(160));
    setMtime(cerebrum(root), FRESH);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("Prune");

    // Agent is mid-prune: smaller than at the last nudge, still over the limit.
    fs.writeFileSync(cerebrum(root), longCerebrum(155));
    setMtime(cerebrum(root), FRESH + 5000);
    const second = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(second.status).toBe(0);
    expect(second.stdout).toBe("");
  });

  test("prune nudge repeats while an oversized cerebrum does not shrink", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), longCerebrum(160));
    setMtime(cerebrum(root), FRESH);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("Prune");

    // Nudge ignored: same size, so it fires again, as the message promises.
    const second = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(second.status).toBe(0);
    expect(nudge(second.stdout)).toContain("Prune");

    // Edited but not shrunk (a rewrite that grew it): still nudges.
    fs.writeFileSync(cerebrum(root), longCerebrum(170));
    setMtime(cerebrum(root), FRESH + 5000);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("170 lines");
  });

  // The stamped size is a floor that every observation lowers, so a prune that
  // stalls partway re-arms the nudge on its own — with no other part firing to
  // rewrite the marker, which is the case that used to silence it forever.
  test("a partial prune that then stalls re-arms the prune nudge", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), longCerebrum(160));
    setMtime(cerebrum(root), FRESH); // record part never due: prune part alone
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("Prune");

    // Partial prune (160 -> 155, still over the limit): silent, and the floor
    // drops to 155 on a marker write nothing else would have triggered.
    fs.writeFileSync(cerebrum(root), longCerebrum(155));
    setMtime(cerebrum(root), FRESH + 5000);
    const during = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(during.status).toBe(0);
    expect(during.stdout).toBe("");

    // Now stalled at 155: no further shrink, so the nudge comes back.
    const stalled = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(stalled.status).toBe(0);
    expect(nudge(stalled.stdout)).toContain("155 lines");

    // And keeps coming back until the file is actually under the limit.
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("155 lines");
    fs.writeFileSync(cerebrum(root), longCerebrum(100));
    setMtime(cerebrum(root), FRESH + 10_000);
    expect(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout).toBe("");
  });

  // brew-pg, 2026-08-14: nudged at 156 lines, pruned to 103, regrew to 157
  // lines with fewer tokens than at the nudge, and the stale token stamp read
  // that as a prune in progress.
  test("a prune that got under the limit clears the floor before regrowth", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    const padded = (n: number) =>
      Array.from({ length: n }, (_, i) => `- entry ${i} padding words here`).join("\n");
    fs.writeFileSync(cerebrum(root), padded(156));
    setMtime(cerebrum(root), FRESH); // record part never due: prune part alone
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain("156 lines");

    // Pruned under both limits; this Stop observes it and stays silent.
    fs.writeFileSync(cerebrum(root), longCerebrum(103));
    setMtime(cerebrum(root), FRESH + 5000);
    const under = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(under.status).toBe(0);
    expect(under.stdout).toBe("");

    // Regrowth past the line limit, with fewer tokens than the 156-line file.
    fs.writeFileSync(cerebrum(root), longCerebrum(157));
    setMtime(cerebrum(root), FRESH + 10_000);
    const regrown = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(regrown.status).toBe(0);
    expect(nudge(regrown.stdout)).toContain("157 lines");
  });

  test("nudges to prune a short but token-heavy cerebrum", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), fatCerebrum(13000)); // 10 lines, ~3280 tokens
    setMtime(cerebrum(root), FRESH); // fresher than every file: record nudge not due

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain("tokens");
    expect(ctx).toContain("Prune");
    expect(ctx).toContain("under ~2100"); // token target with headroom
    expect(ctx).not.toContain("lines"); // only the measure that tripped is named
  });

  test("prune nudge backs cerebrum up first and names the copy", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), longCerebrum(160));
    setMtime(cerebrum(root), FRESH);

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    const [copy] = backups(root);
    expect(backups(root)).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupDir(root), copy!), "utf-8")).toBe(longCerebrum(160));
    expect(ctx).toContain(`A copy of the current file is at .crank/backups/cerebrum/${copy}`);

    // Nudge repeats on an unchanged file: no second copy, same path named.
    const again = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(backups(root)).toEqual([copy!]);
    expect(again).toContain(`.crank/backups/cerebrum/${copy}`);
  });

  test("prune backups keep only the newest copies", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    // Each run grows the file, so the nudge fires and the content differs.
    for (let n = 160; n < 160 + BACKUP_KEEP + 2; n++) {
      fs.writeFileSync(cerebrum(root), longCerebrum(n));
      setMtime(cerebrum(root), FRESH + n);
      expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain(`${n} lines`);
    }
    const kept = backups(root);
    expect(kept).toHaveLength(BACKUP_KEEP);
    expect(fs.readFileSync(path.join(backupDir(root), kept[0]!), "utf-8")).toBe(longCerebrum(162));
    expect(fs.readFileSync(path.join(backupDir(root), kept.at(-1)!), "utf-8")).toBe(
      longCerebrum(160 + BACKUP_KEEP + 1),
    );
  });

  test("prune nudge names the longest whole bullets and asks to archive, not delete", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    const shaBullet = `- gamma fixed in a18c44f ${"x".repeat(4000)}`;
    fs.writeFileSync(
      cerebrum(root),
      [
        "# Cerebrum",
        "",
        "## Memory",
        `- alpha ${"x".repeat(6000)}`, // line 4
        "- beta", // line 5: short first line, long wrapped body
        `  ${"x".repeat(5000)}`,
        shaBullet, // line 7
        "- delta short", // line 8
      ].join("\n"),
    );
    setMtime(cerebrum(root), FRESH);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    const ctx = nudge(run.stdout)!;
    expect(ctx).toContain(
      `Longest bullets: line 4 (6008 chars), line 5 (5009 chars), line 7 (${shaBullet.length} chars, cites a commit).`,
    );
    expect(ctx).not.toContain("line 8");
    expect(ctx).toContain(".crank/cerebrum-archive.md");
    expect(ctx).toContain("keep gotchas and do-not-repeat entries");
    expect(ctx).not.toContain("delete it");
  });

  test("prune nudge still fires, exit 0, when backups cannot be written", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    fs.writeFileSync(path.join(root, ".crank/backups"), "not a directory");
    fs.writeFileSync(cerebrum(root), longCerebrum(160));
    setMtime(cerebrum(root), FRESH);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    expect(nudge(run.stdout)).toContain("Prune");
    expect(nudge(run.stdout)).not.toContain("A copy of the current file");
  });

  test("stays quiet at the guideline exactly", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), longCerebrum(150));
    setMtime(cerebrum(root), FRESH);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.stdout).toBe("");
    expect(fs.existsSync(backupDir(root))).toBe(false); // no prune nudge, no backup
  });

  test("record and prune nudges combine when both are due", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), longCerebrum(160));
    setMtime(cerebrum(root), STALE); // older than every file: record nudge also due

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain(`${NUDGE_STEP} file`);
    expect(ctx).toContain("160 lines");
  });

  test("stop_hook_active is respected (no stacking)", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root, true)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("no cerebrum.md: exit 0, silent", () => {
    const root = makeCrankProject(ENOUGH);
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
    const root = makeCrankProject(ENOUGH);
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
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH); // record/prune not due — journal part alone
    writeJournal(root, STALE);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    const ctx = nudge(run.stdout);
    expect(ctx).toContain(`${NUDGE_STEP} file(s) changed since the last .crank/journal.md entry`);
    expect(ctx).toContain("YYYY-MM-DD");
    expect(ctx).not.toContain("cerebrum");
  });

  test("stays quiet when the journal is fresher than every file", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    writeJournal(root, FRESH);

    expect(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout).toBe("");
  });

  test("debounces until NUDGE_STEP more files change", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    writeJournal(root, STALE);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain(`${NUDGE_STEP} file(s) changed`);

    // No new changes: silent.
    expect(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout).toBe("");

    // NUDGE_STEP more files, journal still untouched: re-nudge with the new count.
    for (const [f, src] of Object.entries(fileSet(NUDGE_STEP, NUDGE_STEP))) {
      fs.writeFileSync(path.join(root, f), src);
    }
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain(`${NUDGE_STEP * 2} file(s) changed`);
  });

  test("appending an entry quiets it", () => {
    const root = makeCrankProject(ENOUGH);
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
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    writeJournal(root, STALE);

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain("journal.md entry");
    expect(ctx).not.toContain("file(s) have changed"); // record part absent
  });

  test("combines with the record and prune parts in one message", () => {
    const root = makeCrankProject(ENOUGH);
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
    const root = makeCrankProject(ENOUGH);
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
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), STALE); // record due, journal absent

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain("cerebrum");
    expect(ctx).not.toContain("journal");
  });
});

/** Run git in a temp project, with identity and signing pinned for CI. */
function git(root: string, ...args: string[]): void {
  const res = spawnSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, encoding: "utf-8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
}
/** A git repo with one empty commit, so `git log` has a branch to read. */
function gitRepo(files: Record<string, string> = {}): string {
  const root = makeCrankProject(files);
  enableDebugConfig(root);
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  return root;
}
function debugEvents(root: string): Array<Record<string, any>> {
  return readDebugLog(root).flatMap((r) => r.events);
}
/** Where the stop hook's count came from, per its last nudge event. */
function countSource(root: string): string | undefined {
  return debugEvents(root).filter((e) => e.event.startsWith("nudge-")).at(-1)?.source;
}
const HOUR = 3_600_000;

// No session start runs in these tests, so the index is empty: any nudge
// proves the count came from git.
describe("change count from git (black-box)", () => {
  test("counts files written after cerebrum that the index never saw", () => {
    const root = gitRepo();
    setMtime(cerebrum(root), Date.now() - HOUR);
    for (const [f, src] of Object.entries(ENOUGH)) fs.writeFileSync(path.join(root, f), src);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    expect(nudge(run.stdout)).toContain(`${NUDGE_STEP} file(s) have changed`);
    expect(countSource(root)).toBe("git");
  });

  test("untracked files older than cerebrum do not count", () => {
    const root = gitRepo(ENOUGH);
    for (const f of Object.keys(ENOUGH)) setMtime(path.join(root, f), Date.now() - 2 * HOUR);
    setMtime(cerebrum(root), Date.now() - HOUR);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(countSource(root)).toBe("git");
  });

  test("files written before cerebrum and committed after it do not count", () => {
    const root = gitRepo(ENOUGH);
    for (const f of Object.keys(ENOUGH)) setMtime(path.join(root, f), Date.now() - 2 * HOUR);
    setMtime(cerebrum(root), Date.now() - HOUR);
    git(root, "add", ...Object.keys(ENOUGH));
    git(root, "commit", "-q", "-m", "old work");

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(countSource(root)).toBe("git");
  });

  test("deleted files count", () => {
    const root = gitRepo(ENOUGH);
    for (const f of Object.keys(ENOUGH)) setMtime(path.join(root, f), Date.now() - 2 * HOUR);
    git(root, "add", ...Object.keys(ENOUGH));
    git(root, "commit", "-q", "-m", "old work");
    setMtime(cerebrum(root), Date.now() - HOUR);
    for (const f of Object.keys(ENOUGH)) fs.rmSync(path.join(root, f));

    expect(nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout)).toContain(
      `${NUDGE_STEP} file(s) have changed`,
    );
  });

  test("the journal part counts from git too", () => {
    const root = gitRepo();
    setMtime(cerebrum(root), FRESH);
    writeJournal(root, Date.now() - HOUR);
    for (const [f, src] of Object.entries(ENOUGH)) fs.writeFileSync(path.join(root, f), src);

    const ctx = nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);
    expect(ctx).toContain(`${NUDGE_STEP} file(s) changed since the last .crank/journal.md entry`);
    expect(ctx).not.toContain("cerebrum");
  });

  test("a git that overruns the budget falls back to the index count", () => {
    const root = gitRepo(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);
    const bin = fs.mkdtempSync(path.join(root, "..", "crank-fakegit-"));
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });

    const started = Date.now();
    const run = runHook(HOOK, JSON.stringify(claudeStop(root)), undefined, {
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(run.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(nudge(run.stdout)).toContain(`${NUDGE_STEP} file(s) have changed`);
    expect(countSource(root)).toBe("index");
    expect(debugEvents(root).some((e) => e.event === "git-changes-failed")).toBe(true);
  });
});

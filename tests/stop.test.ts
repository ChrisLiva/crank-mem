import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { enableDebugConfig, makeCrankProject, readDebugLog, runHook } from "./helpers.ts";
import { claudeSessionStart, claudeStop } from "./fixtures/payloads.ts";
import { AUDIT_INTERVAL_MS, BACKUP_KEEP, NUDGE_STEP } from "../src/hooks/lib/cerebrum-nudge.ts";

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
  return stdout ? JSON.parse(stdout).hookSpecificOutput.additionalContext : undefined;
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

  // A floor stamped while oversized must clear once the file is under both
  // limits, or a regrowth with fewer tokens than the stamp reads as a prune in
  // progress.
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
    // No Codex marker on the payload: both instructions files are named.
    expect(ctx).toContain("delete only what CLAUDE.md, AGENTS.md or the code already states");
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

// Two bullets on one build failure with different remedies: they share
// identifiers but few words.
const OPENGL_OLD =
  "- Fresh build dir fails: `OpenGL.framework` hits `-Werror=unguarded-availability-new`; set `DEVELOPER_DIR` (2026-09-27).";
const OPENGL_NEW =
  "- GUI compile fails (2026-09-28): OpenGL.framework under MacOSX.sdk, -Werror=unguarded-availability-new; use CMAKE_PROJECT_INCLUDE.";
/** OPENGL_OLD on line 4 and an unrelated bullet on line 5, plus any bullets after. */
function memory(...extra: string[]): string {
  return ["# Cerebrum", "", "## Memory", OPENGL_OLD, "- Tests run under `bun test`.", ...extra].join("\n");
}
function dedupState(root: string): string {
  return path.join(root, ".crank/cerebrum-dedup.json");
}
/** Write cerebrum at a given mtime and run Stop. No source files, so only the overlap check can speak. */
function stopAfter(root: string, text: string, mtimeMs: number) {
  fs.writeFileSync(cerebrum(root), text);
  setMtime(cerebrum(root), mtimeMs);
  return runHook(HOOK, JSON.stringify(claudeStop(root)));
}

describe("cerebrum overlap check (black-box)", () => {
  test("the first run records the bullets and stays silent", () => {
    const root = makeCrankProject();
    const run = stopAfter(root, memory(OPENGL_NEW), FRESH);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(fs.existsSync(dedupState(root))).toBe(true);
  });

  test("flags a new bullet that shares identifiers with an older one, once", () => {
    const root = makeCrankProject();
    expect(stopAfter(root, memory(), FRESH).stdout).toBe("");

    const run = stopAfter(root, memory(OPENGL_NEW), FRESH + 5000);
    expect(run.status).toBe(0);
    const ctx = nudge(run.stdout)!;
    expect(ctx).toContain("bullet at line 6 overlaps line 4");
    expect(ctx).toContain("`OpenGL.framework`");
    expect(ctx).toContain("`-Werror=unguarded-availability-new`");
    expect(ctx).toContain("keep both");

    // Same file, same mtime: nothing new to say.
    expect(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout).toBe("");
  });

  test("an unchanged mtime is not reparsed", () => {
    const root = makeCrankProject();
    expect(stopAfter(root, memory(), FRESH).stdout).toBe("");

    // Content changed but the mtime did not: the check does not look.
    expect(stopAfter(root, memory(OPENGL_NEW), FRESH).stdout).toBe("");
    expect(nudge(stopAfter(root, memory(OPENGL_NEW), FRESH + 5000).stdout)).toContain("overlaps line 4");
  });

  test("an edited bullet is not paired with the version it replaced", () => {
    const root = makeCrankProject();
    expect(stopAfter(root, memory(), FRESH).stdout).toBe("");

    const edited = memory().replace(OPENGL_OLD, `${OPENGL_OLD} Still true on SDK 27.`);
    const run = stopAfter(root, edited, FRESH + 5000);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("one shared identifier is not enough", () => {
    const root = makeCrankProject();
    expect(stopAfter(root, memory(), FRESH).stdout).toBe("");
    const run = stopAfter(root, memory("- `DEVELOPER_DIR` also picks the `xcrun` toolchain."), FRESH + 5000);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("a second copy of an existing bullet counts as new", () => {
    const root = makeCrankProject();
    expect(stopAfter(root, memory(), FRESH).stdout).toBe("");
    expect(nudge(stopAfter(root, memory(OPENGL_OLD), FRESH + 5000).stdout)).toContain(
      "bullet at line 6 overlaps line 4",
    );
  });

  test("names at most two pairs", () => {
    const root = makeCrankProject();
    expect(stopAfter(root, memory(), FRESH).stdout).toBe("");
    const three = [1, 2, 3].map((i) => `${OPENGL_NEW} Variant ${i}.`);
    const ctx = nudge(stopAfter(root, memory(...three), FRESH + 5000).stdout)!;
    expect(ctx.match(/overlaps line 4/g)).toHaveLength(2);
  });

  test("rides along with the record nudge in one message", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    expect(stopAfter(root, memory(), FRESH).stdout).toBe("");
    const ctx = nudge(stopAfter(root, memory(OPENGL_NEW), STALE).stdout)!;
    expect(ctx).toContain(`${NUDGE_STEP} file(s) have changed`);
    expect(ctx).toContain("overlaps line 4");
  });

  test("a state file that cannot be written: exit 0, silent", () => {
    const root = makeCrankProject();
    fs.mkdirSync(dedupState(root)); // a directory where the file belongs
    const run = stopAfter(root, memory(OPENGL_NEW), FRESH);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });
});

// The audit skill is user-invoked only, so the suggestion tells the agent to
// ask the user, and only on a turn that already nudges.
describe("audit suggestion (black-box)", () => {
  const DAY = 86_400_000;
  function installSkill(root: string, agentDir = ".claude"): void {
    const dir = path.join(root, agentDir, "skills/crank-mem-audit");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: crank-mem-audit\n---\n");
  }
  /** An audit's backup dir as the skill writes it: plain copies, no manifest. */
  function auditBackup(root: string, ageMs: number): void {
    const dir = path.join(root, ".crank/backups/20260814-165019");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cerebrum.md"), "# Cerebrum\n");
    setMtime(dir, Date.now() - ageMs);
  }
  /** A cerebrum over the line limit, so the prune part fires on every Stop. */
  function pruneDueProject(): string {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    fs.writeFileSync(cerebrum(root), longCerebrum(160));
    setMtime(cerebrum(root), FRESH);
    return root;
  }
  const stop = (root: string) => nudge(runHook(HOOK, JSON.stringify(claudeStop(root))).stdout);

  test("a project never audited counts from install, not from time zero", () => {
    const root = pruneDueProject();
    installSkill(root);
    /** An init backup dir: a manifest, named by newBackupDir's stamp. */
    const initBackup = (ms: number): void => {
      const dir = path.join(root, ".crank/backups", new Date(ms).toISOString().replace(/[:.]/g, "-"));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ createdAt: "", entries: [] }));
    };
    initBackup(Date.now());
    const fresh = stop(root);
    expect(fresh).toContain("160 lines");
    expect(fresh).not.toContain("crank-mem-audit");

    initBackup(Date.now() - AUDIT_INTERVAL_MS - DAY);
    expect(stop(root)).toContain("this project's memory has never been audited");
  });

  test("rides along on a due nudge once per interval, only with the skill installed", () => {
    const root = pruneDueProject();
    const without = stop(root);
    expect(without).toContain("160 lines");
    expect(without).not.toContain("crank-mem-audit");

    installSkill(root);
    // The prune nudge's own backups/cerebrum/ copy is not an audit.
    const first = stop(root);
    expect(first).toContain("160 lines");
    expect(first).toContain(
      "this project's memory has never been audited. Suggest the user run the crank-mem-audit skill (`/crank-mem-audit`)",
    );

    const second = stop(root);
    expect(second).toContain("160 lines");
    expect(second).not.toContain("crank-mem-audit");

    const marker = JSON.parse(fs.readFileSync(markerPath(root), "utf-8"));
    fs.writeFileSync(markerPath(root), JSON.stringify({ ...marker, auditSuggestedAtMs: Date.now() - AUDIT_INTERVAL_MS - DAY }));
    expect(stop(root)).toContain("crank-mem-audit");
  });

  test("never fires on a turn with nothing else due", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    installSkill(root);
    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("a recent audit silences it, and an older one is named by its age", () => {
    const root = pruneDueProject();
    installSkill(root);
    auditBackup(root, DAY);
    const recent = stop(root);
    expect(recent).toContain("160 lines");
    expect(recent).not.toContain("crank-mem-audit");

    auditBackup(root, 10 * DAY);
    expect(stop(root)).toContain("this project's memory was last audited 10 day(s) ago");
  });
});

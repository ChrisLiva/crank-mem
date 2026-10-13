import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeCrankProject, runHook } from "./helpers.ts";
import { claudeSessionStart, codexSessionStart } from "./fixtures/payloads.ts";

const HOOK = "src/hooks/session-start.ts";

describe("session-start hook (black-box)", () => {
  test("Claude payload: exit 0, injects context, refreshes index", () => {
    const root = makeCrankProject({
      "src/app.ts": "/** App entry. */\nexport const app = 1;\n",
      "README.md": "# Demo project\n",
    });
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("crank-mem (project memory)");
    // The scan's result reaches the model as a count and a pointer, not a listing.
    expect(ctx).toContain("`.crank/anatomy.md` indexes 2 file(s)");
    expect(ctx).not.toContain("`app.ts`");
    // index + anatomy.md were written
    const index = JSON.parse(fs.readFileSync(path.join(root, ".crank/anatomy-index.json"), "utf-8"));
    expect(index.meta.fileCount).toBe(2);
    expect(fs.existsSync(path.join(root, ".crank/anatomy.md"))).toBe(true);
  });

  test("Codex payload: same injection shape", () => {
    const root = makeCrankProject({ "main.go": "package main\nfunc main() {}\n" });
    const run = runHook(HOOK, JSON.stringify(codexSessionStart(root)));
    expect(run.status).toBe(0);
    const ctx = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("`.crank/anatomy.md` indexes 1 file(s)");
  });

  test("cerebrum prefs are injected once present", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n\n- Always use tabs\n\n## Key Learnings\n\n## Do-Not-Repeat\n"
    );
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain("Always use tabs");
  });

  test("ADR filenames are listed", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.mkdirSync(path.join(root, "docs/adr"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/adr/0001-use-tabs.md"), "# x");
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain("0001-use-tabs.md");
  });

  test("no .crank/ dir: exit 0, silent stdout", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "crank-bare-"));
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(bare)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("garbage stdin: exit 0, silent", () => {
    const run = runHook(HOOK, "{{{not json");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("empty stdin: exit 0, silent", () => {
    const run = runHook(HOOK, "");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("corrupt index: exit 0 and rebuilds", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.writeFileSync(path.join(root, ".crank/anatomy-index.json"), "corrupt{{");
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain("`.crank/anatomy.md` indexes 1 file(s)");
  });

  test("held lock: exit 0, injects from existing index with staleness note", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.writeFileSync(
      path.join(root, ".crank/anatomy-index.lock"),
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() + 60_000 })
    );
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    expect(run.status).toBe(0);
    const ctx = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("refresh skipped");
  });
});

describe("memory reaches the model whole (black-box)", () => {
  test("a wrapped cerebrum bullet and a NEXT: handoff both survive the trip", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n\n- Always use tabs\n\n## Memory\n\n" +
        "- The blur dies when the container gets `position: fixed` or above a\n" +
        "  z-index of 10 — it becomes a backdrop root, killing the overlay blur.\n"
    );
    fs.writeFileSync(
      path.join(root, ".crank/journal.md"),
      "# Journal\n\n- 2026-07-30: swept the board, tree clean; NEXT: probe both live\n  installs after the bump.\n"
    );

    const ctx = inject(root);
    // The payload of a wrapped bullet used to be cut off at "or above a".
    expect(ctx).toContain(
      "- The blur dies when the container gets `position: fixed` or above a\n" +
        "  z-index of 10 — it becomes a backdrop root, killing the overlay blur."
    );
    // The handoff wraps across physical lines and had never once been delivered.
    expect(ctx).toContain("- 2026-07-30 — swept the board, tree clean; NEXT: probe both live installs after the bump.");
    expect(ctx).toContain("Always use tabs");
  });

  test("an unmigrated cerebrum still injects its Key Learnings", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n\n- Always use tabs\n\n" +
        "## Key Learnings\n\n- The API rate-limits at 100 rps\n\n" +
        "## Do-Not-Repeat\n\n- Never force-push main\n"
    );
    const ctx = inject(root);
    expect(ctx).toContain("The API rate-limits at 100 rps");
    expect(ctx).toContain("Never force-push main");
  });

  test("the excerpt names the heading the file really has", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n\n- Always use tabs\n\n## Key Learnings\n\n- The API rate-limits at 100 rps\n"
    );
    const ctx = inject(root);
    expect(ctx).toContain("### Memory (in file: ## Key Learnings, append at its end)\n- The API rate-limits at 100 rps");
    expect(ctx).toContain("### User Preferences (in file: ## User Preferences, append at its end)");
    expect(ctx).toContain("append new bullets at the end of the section, newest last");
  });
});

describe("vendored-hook drift (black-box)", () => {
  /** A stand-in clone: just the package.json the drift check reads. */
  function fakeClone(version: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crank-clone-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "crank-mem", version }));
    return dir;
  }
  function configure(root: string, patch: Record<string, unknown>): void {
    const file = path.join(root, ".crank/config.json");
    const config = JSON.parse(fs.readFileSync(file, "utf-8"));
    fs.writeFileSync(file, JSON.stringify({ ...config, ...patch }));
  }
  function injectWith(patch: Record<string, unknown>): string {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    configure(root, patch);
    return inject(root);
  }

  test("a lagging install gets exactly one line naming both versions and the fix", () => {
    const ctx = injectWith({ vendored_version: "0.3.2", clone_root: fakeClone("0.5.0") });
    expect(ctx).toContain("_Note: crank-mem hooks are at 0.3.2, clone is at 0.5.0 — run `crank-mem upgrade`._");
    expect((ctx.match(/run `crank-mem upgrade`/g) ?? []).length).toBe(1);
  });

  test("matching versions produce no line", () => {
    expect(injectWith({ vendored_version: "0.5.0", clone_root: fakeClone("0.5.0") }))
      .not.toContain("crank-mem upgrade");
  });

  test("a missing, moved, or unreadable clone produces no line and no error", () => {
    const gone = fakeClone("0.5.0");
    fs.rmSync(gone, { recursive: true, force: true });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "crank-clone-")); // no package.json
    const malformed = fs.mkdtempSync(path.join(os.tmpdir(), "crank-clone-"));
    fs.writeFileSync(path.join(malformed, "package.json"), "{not json");

    for (const clone_root of [gone, empty, malformed, ""]) {
      const root = makeCrankProject({ "a.ts": "const a = 1;" });
      configure(root, { vendored_version: "0.3.2", clone_root });
      const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
      expect(run.status).toBe(0);
      const ctx = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain("crank-mem (project memory)");
      expect(ctx).not.toContain("crank-mem upgrade");
    }
  });

  test("a package.json with no version string produces no line", () => {
    expect(injectWith({ vendored_version: "0.3.2", clone_root: fakeClone(5) }))
      .not.toContain("crank-mem upgrade");
  });
});

const JOURNAL_HEADER = "# Journal\n\nSession log, newest last.\n\n";

function writeJournal(root: string, bullets: string[]): string {
  const file = path.join(root, ".crank/journal.md");
  fs.writeFileSync(file, JOURNAL_HEADER + bullets.map((b) => `- ${b}`).join("\n") + "\n");
  return file;
}
function inject(root: string): string {
  const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
}

describe("journal (black-box)", () => {
  test("injects the last three bullets, oldest first, ahead of the cerebrum", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n\n- Always use tabs\n"
    );
    writeJournal(root, ["day 1: one", "day 2: two", "day 3: three", "day 4: four"]);

    const ctx = inject(root);
    expect(ctx).toContain("## Journal (recent — .crank/journal.md)");
    expect(ctx).not.toContain("day 1: one"); // only the last three
    expect(ctx.indexOf("day 2: two")).toBeLessThan(ctx.indexOf("day 3: three"));
    expect(ctx.indexOf("day 3: three")).toBeLessThan(ctx.indexOf("day 4: four"));
    expect(ctx.indexOf("day 4: four")).toBeLessThan(ctx.indexOf("## Cerebrum"));
  });

  // brew-pg 2026-09-23: with only the handoff injected, the agent told the
  // user that the critique recorded in the same entry had never been run.
  test("each entry's done-clause reaches the model; only the newest NEXT: does", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    writeJournal(root, [
      "2026-09-21: wired the rails; NEXT: run impeccable critique.",
      "2026-09-22: impeccable critique (30/40); NEXT: fix the contrast findings.",
      "2026-09-23: fixed contrast; NEXT: Chris smoke-checks rails.",
    ]);

    const ctx = inject(root);
    expect(ctx).toContain("- 2026-09-21 — wired the rails\n");
    expect(ctx).toContain("- 2026-09-22 — impeccable critique (30/40)\n");
    expect(ctx).toContain("- 2026-09-23 — fixed contrast; NEXT: Chris smoke-checks rails.");
    expect(ctx).not.toContain("run impeccable critique");
    expect(ctx).not.toContain("fix the contrast findings");
  });

  test("no journal file: section omitted, everything else injects", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const ctx = inject(root);
    expect(ctx).not.toContain("## Journal");
    expect(ctx).toContain("`.crank/anatomy.md` indexes 1 file(s)");
  });

  test("seeded but empty journal: section omitted", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.writeFileSync(path.join(root, ".crank/journal.md"), JOURNAL_HEADER);
    expect(inject(root)).not.toContain("## Journal");
  });

  test("trims to the last 20 bullets, preserving the header and the mtime", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const file = writeJournal(root, Array.from({ length: 25 }, (_, i) => `entry ${i}`));
    const before = fs.statSync(file).mtimeMs;

    inject(root);

    const after = fs.readFileSync(file, "utf-8");
    expect(after).toContain("# Journal");
    expect((after.match(/^- /gm) ?? []).length).toBe(20);
    expect(after).toContain("- entry 5");
    expect(after).not.toContain("- entry 4");
    // A trim is housekeeping, not a new entry: the nudge's staleness signal
    // keys on this mtime and must survive the rewrite exactly, sub-millisecond
    // part included.
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  // The journal is added before the cerebrum excerpt, so a sprawling entry
  // must not be able to spend the budget the cerebrum needs.
  test("sprawling entries are capped, leaving room for the cerebrum and ADRs", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n\n- Always use tabs\n"
    );
    fs.mkdirSync(path.join(root, "docs/adr"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/adr/0001-use-tabs.md"), "# x");
    writeJournal(root, ["day 1: one", "day 2: two", `day 3: ${"x".repeat(4000)}; NEXT: ${"y".repeat(4000)}`]);

    const ctx = inject(root);
    expect(ctx).toContain("## Journal");
    expect(ctx).toContain("Always use tabs");
    expect(ctx).toContain("0001-use-tabs.md");
    // The long entry survives as a capped headline, not verbatim: what it did
    // and its handoff, each cut short. "- " plus the 360-byte newest-entry cap.
    expect(ctx).toContain("…; NEXT: yyy");
    expect(ctx.split("\n").every((l) => Buffer.byteLength(l, "utf-8") <= 362)).toBe(true);
  });

  // The cap is spent in the same unit as the injection budget, so a non-ASCII
  // journal cannot cost 3× an ASCII one.
  test("the headline cap is bytes, and never splits a character", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    writeJournal(root, [`2026-07-29: ${"中".repeat(2000)}`, `2026-07-30: x; NEXT: ${"🚀".repeat(2000)}`]);

    const bullets = inject(root)
      .split("\n")
      .filter((l) => l.startsWith("- 2026-07-"));
    expect(bullets.length).toBe(2);
    // "- <date> — " (17B) plus the older (160B) and newest (360B) entry caps.
    expect(Buffer.byteLength(bullets[0]!, "utf-8")).toBeLessThanOrEqual(177);
    expect(Buffer.byteLength(bullets[1]!, "utf-8")).toBeLessThanOrEqual(377);
    for (const b of bullets) expect(b).not.toContain("�"); // no lone surrogate half
    expect(bullets[1]).toContain("x; NEXT: 🚀"); // what the entry did rides along
    expect(bullets[1]).toContain("🚀…"); // the capped NEXT: clause ends mid-stream
  });

  test("a budget too tight for the journal drops it whole, keeping the instructions", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const configPath = path.join(root, ".crank/config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    // Just above the instructions block, which is exempt from the budget:
    // enough for the journal to be considered and rejected.
    fs.writeFileSync(configPath, JSON.stringify({ ...config, injection_budget_bytes: 1800 }));
    writeJournal(root, Array.from({ length: 3 }, (_, i) => `day ${i}: ${"x".repeat(200)}`));

    const ctx = inject(root);
    expect(ctx).not.toContain("## Journal");
    expect(ctx).toContain("crank-mem (project memory)");
  });

  test("sub-bullets and prose ride along with their entry through a trim", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const file = path.join(root, ".crank/journal.md");
    const entries = Array.from(
      { length: 25 },
      (_, i) => `- day ${i}: headline\n  - sub detail ${i}\n\n  wrapped prose ${i}\n`
    ).join("");
    fs.writeFileSync(file, JOURNAL_HEADER + entries);

    const ctx = inject(root);
    // Only top-level bullets count as entries — the last three, each folded
    // into one headline that carries its continuation.
    expect(ctx).toContain("- day 24: headline - sub detail 24 wrapped prose 24");
    expect(ctx).toContain("- day 22: headline");
    expect(ctx).not.toContain("day 21"); // the fourth-newest entry is not injected

    const after = fs.readFileSync(file, "utf-8");
    expect((after.match(/^- day /gm) ?? []).length).toBe(20);
    expect(after).toContain("  - sub detail 24"); // indentation preserved
    expect(after).toContain("  wrapped prose 24"); // interleaved prose preserved
    expect(after).not.toContain("day 4:");
  });

  // compact fires mid-turn: the unlocked rewrite could clobber an entry the
  // agent is appending, so it injects without trimming.
  test("a compact session start injects but does not rewrite the journal", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const file = writeJournal(root, Array.from({ length: 25 }, (_, i) => `entry ${i}`));
    const before = fs.readFileSync(file, "utf-8");

    const run = runHook(
      HOOK,
      JSON.stringify({ ...claudeSessionStart(root), source: "compact" })
    );
    expect(run.status).toBe(0);
    const ctx = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("- entry 24");
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });

  test("unreadable journal (a directory): exit 0, section omitted", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.mkdirSync(path.join(root, ".crank/journal.md"));
    expect(inject(root)).not.toContain("## Journal");
  });
});

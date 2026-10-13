import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, enableDebugConfig, git, gitCommit, makeCrankProject, readDebugLog, runHook } from "./helpers.ts";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
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
    expect(ctx).toContain("That is every indexable file in the project.");
    expect(ctx).not.toContain("`app.ts`");
    // index + anatomy.md were written
    const index = JSON.parse(fs.readFileSync(path.join(root, ".crank/anatomy-index.json"), "utf-8"));
    expect(index.meta.fileCount).toBe(2);
    expect(fs.existsSync(path.join(root, ".crank/anatomy.md"))).toBe(true);
  });

  test("in a git repo the refresh skips gitignored files and records truncation", () => {
    const root = makeCrankProject({
      ".gitignore": "reports/\n",
      "reports/mutation.html": "<html>huge</html>",
      "a.ts": "x",
      "b.ts": "x",
      "c.ts": "x",
    });
    git(root, "init", "-q");
    saveConfig(path.join(root, ".crank"), { ...defaultConfig(), max_files: 2 });
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    expect(run.status).toBe(0);
    const index = JSON.parse(fs.readFileSync(path.join(root, ".crank/anatomy-index.json"), "utf-8"));
    expect(Object.keys(index.files).sort()).toEqual(["a.ts", "b.ts"]);
    expect(index.meta.truncated).toBe(true);
    expect(index.meta.candidateCount).toBe(3);
    // The pointer states the cap instead of claiming the whole project.
    const ctx: string = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("`.crank/anatomy.md` indexes 2 of 3 file(s)");
    expect(ctx).toContain("It is capped at max_files, active files first, then first-party source:");
    expect(ctx).toContain("a file missing from it may still exist.");
    expect(ctx).not.toContain("every indexable file");
  });

  test("outside git a capped index says the walk went by path and gives no total", () => {
    const root = makeCrankProject({ "a.ts": "x", "b.ts": "x", "c.ts": "x" });
    saveConfig(path.join(root, ".crank"), { ...defaultConfig(), max_files: 1 });
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    expect(run.status).toBe(0);
    const ctx: string = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("`.crank/anatomy.md` indexes 1 file(s)");
    expect(ctx).toContain("It is capped at max_files, active files first, then by path:");
  });

  test("the pointer names indexed languages without symbol support, and wording follows the agent", () => {
    const root = makeCrankProject({ "main.c": "int main(void) { return 0; }\n", "util.h": "int f(void);\n", "a.ts": "x" });
    const ctxFor = (payload: object): string => {
      const run = runHook(HOOK, JSON.stringify(payload));
      expect(run.status).toBe(0);
      return JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    };
    const codex = ctxFor(codexSessionStart(root));
    expect(codex).toContain("(no symbol ranges for .c, .h files)");
    // Codex has no Read tool and reads AGENTS.md (ADR 0003).
    expect(codex).toContain("file (`sed -n 'START,ENDp' file`).");
    expect(codex).not.toContain("offset/limit");
    expect(codex).toContain("Do NOT record: anything AGENTS.md, the README");
    expect(codex).not.toContain("CLAUDE.md");
    const claude = ctxFor(claudeSessionStart(root));
    expect(claude).toContain("Read with offset/limit, or `sed -n 'START,ENDp' file`");
    expect(claude).toContain("Do NOT record: anything CLAUDE.md, AGENTS.md, the README");
  });

  test("the most committed file stays indexed past max_files across session starts and a scan", () => {
    const root = makeCrankProject({ "a.ts": "x", "b.ts": "x", "z/hot.ts": "/** Hot path. */\n" });
    git(root, "init", "-q");
    gitCommit(root, "one");
    for (const n of [2, 3]) {
      fs.appendFileSync(path.join(root, "z/hot.ts"), `export const v${n} = ${n};\n`);
      gitCommit(root, `hot ${n}`);
    }
    saveConfig(path.join(root, ".crank"), { ...defaultConfig(), max_files: 2 });
    const indexed = (): string[] =>
      Object.keys(JSON.parse(fs.readFileSync(path.join(root, ".crank/anatomy-index.json"), "utf-8")).files);
    for (let i = 0; i < 2; i++) {
      expect(runHook(HOOK, JSON.stringify(claudeSessionStart(root))).status).toBe(0);
      expect(indexed()).toContain("z/hot.ts");
    }
    const scan = spawnSync("bun", [path.join(REPO_ROOT, "src/cli/main.ts"), "scan"], { cwd: root, encoding: "utf-8" });
    expect(scan.status).toBe(0);
    expect(indexed()).toContain("z/hot.ts");
    const anatomy = fs.readFileSync(path.join(root, ".crank/anatomy.md"), "utf-8");
    expect(anatomy).toContain("## Most active files\n\n- `z/hot.ts` — Hot path.");
  });

  test("a .git that git rejects falls back to the directory walk and logs why", () => {
    const root = makeCrankProject({ ".gitignore": "reports/\n", "reports/r.html": "x", "a.ts": "x" });
    fs.writeFileSync(path.join(root, ".git"), "not a gitdir pointer\n");
    enableDebugConfig(root);
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    expect(run.status).toBe(0);
    const index = JSON.parse(fs.readFileSync(path.join(root, ".crank/anatomy-index.json"), "utf-8"));
    expect(Object.keys(index.files).sort()).toEqual(["a.ts", "reports/r.html"]);
    const events = readDebugLog(root).flatMap((r) => r.events);
    expect(events.find((e) => e.event === "walk-fallback")?.reason).toMatch(/^exit \d+$/);
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

  // 5 of 8 file:line citations in audited cerebrums had drifted, and few
  // bullets carried a date to judge them by.
  test("the protocol asks for a date and path citations, and says memory is not proof", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    expect(run.status).toBe(0);
    const ctx: string = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("End each cerebrum bullet with its date, `(YYYY-MM-DD)`");
    expect(ctx).toContain("cite code by\n  backticked repo path and symbol name, not by line number");
    expect(ctx).toContain(
      "Memory is not proof of current behavior; verify a consequential claim\n  against the cited file before relying on it."
    );
  });
});

describe("cited files (black-box)", () => {
  const day = (iso: string): Date => new Date(`${iso}T12:00:00`);

  // A takeoff-poc bullet cited `tools/attribute.py` after commit 0f97e4a
  // retired it, and 5 of 8 audited citations pointed at drifted code.
  test("a bullet citing a deleted path or a file changed after its date is tagged", () => {
    const root = makeCrankProject({
      "src/geometry.py": "def area(): pass\n",
      "src/stable.py": "def keep(): pass\n",
    });
    fs.utimesSync(path.join(root, "src/geometry.py"), day("2026-03-01"), day("2026-03-01"));
    fs.utimesSync(path.join(root, "src/stable.py"), day("2026-01-01"), day("2026-01-01"));
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## Memory\n\n" +
        "- **Faces**: `tools/attribute.py` splits faces (2026-01-05).\n" +
        "- **Area**: `geometry.py:834` clamps negative area (2026-01-05).\n" +
        "- **Keep**: `src/stable.py` is the entry (2026-02-01).\n" +
        "- **Undated**: `src/geometry.py` owns area.\n" +
        "- **Noise**: `--force`, `~/notes/x.py`, `src/*.py`, `fs.statSync`, `nothere.py` (2026-01-05).\n"
    );

    const ctx = inject(root);
    expect(ctx).toContain(
      "- **Faces**: `tools/attribute.py` splits faces (2026-01-05). [cited file missing: tools/attribute.py]"
    );
    expect(ctx).toContain(
      "- **Area**: `geometry.py:834` clamps negative area (2026-01-05). " +
        "[cited file modified after this note; check: geometry.py]"
    );
    expect(ctx).toContain("- **Keep**: `src/stable.py` is the entry (2026-02-01).\n");
    expect(ctx).toContain("- **Undated**: `src/geometry.py` owns area.\n");
    expect(ctx).toEndWith("`nothere.py` (2026-01-05).");
    expect((ctx.match(/\[cited file/g) ?? []).length).toBe(2);
  });
});

describe("cerebrum index (black-box)", () => {
  // Shaped after OrcaSlicer's Sep 30 injection: 7 preferences (~555 tokens,
  // over PREFS_TOKEN_CAP), 21 memory bullets, a ~415-byte journal and an ADR
  // list. It used 7,963 of 8,192 bytes and named none of the bullets it hid.
  test("an OrcaSlicer-sized cerebrum stays under budget and names what it hides", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const clause = "`Support.cpp` caps pillar reach at 3.7 mm, so retries from the head fail ";
    const bullet = (subject: string, i: number, clauses: number): string =>
      `- **${subject} ${i}**: ${clause.repeat(clauses).trim()} (2026-09-${10 + i}).`;
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n" +
        Array.from({ length: 7 }, (_, i) => bullet("Pref", i, 4)).join("\n") +
        "\n\n## Memory\n" +
        Array.from({ length: 21 }, (_, i) => bullet("Gotcha", i, 5)).join("\n") +
        "\n"
    );
    fs.writeFileSync(
      path.join(root, ".crank/journal.md"),
      "# Journal\n\n" +
        Array.from({ length: 3 }, (_, i) => `- 2026-09-2${i + 7}: ${"tuned the scaffold planner ".repeat(4)}; NEXT: rerun bench`).join("\n") +
        "\n"
    );
    fs.mkdirSync(path.join(root, "docs/adr"), { recursive: true });
    for (const f of ["0001-scaffold-points.md", "0002-pad-solid.md", "0003-tilt-cap.md"]) {
      fs.writeFileSync(path.join(root, "docs/adr", f), "# x");
    }

    const ctx = inject(root);
    expect(Buffer.byteLength(ctx, "utf-8")).toBeLessThanOrEqual(8192);
    expect(ctx).toContain("## ADRs");
    expect(ctx).toContain("- **Gotcha 20**:"); // the newest memory bullet, whole
    expect(ctx).toMatch(/^### Not shown \(\d+ of 28; grep \.crank\/cerebrum\.md\)$/m);
    expect(ctx).toMatch(/^prefs: \d of 7 shown, consolidate$/m);
    expect(ctx).toContain("- **Pref 0**: `Support.cpp` caps pillar reach at…");
    expect(ctx).toMatch(/^- \*\*Gotcha 13\*\*: .*…$/m); // the newest hidden one
  });

  // OrcaSlicer's Oct 13 cerebrum: memory bullets of 300 to 870 bytes filled the
  // excerpt, and none of the 16 hidden memory bullets was named.
  test("memory bullets long enough to fill the excerpt still leave the hidden ones named", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const clause = "`Support.cpp` caps pillar reach at 3.7 mm, so retries from the head fail ";
    const bullet = (subject: string, i: number, clauses: number): string =>
      `- **${subject} ${i}**: ${clause.repeat(clauses).trim()} (2026-09-${10 + i}).`;
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n" +
        Array.from({ length: 7 }, (_, i) => bullet("Pref", i, 4)).join("\n") +
        "\n\n## Memory\n" +
        Array.from({ length: 21 }, (_, i) => bullet("Gotcha", i, 9)).join("\n") +
        "\n"
    );

    const ctx = inject(root);
    expect(Buffer.byteLength(ctx, "utf-8")).toBeLessThanOrEqual(8192);
    expect(ctx).toContain("- **Gotcha 20**:");
    expect(ctx).toMatch(/^- \*\*Gotcha 16\*\*: .*…$/m); // the newest hidden one
    expect(ctx.match(/^- \*\*Gotcha \d+\*\*: .*…$/gm)?.length).toBeGreaterThanOrEqual(10);
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

  test("states how many files changed since the last entry, counting Bash-made files", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const journal = writeJournal(root, ["2026-09-23: fixed contrast; NEXT: smoke-check rails."]);
    git(root, "init", "-q");
    gitCommit(root, "init");
    const hourAgo = new Date(Date.now() - 3_600_000);
    for (const f of [journal, path.join(root, "a.ts")]) fs.utimesSync(f, hourAgo, hourAgo);
    expect(inject(root)).toContain("smoke-check rails.\n0 file(s) changed since the last journal entry.");

    // Written outside any hook, as a Bash `cp` or `sed -i` would.
    fs.writeFileSync(path.join(root, "b.ts"), "x");
    fs.writeFileSync(path.join(root, "a.ts"), "const a = 2;");
    expect(inject(root)).toContain("2 file(s) changed since the last journal entry.");
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

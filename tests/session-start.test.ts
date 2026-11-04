import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  REPO_ROOT, enableDebugConfig, git, gitCommit, makeCrankHome, makeCrankProject, plantMemory, readDebugLog, runHook, seedMemory,
  spoolEntry, stopDigests,
} from "./helpers.ts";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { RECALL_BULLET } from "../src/hooks/lib/injection.ts";
import { MEMORY_NEWER_NOTE, formatLine, memoryPath, openMemory } from "../src/hooks/lib/memory.ts";
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
    expect(codex).not.toContain("CLAUDE.md");
    const claude = ctxFor(claudeSessionStart(root));
    expect(claude).toContain("Read with offset/limit, or `sed -n 'START,ENDp' file`");
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

  test("a git repo with no commits skips churn and logs why", () => {
    const root = makeCrankProject({ "a.ts": "x" });
    git(root, "init", "-q");
    enableDebugConfig(root);
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    expect(run.status).toBe(0);
    const events = readDebugLog(root).flatMap((r) => r.events);
    expect(events.find((e) => e.event === "churn-skipped")?.reason).toMatch(/^exit \d+$/);
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
  test("a wrapped cerebrum bullet survives the trip", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n\n- Always use tabs\n\n## Memory\n\n" +
        "- The blur dies when the container gets `position: fixed` or above a\n" +
        "  z-index of 10 — it becomes a backdrop root, killing the overlay blur.\n"
    );
    const ctx = inject(root);
    expect(ctx).toContain(
      "- The blur dies when the container gets `position: fixed` or above a\n" +
        "  z-index of 10 — it becomes a backdrop root, killing the overlay blur."
    );
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

  test("the instructions say memory is not proof", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    expect(run.status).toBe(0);
    const ctx: string = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(
      "Memory is not proof of current behavior; verify a consequential claim\n  against the cited file before relying on it."
    );
  });
});

describe("cited files (black-box)", () => {
  const day = (iso: string): Date => new Date(`${iso}T12:00:00`);

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
  // Without upkeep protocols the default 8,192 bytes leave the excerpt under
  // the token cap alone, so these tests shrink the budget until bytes bind.
  const BUDGET = 5632;
  const setBudget = (root: string): void => {
    const configPath = path.join(root, ".crank/config.json");
    fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(configPath, "utf-8")), injection_budget_bytes: BUDGET }));
  };

  // 7 preferences over PREFS_TOKEN_CAP, 21 memory bullets and an ADR list
  // overflow the budget, so the excerpt must hide bullets and name every one it hides.
  test("a cerebrum too big for the budget stays under it and names the bullets it hides", () => {
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
    fs.mkdirSync(path.join(root, "docs/adr"), { recursive: true });
    for (const f of ["0001-scaffold-points.md", "0002-pad-solid.md", "0003-tilt-cap.md"]) {
      fs.writeFileSync(path.join(root, "docs/adr", f), "# x");
    }
    setBudget(root);

    const ctx = inject(root);
    expect(Buffer.byteLength(ctx, "utf-8")).toBeLessThanOrEqual(BUDGET);
    expect(ctx).toContain("## ADRs");
    expect(ctx).toContain("- **Gotcha 20**:"); // the newest memory bullet, whole
    expect(ctx).toMatch(/^### Not shown \(\d+ of 28; grep \.crank\/cerebrum\.md\)$/m);
    expect(ctx).toContain("- **Pref 0**: `Support.cpp` caps pillar reach at…");
    expect(ctx).toMatch(/^- \*\*Gotcha 15\*\*: .*…$/m); // the newest hidden one
  });

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
    setBudget(root);

    const ctx = inject(root);
    expect(Buffer.byteLength(ctx, "utf-8")).toBeLessThanOrEqual(BUDGET);
    expect(ctx).toContain("- **Gotcha 20**:");
    expect(ctx).toMatch(/^- \*\*Gotcha 17\*\*: .*…$/m); // the newest hidden one
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

// Digest-era injection. Every run passes one temp CRANK_HOME per project, so a
// planted stop file or spool entry is the one the hook reads.
const PAST_WORK = "- Past work: `crank-mem search <query>`";
const NOTE_STOPPED =
  "_Note: crank-mem digests stopped (login): run `crank-mem digest resume` once that is fixed._";
const NOTE_WAITED =
  "_Note: crank-mem: a session here has waited over 2 hours for its digest; see `crank-mem stats`._";

function memoryProject(digest: boolean): { root: string; home: string } {
  const root = makeCrankProject({ "a.ts": "const a = 1;" });
  saveConfig(path.join(root, ".crank"), { ...defaultConfig(), digest });
  fs.writeFileSync(
    path.join(root, ".crank/cerebrum.md"),
    "# Cerebrum\n\n## User Preferences\n\n- Always use tabs\n\n## Memory\n\n- **Fact**: a memory bullet\n"
  );
  return { root, home: makeCrankHome() };
}
function injectIn(root: string, home: string, payload: object = claudeSessionStart(root)): string {
  const run = runHook(HOOK, JSON.stringify(payload), root, { CRANK_HOME: home, TZ: "UTC" });
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
}
function sectionOf(ctx: string, heading: string): string | undefined {
  return ctx.split("\n\n").find((s) => s.startsWith(heading));
}
let seeded = 0;
/** n observations with distinct 60-character titles (the store dedupes on content). */
const titled = (n: number) =>
  Array.from({ length: n }, () => ({ title: `T${String(seeded++).padStart(4, "0")} ${"t".repeat(54)}` }));
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("digests running (black-box)", () => {
  test("the instructions drop every upkeep protocol and still point at past work", () => {
    const { root, home } = memoryProject(true);
    writeJournal(root, ["2026-07-01: did a thing; NEXT: other thing"]);
    const ctx = injectIn(root, home);
    for (const upkeep of ["Cerebrum protocol", "Journal protocol", "telegram-style", "agent-maintained"]) {
      expect(ctx).not.toContain(upkeep);
    }
    expect(ctx).toContain(
      "This project keeps a token-annotated file index in `.crank/anatomy.md` and\nproject memory in `.crank/cerebrum.md`."
    );
    expect(ctx).toContain("- Memory is not proof of current behavior");
    expect(ctx).toContain("- ADR protocol:");
    // No store yet: the bullet still names the commands digests will feed.
    expect(count(ctx, RECALL_BULLET)).toBe(1);
    expect(ctx).not.toContain("## Journal");
    expect(ctx).not.toContain("## Recent memory");
  });

  test("the excerpt labels name the sections, with no editing hints", () => {
    const { root, home } = memoryProject(true);
    const prefs = Array.from({ length: 40 }, (_, i) => `- pref ${i} ${"p".repeat(80)}`).join("\n");
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      `# Cerebrum\n\n## User Preferences\n\n${prefs}\n\n## Memory\n\n- **Fact**: a memory bullet\n`
    );
    const ctx = injectIn(root, home);
    expect(ctx).toContain("### User Preferences\n");
    expect(ctx).toContain("### Memory\n");
    expect(ctx).toContain("### Not shown (");
    expect(ctx).not.toContain("append at its end");
    expect(ctx).not.toContain("consolidate");
  });

  test("next steps come from the newest digest, only when short and not none", () => {
    const { root, home } = memoryProject(true);
    seedMemory(root, titled(2), { nextSteps: "Wire the daemon." });
    expect(injectIn(root, home)).toContain("## Next steps (last digested session)\nWire the daemon.");
    // A spool entry for this project means its last session is not digested yet.
    spoolEntry(home, "pending", root, Date.now());
    expect(injectIn(root, home)).not.toContain("## Next steps");
    fs.rmSync(path.join(home, "spool", "pending.json"));
    spoolEntry(home, "elsewhere", "/elsewhere", Date.now());
    expect(injectIn(root, home)).toContain("## Next steps (last digested session)\nWire the daemon.");
    seedMemory(root, titled(1), { nextSteps: "None." });
    expect(injectIn(root, home)).not.toContain("## Next steps");
    seedMemory(root, titled(1), { nextSteps: "n".repeat(600) });
    expect(injectIn(root, home)).not.toContain("## Next steps");
  });

  test("recent memory lists whole lines, newest first, under its byte cap", () => {
    const { root, home } = memoryProject(true);
    // An open store with no rows: no section, but the bullet.
    const empty = openMemory(memoryPath(root), "write");
    if (empty.status === "open") empty.memory.close();
    const before = injectIn(root, home);
    expect(before).not.toContain("## Recent memory");
    expect(count(before, RECALL_BULLET)).toBe(1);

    seedMemory(root, titled(60));
    const section = sectionOf(injectIn(root, home), "## Recent memory\n")!;
    expect(Buffer.byteLength(section, "utf-8")).toBeLessThanOrEqual(1536);
    const opened = openMemory(memoryPath(root), "read");
    if (opened.status !== "open") throw new Error(opened.status);
    const all = opened.memory.recent(60).map(formatLine);
    opened.memory.close();
    const lines = section.split("\n").slice(1);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).toEqual(all.slice(0, lines.length));
    // Whole lines are dropped only while needed: one more would overflow.
    expect(Buffer.byteLength([section, all[lines.length]].join("\n"), "utf-8")).toBeGreaterThan(1536);
  });

  test("the whole injection stays in budget, and a tiny budget keeps only the instructions", () => {
    const { root, home } = memoryProject(true);
    seedMemory(root, titled(60), { nextSteps: "Wire the daemon." });
    writeJournal(root, ["2026-07-01: a", "2026-07-02: b", "2026-07-03: c"]);
    const bullets = Array.from({ length: 40 }, (_, i) => `- **Fact ${i}**: ${"m".repeat(120)} (2026-07-01)`).join("\n");
    fs.writeFileSync(path.join(root, ".crank/cerebrum.md"), `# Cerebrum\n\n## User Preferences\n\n## Memory\n\n${bullets}\n`);
    expect(Buffer.byteLength(injectIn(root, home), "utf-8")).toBeLessThanOrEqual(8192);

    const configPath = path.join(root, ".crank/config.json");
    fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(configPath, "utf-8")), injection_budget_bytes: 100 }));
    const ctx = injectIn(root, home);
    expect(ctx.startsWith("## crank-mem (project memory)\n\n")).toBe(true);
    expect(ctx.endsWith("Existing ADRs are settled — don't relitigate them.")).toBe(true);
    expect(ctx.split("\n").filter((l) => l.startsWith("## "))).toEqual(["## crank-mem (project memory)"]);
    expect(count(ctx, RECALL_BULLET)).toBe(1);
  });

  test("next steps lead, then recent memory, then the cerebrum", () => {
    const { root, home } = memoryProject(true);
    seedMemory(root, titled(3), { nextSteps: "Wire the daemon." });
    const ctx = injectIn(root, home);
    const at = ["## Next steps (last digested session)", "## Recent memory", "## Cerebrum ("].map((h) => ctx.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("a newer store says to upgrade and shows no recall", () => {
    const { root, home } = memoryProject(true);
    plantMemory(root, "newer");
    const ctx = injectIn(root, home);
    expect(ctx).toContain(`_Note: ${MEMORY_NEWER_NOTE}_`);
    for (const absent of ["## Recent memory", "## Next steps", RECALL_BULLET]) expect(ctx).not.toContain(absent);
  });

  test("a store that is not a database injects without recall", () => {
    const { root, home } = memoryProject(true);
    plantMemory(root, "unreadable");
    const ctx = injectIn(root, home);
    for (const absent of ["## Recent memory", "## Next steps", PAST_WORK]) expect(ctx).not.toContain(absent);
  });

  test("a session waiting over 2 hours for its digest is noted, for this project only", () => {
    const { root, home } = memoryProject(true);
    writeJournal(root, ["2026-07-01: did a thing"]);
    seedMemory(root, titled(2), { nextSteps: "Wire the daemon." });
    const threeHoursAgo = Date.now() - 3 * 3_600_000;
    spoolEntry(home, "other", "/elsewhere", threeHoursAgo);
    spoolEntry(home, "fresh", root, Date.now());
    spoolEntry(home, "recent", root, Date.now() - 3_600_000);
    spoolEntry(home, "parked", root, threeHoursAgo, true);
    let ctx = injectIn(root, home);
    expect(ctx).not.toContain(NOTE_WAITED);
    expect(ctx).not.toContain("## Journal (recent");

    // A turn still running: the last Stop is old, but the transcript grows.
    const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crank-live-")), "live.jsonl");
    fs.writeFileSync(transcript, "{}\n");
    fs.writeFileSync(
      path.join(home, "spool", "live.json"),
      JSON.stringify({ transcriptPath: transcript, projectRoot: root, agent: "claude", ended: false, updatedAt: threeHoursAgo })
    );
    ctx = injectIn(root, home);
    expect(ctx).not.toContain(NOTE_WAITED);
    expect(ctx).not.toContain("## Journal (recent");

    spoolEntry(home, "old", root, threeHoursAgo);
    ctx = injectIn(root, home);
    expect(count(ctx, NOTE_WAITED)).toBe(1);
    expect(ctx).not.toContain("## Journal (recent");
    expect(ctx).not.toContain("## Next steps");
  });
});

// Every digest state injects the same instructions and labels: no state asks
// the agent to keep memory, and journal.md is never read.
const UPKEEP = [
  "Cerebrum protocol", "Journal protocol", "telegram-style", "append at its end", "consolidate",
  "## Journal", "agent-maintained", "session log", "journal.md",
];
const LEAD = "This project keeps a token-annotated file index in `.crank/anatomy.md` and\nproject memory in `.crank/cerebrum.md`.";

describe("no upkeep prompt in any digest state (black-box)", () => {
  const states: Array<{ name: string; setup: (root: string, home: string) => object; check?: (ctx: string) => void }> = [
    {
      name: "Claude, digests off",
      setup: (root) => {
        saveConfig(path.join(root, ".crank"), { ...defaultConfig(), digest: false });
        return claudeSessionStart(root);
      },
      check: (ctx) => {
        for (const kept of [RECALL_BULLET, "## Recent memory"]) expect(ctx).toContain(kept);
        expect(ctx).not.toContain("## Next steps");
      },
    },
    { name: "Claude, digests on", setup: (root) => claudeSessionStart(root) },
    {
      name: "Claude, digests on and stopped",
      setup: (root, home) => {
        stopDigests(home);
        return claudeSessionStart(root);
      },
      check: (ctx) => {
        expect(ctx.split("\n").filter((l) => l === NOTE_STOPPED)).toHaveLength(1);
        const at = [NOTE_STOPPED, "## Recent memory", "## Cerebrum (", "## ADRs ("].map((h) => ctx.indexOf(h));
        expect(at.every((i) => i >= 0)).toBe(true);
        expect([...at].sort((a, b) => a - b)).toEqual(at);
      },
    },
    {
      name: "Claude, digests on with a session waiting over 2 hours",
      setup: (root, home) => {
        spoolEntry(home, "old", root, Date.now() - 3 * 3_600_000);
        return claudeSessionStart(root);
      },
      check: (ctx) => expect(count(ctx, NOTE_WAITED)).toBe(1),
    },
    { name: "Codex, digests on", setup: (root) => codexSessionStart(root) },
  ];

  for (const { name, setup, check } of states) {
    test(name, () => {
      const { root, home } = memoryProject(true);
      fs.writeFileSync(path.join(root, ".crank/cerebrum.md"), "# Cerebrum\n\n## Memory\n\n- **Fact**: a memory bullet\n");
      writeJournal(root, ["2026-07-01: one", "2026-07-02: two", "2026-07-03: three; NEXT: four"]);
      seedMemory(root, titled(3), { nextSteps: "Wire the daemon." });
      fs.mkdirSync(path.join(root, "docs/adr"), { recursive: true });
      fs.writeFileSync(path.join(root, "docs/adr/0001-x.md"), "# x");
      const ctx = injectIn(root, home, setup(root, home));
      for (const upkeep of UPKEEP) expect(ctx).not.toContain(upkeep);
      for (const kept of [LEAD, "Memory is not proof", "ADR protocol:", "## Cerebrum (.crank/cerebrum.md)\n### Memory\n"]) {
        expect(ctx).toContain(kept);
      }
      check?.(ctx);
    });
  }

  test("a Codex session shows the capture notes", () => {
    const { root, home } = memoryProject(true);
    spoolEntry(home, "old", root, Date.now() - 3 * 3_600_000);
    stopDigests(home);
    const noted = injectIn(root, home, codexSessionStart(root));
    expect(count(noted, NOTE_WAITED)).toBe(1);
    expect(noted.split("\n").filter((l) => l === NOTE_STOPPED)).toHaveLength(1);
  });

  test("session start leaves journal.md unread", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const file = writeJournal(
      root,
      Array.from({ length: 60 }, (_, i) => `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, "0")}: entry ${i}`)
    );
    const bytes = fs.readFileSync(file);
    const mtimeMs = fs.statSync(file).mtimeMs;
    const run = runHook(HOOK, JSON.stringify({ ...claudeSessionStart(root), source: "startup" }));
    expect(run.status).toBe(0);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeMs);
  });
});

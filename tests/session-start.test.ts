import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  REPO_ROOT,
  enableDebugConfig,
  fakeCloneRoot,
  hookContext,
  killDaemon,
  makeCrankHome,
  makeCrankProject,
  plantCodeDb,
  plantMemory,
  readDaemon,
  readDebugLog,
  runCli,
  runHook,
  seedMemory,
  spoolEntry,
  stopDigests,
  tempDir,
  withReadOnlyCodeDb,
} from "./helpers.ts";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { CODE_BULLET, RECALL_BULLET, SUBAGENT_BULLET } from "../src/hooks/lib/injection.ts";
import { openStoreForWrite } from "../src/hooks/lib/memory.ts";
import { STORE_TEXT } from "../src/hooks/lib/wire.ts";
import { claudeSessionStart, claudeSubagentStart, codexSessionStart } from "./fixtures/payloads.ts";
import { workspace } from "./workspace.ts";

const HOOK = "src/hooks/session-start.ts";

/** Merge `patch` over the project's .crank/config.json. */
function configure(root: string, patch: Record<string, unknown>): void {
  const file = path.join(root, ".crank/config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf-8"));
  fs.writeFileSync(file, JSON.stringify({ ...config, ...patch }));
}

describe("session-start hook (black-box)", () => {
  test("Claude payload: exit 0, injects context, refreshes code.db", () => {
    const root = makeCrankProject({
      "src/app.ts": "/** App entry. */\nexport const app = 1;\n",
      "README.md": "# Demo project\n",
    });
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    const ctx = hookContext(run, "SessionStart");
    expect(ctx).toContain("crank-mem (project memory)");
    // The scan's result reaches the model as a count and a pointer, not a listing.
    expect(ctx).toContain("`crank-mem anatomy [<dir>]` lists the project's 2 file(s) with");
    expect(ctx).not.toContain("`app.ts`");
    // Every language here has a grammar, so the pointer carries no gap clause.
    expect(ctx).not.toContain("no symbol ranges");
    // code.db was written, and no anatomy file with it
    expect(fs.existsSync(path.join(root, ".crank/code.db"))).toBe(true);
    // A read-only store makes `anatomy` answer without refreshing, so what it lists was written by the hook.
    const listing = withReadOnlyCodeDb(root, () => runCli(root, ["anatomy"]));
    expect(listing.status).toBe(0);
    expect([...listing.stdout.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1])).toEqual([
      "README.md",
      "src/app.ts",
    ]);
    expect(
      fs.readdirSync(path.join(root, ".crank")).filter((n) => n.startsWith("anatomy")),
    ).toEqual([]);
    // Debug logging is off by default.
    expect(fs.existsSync(path.join(root, ".crank/debug.log"))).toBe(false);
  });

  test("the pointer names source languages with no grammar, says what is still parsing, and reads the same for both agents", () => {
    const root = makeCrankProject({
      "a.lua": "local a = 1\n",
      "b.lua": "local b = 2\n",
      "c.dart": "void main() {}\n",
      "main.c": "int main(void) { return 0; }\n",
      "a.ts": "x",
    });
    const codex = hookContext(runHook(HOOK, JSON.stringify(codexSessionStart(root))));
    const claude = hookContext(runHook(HOOK, JSON.stringify(claudeSessionStart(root))));
    // The code pointer follows the anatomy pointer, and the subagent line sits between it and the
    // proof bullet, for both agents.
    for (const ctx of [codex, claude]) {
      const pointer = ctx.split("\n").find((l) => l.startsWith("- `crank-mem anatomy [<dir>]`"))!;
      expect(pointer).toContain("lists the project's 5 file(s)");
      expect(pointer).toContain("(symbols for 2 files are still being parsed)");
      expect(pointer).toContain("(no symbol ranges for .lua, .dart files)");
      expect(count(ctx, SUBAGENT_BULLET)).toBe(1);
      expect(
        count(ctx, `${pointer}\n${CODE_BULLET}\n${SUBAGENT_BULLET}\n- Memory is not proof`),
      ).toBe(1);
      expect(ctx).not.toContain("offset/limit");
    }
  });

  test("a code.db that does not open drops the count and both clauses from the pointer", () => {
    const root = makeCrankProject({ "a.lua": "x", "b.ts": "x" });
    fs.writeFileSync(path.join(root, ".crank/code.db"), "not a database");
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    const ctx = hookContext(run);
    expect(ctx).toContain(
      "- `crank-mem anatomy [<dir>]` lists the project's files with descriptions, token sizes and symbol line ranges; use it before slice-reading a large file.\n",
    );
    expect(ctx).not.toContain("file(s)");
  });

  test("a .git that git rejects falls back to the directory walk and logs why", () => {
    const root = makeCrankProject({
      ".gitignore": "reports/\n",
      "reports/r.html": "x",
      "a.ts": "x",
    });
    fs.writeFileSync(path.join(root, ".git"), "not a gitdir pointer\n");
    enableDebugConfig(root);
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
    const ctx = hookContext(run);
    expect(ctx).toContain("lists the project's 2 file(s)");
    const events = readDebugLog(root).flatMap((r) => r.events);
    expect(events.find((e) => e.event === "walk-fallback")?.reason).toMatch(/^exit \d+$/);
  });

  test("no .crank/ dir: exit 0, silent stdout", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "crank-bare-"));
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(bare)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("garbage or empty stdin: exit 0, silent", () => {
    for (const stdin of ["{{{not json", ""]) {
      const run = runHook(HOOK, stdin);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
    }
  });
});

describe("memory reaches the model whole (black-box)", () => {
  test("a wrapped cerebrum bullet survives the trip", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n\n- Always use tabs\n\n## Memory\n\n" +
        "- The blur dies when the container gets `position: fixed` or above a\n" +
        "  z-index of 10 — it becomes a backdrop root, killing the overlay blur.\n",
    );
    const ctx = inject(root);
    expect(ctx).toContain(
      "- The blur dies when the container gets `position: fixed` or above a\n" +
        "  z-index of 10 — it becomes a backdrop root, killing the overlay blur.",
    );
    expect(ctx).toContain("Always use tabs");
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
        "- **Noise**: `--force`, `~/notes/x.py`, `src/*.py`, `fs.statSync`, `nothere.py` (2026-01-05).\n",
    );

    const ctx = inject(root);
    expect(ctx).toContain(
      "- **Faces**: `tools/attribute.py` splits faces (2026-01-05). [cited file missing: tools/attribute.py]",
    );
    expect(ctx).toContain(
      "- **Area**: `geometry.py:834` clamps negative area (2026-01-05). " +
        "[cited file modified after this note; check: geometry.py]",
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
        "\n",
    );
    fs.mkdirSync(path.join(root, "docs/adr"), { recursive: true });
    for (const f of ["0001-scaffold-points.md", "0002-pad-solid.md", "0003-tilt-cap.md"]) {
      fs.writeFileSync(path.join(root, "docs/adr", f), "# x");
    }
    configure(root, { injection_budget_bytes: BUDGET });

    const ctx = inject(root);
    expect(Buffer.byteLength(ctx, "utf-8")).toBeLessThanOrEqual(BUDGET);
    expect(ctx).toContain("## ADRs");
    expect(ctx).toContain("- **Gotcha 20**:"); // the newest memory bullet, whole
    expect(ctx).toMatch(/^### Not shown \(\d+ of 28; grep \.crank\/cerebrum\.md\)$/m);
    expect(ctx).toContain("- **Pref 0**: `Support.cpp` caps pillar reach at…");
    expect(ctx).toMatch(/^- \*\*Gotcha 15\*\*: .*…$/m); // the newest hidden one

    // Memory bullets long enough to fill the excerpt alone still leave the hidden ones named.
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      "# Cerebrum\n\n## User Preferences\n" +
        Array.from({ length: 7 }, (_, i) => bullet("Pref", i, 4)).join("\n") +
        "\n\n## Memory\n" +
        Array.from({ length: 21 }, (_, i) => bullet("Gotcha", i, 9)).join("\n") +
        "\n",
    );
    const long = inject(root);
    expect(Buffer.byteLength(long, "utf-8")).toBeLessThanOrEqual(BUDGET);
    expect(long).toContain("- **Gotcha 20**:");
    expect(long).toMatch(/^- \*\*Gotcha 17\*\*: .*…$/m); // the newest hidden one
    expect(long.match(/^- \*\*Gotcha \d+\*\*: .*…$/gm)?.length).toBeGreaterThanOrEqual(10);
  });
});

describe("vendored-hook drift (black-box)", () => {
  /** A stand-in clone: just the package.json the drift check reads. */
  function fakeClone(version: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crank-clone-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "crank-mem", version }),
    );
    return dir;
  }
  function injectWith(patch: Record<string, unknown>): string {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    configure(root, patch);
    return inject(root);
  }

  test("a lagging install gets exactly one line naming both versions and the fix", () => {
    const ctx = injectWith({ vendored_version: "0.3.2", clone_root: fakeClone("0.5.0") });
    expect(ctx).toContain(
      "_Note: crank-mem hooks are at 0.3.2, crank-mem is at 0.5.0 — run `crank-mem upgrade`._",
    );
    expect((ctx.match(/run `crank-mem upgrade`/g) ?? []).length).toBe(1);
    // Matching versions produce no line.
    expect(injectWith({ vendored_version: "0.5.0", clone_root: fakeClone("0.5.0") })).not.toContain(
      "crank-mem upgrade",
    );
  });

  test("a missing, moved, unreadable or versionless clone produces no line and no error", () => {
    const gone = fakeClone("0.5.0");
    fs.rmSync(gone, { recursive: true, force: true });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "crank-clone-")); // no package.json
    const malformed = fs.mkdtempSync(path.join(os.tmpdir(), "crank-clone-"));
    fs.writeFileSync(path.join(malformed, "package.json"), "{not json");

    const noVersion = fakeClone(5); // a package.json with no version string
    for (const clone_root of [gone, empty, malformed, noVersion, ""]) {
      const root = makeCrankProject({ "a.ts": "const a = 1;" });
      configure(root, { vendored_version: "0.3.2", clone_root });
      const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)));
      const ctx = hookContext(run);
      expect(ctx).toContain("crank-mem (project memory)");
      expect(ctx).not.toContain("crank-mem upgrade");
    }
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
  return hookContext(run);
}

// Digest-era injection. Every run passes one temp CRANK_HOME per project, so a
// planted stop file or spool entry is the one the hook reads.
const NOTE_STOPPED =
  "_Note: crank-mem digests stopped (login): run `crank-mem digest resume` once that is fixed._";
const NOTE_WAITED =
  "_Note: crank-mem: a session here has waited over 2 hours for its digest; see `crank-mem stats`._";

function memoryProject(digest: boolean): { root: string; home: string } {
  const root = makeCrankProject({ "a.ts": "const a = 1;" });
  saveConfig(path.join(root, ".crank"), { ...defaultConfig(), digest });
  fs.writeFileSync(
    path.join(root, ".crank/cerebrum.md"),
    "# Cerebrum\n\n## User Preferences\n\n- Always use tabs\n\n## Memory\n\n- **Fact**: a memory bullet\n",
  );
  return { root, home: makeCrankHome() };
}
function injectIn(root: string, home: string, payload: object = claudeSessionStart(root)): string {
  const run = runHook(HOOK, JSON.stringify(payload), root, { CRANK_HOME: home, TZ: "UTC" });
  return hookContext(run);
}
function sectionOf(ctx: string, heading: string): string | undefined {
  return ctx.split("\n\n").find((s) => s.startsWith(heading));
}
let seeded = 0;
/** n observations with distinct 60-character titles (the store dedupes on content). */
const titled = (n: number) =>
  Array.from({ length: n }, () => ({
    title: `T${String(seeded++).padStart(4, "0")} ${"t".repeat(54)}`,
  }));
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("digests running (black-box)", () => {
  test("next steps come from the newest digest, only when short and not none", () => {
    const { root, home } = memoryProject(true);
    seedMemory(root, titled(2), { nextSteps: "Wire the daemon." });
    const ctx = injectIn(root, home);
    expect(sectionOf(ctx, "## Next steps (last digested session)\n")).toBe(
      "## Next steps (last digested session)\nWire the daemon.",
    );
    // A spool entry for this project means its last session is not digested yet.
    spoolEntry(home, "pending", root, Date.now());
    expect(injectIn(root, home)).not.toContain("## Next steps");
    fs.rmSync(path.join(home, "spool", "pending.json"));
    spoolEntry(home, "elsewhere", "/elsewhere", Date.now());
    expect(injectIn(root, home)).toContain(
      "## Next steps (last digested session)\nWire the daemon.",
    );
    seedMemory(root, titled(1), { nextSteps: "None." });
    expect(injectIn(root, home)).not.toContain("## Next steps");
    seedMemory(root, titled(1), { nextSteps: "n".repeat(600) });
    expect(injectIn(root, home)).not.toContain("## Next steps");
  });

  test("recent memory lists whole lines, newest first, under its byte cap", () => {
    const { root, home } = memoryProject(true);
    // An open store with no rows: no section, but the bullet.
    const empty = openStoreForWrite(root);
    if (empty.status === "open") empty.memory.close();
    const before = injectIn(root, home);
    expect(before).not.toContain("## Recent memory");
    expect(count(before, RECALL_BULLET)).toBe(1);
    expect(before.indexOf(CODE_BULLET)).toBeLessThan(before.indexOf(RECALL_BULLET));
    expect(
      count(before, `${CODE_BULLET}\n${RECALL_BULLET}\n${SUBAGENT_BULLET}\n- Memory is not proof`),
    ).toBe(1);

    seedMemory(root, titled(60));
    const section = sectionOf(
      injectIn(root, home),
      "## Recent memory (open one: `crank-mem get <id>`)\n",
    )!;
    expect(Buffer.byteLength(section, "utf-8")).toBeLessThanOrEqual(1536);
    const lines = section.split("\n").slice(1);
    expect(lines.length).toBeGreaterThan(0);
    // Newest first: the last seeded title leads, and each next title is one older.
    lines.forEach((line, i) => {
      const title = `T${String(seeded - 1 - i).padStart(4, "0")} ${"t".repeat(54)}`;
      expect(line).toMatch(new RegExp(`^#\\d+ \\d{4}-\\d\\d-\\d\\d discovery ${title}$`));
    });
    // Whole lines are dropped only while needed: one more line of the same width would overflow.
    expect(Buffer.byteLength(section, "utf-8") + 1 + Buffer.byteLength(lines[0]!)).toBeGreaterThan(
      1536,
    );
  });

  test("a Codex SessionStart with an open store carries the recall pointer and recent memory", () => {
    const { root, home } = memoryProject(true);
    seedMemory(root, titled(3));
    const ctx = injectIn(root, home, codexSessionStart(root));
    expect(count(ctx, RECALL_BULLET)).toBe(1);
    const section = sectionOf(ctx, "## Recent memory (open one: `crank-mem get <id>`)\n");
    expect(section).toBeDefined();
    expect(section!.split("\n").slice(1)).toHaveLength(3);
  });

  test("recent memory leaves out a stale row", () => {
    const { root, home } = memoryProject(true);
    const [a] = seedMemory(root, [
      { title: "Lock retry is two seconds" },
      { title: "Lock files live in .crank" },
    ]) as [number];
    seedMemory(root, [], { stale: [{ id: a, reason: "retry is 5 s now" }] });
    const section = sectionOf(
      injectIn(root, home),
      "## Recent memory (open one: `crank-mem get <id>`)\n",
    )!;
    expect(section).toMatch(/\n#\d+ \S+ discovery Lock files live in \.crank(\n|$)/);
    expect(section).not.toContain("Lock retry is two seconds");
  });

  test("the whole injection stays in budget, and a tiny budget keeps only the instructions", () => {
    const { root, home } = memoryProject(true);
    seedMemory(root, titled(60), { nextSteps: "Wire the daemon." });
    writeJournal(root, ["2026-07-01: a", "2026-07-02: b", "2026-07-03: c"]);
    const bullets = Array.from(
      { length: 40 },
      (_, i) => `- **Fact ${i}**: ${"m".repeat(120)} (2026-07-01)`,
    ).join("\n");
    fs.writeFileSync(
      path.join(root, ".crank/cerebrum.md"),
      `# Cerebrum\n\n## User Preferences\n\n## Memory\n\n${bullets}\n`,
    );
    expect(Buffer.byteLength(injectIn(root, home), "utf-8")).toBeLessThanOrEqual(8192);

    configure(root, { injection_budget_bytes: 100 });
    const ctx = injectIn(root, home);
    expect(ctx.startsWith("## crank-mem (project memory)\n\n")).toBe(true);
    expect(ctx.endsWith("Existing ADRs are settled — don't relitigate them.")).toBe(true);
    expect(ctx.split("\n").filter((l) => l.startsWith("## "))).toEqual([
      "## crank-mem (project memory)",
    ]);
    expect(count(ctx, RECALL_BULLET)).toBe(1);
    expect(ctx.indexOf(CODE_BULLET)).toBeGreaterThan(-1);
    expect(ctx.indexOf(CODE_BULLET)).toBeLessThan(ctx.indexOf(RECALL_BULLET));
  });

  test("a newer store says to upgrade and shows no recall", () => {
    const { root, home } = memoryProject(true);
    plantMemory(root, "newer");
    const ctx = injectIn(root, home);
    expect(ctx).toContain(`_Note: ${STORE_TEXT.newer.note}_`);
    for (const absent of ["## Recent memory", "## Next steps", RECALL_BULLET])
      expect(ctx).not.toContain(absent);
  });

  test("a store that is not a database, or whose queries throw after it opens, injects without recall", () => {
    const { root, home } = memoryProject(true);
    plantMemory(root, "unreadable");
    const notADatabase = injectIn(root, home);
    fs.rmSync(path.join(root, ".crank/memory.db"));
    plantMemory(root, "broken");
    const queriesThrow = injectIn(root, home);
    for (const ctx of [notADatabase, queriesThrow])
      for (const absent of ["## Recent memory", "## Next steps", RECALL_BULLET])
        expect(ctx).not.toContain(absent);
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
    const transcript = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "crank-live-")),
      "live.jsonl",
    );
    fs.writeFileSync(transcript, "{}\n");
    fs.writeFileSync(
      path.join(home, "spool", "live.json"),
      JSON.stringify({
        transcriptPath: transcript,
        projectRoot: root,
        agent: "claude",
        ended: false,
        updatedAt: threeHoursAgo,
      }),
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

// Every digest state injects the same labels: no state asks the agent to keep memory, and
// journal.md is never read.
describe("no upkeep prompt in any digest state (black-box)", () => {
  const states: Array<{
    name: string;
    setup: (root: string, home: string) => object;
    check?: (ctx: string) => void;
  }> = [
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
    {
      name: "Claude, digests on",
      setup: (root) => claudeSessionStart(root),
      check: (ctx) => {
        const at = [
          "## Next steps (last digested session)",
          "## Recent memory",
          "## Cerebrum (",
        ].map((h) => ctx.indexOf(h));
        expect(at.every((i) => i >= 0)).toBe(true);
        expect([...at].sort((a, b) => a - b)).toEqual(at);
      },
    },
    {
      name: "Claude, digests on and stopped",
      setup: (root, home) => {
        stopDigests(home);
        return claudeSessionStart(root);
      },
      check: (ctx) => {
        expect(ctx.split("\n").filter((l) => l === NOTE_STOPPED)).toHaveLength(1);
        const at = [NOTE_STOPPED, "## Recent memory", "## Cerebrum (", "## ADRs ("].map((h) =>
          ctx.indexOf(h),
        );
        expect(at.every((i) => i >= 0)).toBe(true);
        expect([...at].sort((a, b) => a - b)).toEqual(at);
      },
    },
  ];

  for (const { name, setup, check } of states) {
    test(name, () => {
      const { root, home } = memoryProject(true);
      fs.writeFileSync(
        path.join(root, ".crank/cerebrum.md"),
        "# Cerebrum\n\n## Memory\n\n- **Fact**: a memory bullet\n",
      );
      const journal = writeJournal(root, [
        "2026-07-01: one",
        "2026-07-02: two",
        "2026-07-03: three; NEXT: four",
      ]);
      const journalBytes = fs.readFileSync(journal);
      const journalMtimeMs = fs.statSync(journal).mtimeMs;
      seedMemory(root, titled(3), { nextSteps: "Wire the daemon." });
      fs.mkdirSync(path.join(root, "docs/adr"), { recursive: true });
      fs.writeFileSync(path.join(root, "docs/adr/0001-x.md"), "# x");
      const ctx = injectIn(root, home, setup(root, home));
      for (const kept of ["## Cerebrum (.crank/cerebrum.md)\n### Memory\n", "0001-x.md"]) {
        expect(ctx).toContain(kept);
      }
      // Session start leaves journal.md unread.
      expect(fs.readFileSync(journal).equals(journalBytes)).toBe(true);
      expect(fs.statSync(journal).mtimeMs).toBe(journalMtimeMs);
      check?.(ctx);
    });
  }
});

describe("project registry (black-box)", () => {
  test("starts through a symlink and the real path list the project's realpath once", () => {
    const home = makeCrankHome();
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crank-link-")), "proj");
    fs.symlinkSync(root, link);
    for (const cwd of [link, root, root]) {
      const run = runHook(HOOK, JSON.stringify(claudeSessionStart(cwd)), cwd, { CRANK_HOME: home });
      expect(run.status).toBe(0);
    }
    const registry = JSON.parse(fs.readFileSync(path.join(home, "projects.json"), "utf-8"));
    expect(registry.projects.map((p: { root: string }) => p.root)).toEqual([fs.realpathSync(root)]);
  });

  test("an unwritable crank home leaves the injection whole", () => {
    const home = path.join(makeCrankHome(), "not-a-dir");
    fs.writeFileSync(home, "");
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    const run = runHook(HOOK, JSON.stringify(claudeSessionStart(root)), root, { CRANK_HOME: home });
    expect(hookContext(run)).toContain("crank-mem");
  });
});

describe("linked projects (black-box)", () => {
  test("linked projects are named after the recall pointer", () => {
    const ws = workspace();
    seedMemory(ws.H, [], { links: ["storefront", "ghost", "payments-api"] });
    const ctx = injectIn(ws.H, ws.home);
    expect(
      count(
        ctx,
        `${RECALL_BULLET}\n- Search also covers linked projects: payments-api, storefront.\n${SUBAGENT_BULLET}\n- Memory is not proof`,
      ),
    ).toBe(1);
    // SubagentStart gains neither line.
    const sub = runHook(
      "src/hooks/subagent-start.ts",
      JSON.stringify(claudeSubagentStart(ws.H, "Explore")),
      ws.H,
      { CRANK_HOME: ws.home },
    );
    const subCtx = hookContext(sub);
    expect(subCtx).toContain(RECALL_BULLET);
    expect(subCtx).not.toContain("Search also covers");
    expect(subCtx).not.toContain(SUBAGENT_BULLET);

    // A renamed project's link stops resolving; once none resolves, the plain recall bullet.
    const rename = (root: string, name: string) =>
      saveConfig(path.join(root, ".crank"), { ...defaultConfig(), digest: true, name });
    rename(ws.storefront, "shop");
    expect(
      count(
        injectIn(ws.H, ws.home),
        `${RECALL_BULLET}\n- Search also covers linked projects: payments-api.\n${SUBAGENT_BULLET}\n- Memory is not proof`,
      ),
    ).toBe(1);
    rename(ws.payments, "pay");
    const plain = injectIn(ws.H, ws.home);
    expect(count(plain, `${RECALL_BULLET}\n${SUBAGENT_BULLET}\n- Memory is not proof`)).toBe(1);
    expect(plain).not.toContain("Search also covers");
  });

  test("a bullet citing a linked project's file reads that project's code.db", () => {
    const ws = workspace();
    seedMemory(ws.H, [], { links: ["payments-api"] });
    injectIn(ws.payments, ws.home);
    const bullet = "- **Pay**: see `payments-api/src/a.ts` (2020-01-01).";
    fs.appendFileSync(path.join(ws.H, ".crank/cerebrum.md"), `${bullet}\n`);
    const linkedIndex = path.join(ws.payments, ".crank/code.db");
    const before = fs.readFileSync(linkedIndex);

    const ctx = injectIn(ws.H, ws.home);
    expect(ctx).toContain(
      `${bullet} [cited file modified after this note; check: payments-api/src/a.ts]`,
    );
    expect(ctx).not.toContain("[cited file missing");
    expect(fs.readFileSync(linkedIndex).equals(before)).toBe(true);
  });
});

describe("session-start writes code.db", () => {
  const sessionStart = (root: string, env: Record<string, string> = {}) =>
    runHook(HOOK, JSON.stringify(claudeSessionStart(root)), undefined, env);
  const graphEvents = (root: string) =>
    readDebugLog(root)
      .flatMap((r) => r.events)
      .filter((e) => String(e.event).startsWith("graph"));
  /** A fresh crank home, so a daemon an earlier run started cannot satisfy this run's `ensureDaemon`. */
  const freshHome = () => {
    const home = makeCrankHome();
    return { home, env: { CRANK_HOME: home } };
  };
  const startsDaemon = async (home: string): Promise<boolean> => {
    for (let waited = 0; waited < 5000; waited += 100) {
      if (typeof readDaemon(home)?.heartbeatMs === "number") return true;
      await Bun.sleep(100);
    }
    return false;
  };

  test("a code.db held for 3 s costs the hook no more than its budget and one graph line", async () => {
    const root = makeCrankProject({ "a.ts": "export const a = 1;\n" });
    enableDebugConfig(root);
    expect(sessionStart(root).status).toBe(0);
    const ready = path.join(tempDir("crank-holder-"), "ready");
    const holder = spawn(
      process.execPath,
      [path.join(REPO_ROOT, "tests/fixtures/graph-holder.ts"), root, "3000", ready],
      { stdio: "ignore" },
    );
    try {
      for (let waited = 0; !fs.existsSync(ready) && waited < 5000; waited += 20)
        await Bun.sleep(20);
      expect(fs.existsSync(ready)).toBe(true);
      const logged = readDebugLog(root).length;
      const started = Date.now();
      const run = sessionStart(root);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(hookContext(run)).not.toMatch(/locked|busy|errcode|SQLITE/i);
      const events = readDebugLog(root)
        .slice(logged)
        .flatMap((r) => r.events);
      expect(events.filter((e) => String(e.event).startsWith("graph"))).toHaveLength(1);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  test("a code.db at another schema version is left byte-identical", () => {
    const root = makeCrankProject({ "a.ts": "export const a = 1;\n" });
    enableDebugConfig(root);
    const file = path.join(root, ".crank/code.db");
    plantCodeDb(root, "newer");
    const before = fs.readFileSync(file);
    expect(sessionStart(root).status).toBe(0);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    const events = graphEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "graph-skip", status: "rebuild" });
  });

  test("a pending file starts the daemon with digests off, and a stop state keeps it down", async () => {
    const root = makeCrankProject({ "a.ts": "export const a = 1;\n" });
    saveConfig(path.join(root, ".crank"), { ...defaultConfig(), clone_root: REPO_ROOT });
    const started = freshHome();
    try {
      expect(sessionStart(root, started.env).status).toBe(0);
      expect(await startsDaemon(started.home)).toBe(true);
    } finally {
      killDaemon(started.home);
    }

    // A daemon that starts under a stop state exits without a trace, so a recording clone_root stands in.
    const fake = fakeCloneRoot();
    saveConfig(path.join(root, ".crank"), { ...defaultConfig(), clone_root: fake.root });
    const stopped = freshHome();
    stopDigests(stopped.home);
    expect(sessionStart(root, stopped.env).status).toBe(0);
    await Bun.sleep(1500);
    expect(fake.starts()).toBe(0);
    expect(readDaemon(stopped.home)).toBeNull();
  });
});

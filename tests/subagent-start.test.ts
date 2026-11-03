import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeCrankHome, makeCrankProject, runHook, seedMemory } from "./helpers.ts";
import { claudeSubagentStart } from "./fixtures/payloads.ts";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { INJECTION_HEADING, RECALL_BULLET } from "../src/hooks/lib/injection.ts";

const HOOK = "src/hooks/subagent-start.ts";

function writeCerebrum(root: string, prefs: string[], memory: string[]): void {
  fs.writeFileSync(
    path.join(root, ".crank/cerebrum.md"),
    `# Cerebrum\n\n## User Preferences\n${prefs.join("\n")}\n\n## Memory\n${memory.join("\n")}\n`,
  );
}

// One temp CRANK_HOME for every run, so no run reads the real ~/.crank.
const HOME = makeCrankHome();

function setDigest(root: string, digest: boolean): void {
  saveConfig(path.join(root, ".crank"), { ...defaultConfig(), digest });
}

function context(root: string): string {
  const run = runHook(HOOK, JSON.stringify(claudeSubagentStart(root, "Explore")), undefined, { CRANK_HOME: HOME });
  expect(run.status).toBe(0);
  const out = JSON.parse(run.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe("SubagentStart");
  return out.hookSpecificOutput.additionalContext;
}

describe("subagent-start hook (black-box)", () => {
  test("injects the cerebrum excerpt and points at cerebrum.md and journal.md", () => {
    const root = makeCrankProject({ "src/app.ts": "export const app = 1;\n" });
    writeCerebrum(
      root,
      ["- **Tabs**: user wants tabs, not spaces (2026-10-01)."],
      ["- **Build**: `make -j8` OOMs on CI; use `-j4` (2026-10-02)."],
    );
    const ctx = context(root);
    expect(ctx).toContain("## crank-mem (project memory)");
    expect(ctx).toContain("- Excerpt of `.crank/cerebrum.md`");
    expect(ctx).toContain("- Where the last session left off: `.crank/journal.md`.");
    expect(ctx).toContain("- **Tabs**: user wants tabs");
    expect(ctx).toContain("- **Build**: `make -j8` OOMs on CI");
    // Read-only: a subagent spawn does not refresh the index.
    expect(fs.existsSync(path.join(root, ".crank/anatomy-index.json"))).toBe(false);

    // Digests off with a readable store: the same text gains the recall pointer.
    expect(ctx).not.toContain(RECALL_BULLET);
    seedMemory(root, [{ title: "a stored observation" }]);
    const journalLine = "- Where the last session left off: `.crank/journal.md`.";
    expect(context(root)).toBe(ctx.replace(journalLine, `${journalLine}\n${RECALL_BULLET}`));
  });

  // At 2 KB the session-start order, preferences before memory, leaves no room
  // for a memory bullet, so the subagent excerpt splits the budget.
  test("a cerebrum over 2 KB is cut to an excerpt that keeps a gotcha and says what it hides", () => {
    const root = makeCrankProject();
    const clause = "`Support.cpp` caps pillar reach at 3.7 mm, so retries from the head fail ";
    const bullet = (subject: string, i: number): string =>
      `- **${subject} ${i}**: ${clause.repeat(4).trim()} (2026-09-${10 + i}).`;
    writeCerebrum(
      root,
      Array.from({ length: 7 }, (_, i) => bullet("Pref", i)),
      Array.from({ length: 21 }, (_, i) => bullet("Gotcha", i)),
    );
    const ctx = context(root);
    const excerpt = ctx.slice(ctx.indexOf("## Cerebrum"));
    expect(Buffer.byteLength(excerpt, "utf-8")).toBeLessThanOrEqual(2048);
    expect(ctx).toContain("- **Pref 6**:"); // the newest preference, whole
    expect(ctx).toContain("- **Gotcha 20**:"); // the newest memory bullet, whole
    expect(ctx).toMatch(/^### Not shown \(\d+ of 28; grep \.crank\/cerebrum\.md\)$/m);

    // Digests running keep the excerpt, drop the upkeep pointers, and add recall.
    setDigest(root, true);
    const running = context(root);
    for (const kept of ["this project's memory;", RECALL_BULLET, "### Memory\n"]) expect(running).toContain(kept);
    for (const dropped of ["journal.md", "agent-kept", "append at its end"]) expect(running).not.toContain(dropped);
    const runningExcerpt = running.slice(running.indexOf("\n\n") + 2);
    expect(Buffer.byteLength(runningExcerpt, "utf-8")).toBeLessThanOrEqual(2048);
  });

  test("tags a cited file that no longer exists", () => {
    const root = makeCrankProject();
    writeCerebrum(root, [], ["- **Loader**: `src/old/loader.ts` retries twice (2026-10-01)."]);
    expect(context(root)).toContain("[cited file missing: src/old/loader.ts]");
  });

  test("stays silent with exit 0 when there is nothing to inject", () => {
    // The template cerebrum holds headings and no bullets.
    const fresh = makeCrankProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crank-none-"));
    const noCerebrum = makeCrankProject();
    fs.rmSync(path.join(noCerebrum, ".crank/cerebrum.md"));
    for (const root of [fresh, outside, noCerebrum]) {
      const run = runHook(HOOK, JSON.stringify(claudeSubagentStart(root)), undefined, { CRANK_HOME: HOME });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
    }
    const garbage = runHook(HOOK, "not json", undefined, { CRANK_HOME: HOME });
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe("");

    // No excerpt, but recall applies: the heading and the pointer alone.
    seedMemory(noCerebrum, [{ title: "a stored observation" }]);
    expect(context(noCerebrum)).toBe(`${INJECTION_HEADING}\n${RECALL_BULLET}`);
  });
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeCrankProject, runHook } from "./helpers.ts";
import { claudeSubagentStart } from "./fixtures/payloads.ts";

const HOOK = "src/hooks/subagent-start.ts";

function writeCerebrum(root: string, prefs: string[], memory: string[]): void {
  fs.writeFileSync(
    path.join(root, ".crank/cerebrum.md"),
    `# Cerebrum\n\n## User Preferences\n${prefs.join("\n")}\n\n## Memory\n${memory.join("\n")}\n`,
  );
}

function context(root: string): string {
  const run = runHook(HOOK, JSON.stringify(claudeSubagentStart(root, "Explore")));
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
  });

  // At 2 KB the excerpt's own priority holds: user preferences outrank memory,
  // so a preference-heavy file can leave no memory bullets, only the grep line.
  test("an OrcaSlicer-sized cerebrum is cut to a 2 KB excerpt that says what it hides", () => {
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
    expect(ctx).toMatch(/^### Not shown \(\d+ of 28; grep \.crank\/cerebrum\.md\)$/m);
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
      const run = runHook(HOOK, JSON.stringify(claudeSubagentStart(root)));
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
    }
    const garbage = runHook(HOOK, "not json");
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe("");
  });
});

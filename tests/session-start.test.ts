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

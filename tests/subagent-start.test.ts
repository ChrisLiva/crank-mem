import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { makeCrankHome, makeCrankProject, runHook, seedMemory } from "./helpers.ts";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { CODE_BULLET, INJECTION_HEADING, RECALL_BULLET } from "../src/hooks/lib/injection.ts";
import { SCHEMA_VERSION } from "../src/hooks/lib/memory-schema.ts";
import { claudeSessionStart, claudeSubagentStart } from "./fixtures/payloads.ts";
import { workspace } from "./workspace.ts";

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
  const run = runHook(HOOK, JSON.stringify(claudeSubagentStart(root, "Explore")), undefined, {
    CRANK_HOME: HOME,
  });
  expect(run.status).toBe(0);
  const out = JSON.parse(run.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe("SubagentStart");
  return out.hookSpecificOutput.additionalContext;
}

describe("subagent-start hook (black-box)", () => {
  test("injects the cerebrum excerpt labelled by section, with recall only where it applies", () => {
    const root = makeCrankProject({ "src/app.ts": "export const app = 1;\n" });
    writeCerebrum(
      root,
      ["- **Tabs**: user wants tabs, not spaces (2026-10-01)."],
      [
        "- **Build**: `make -j8` OOMs on CI; use `-j4` (2026-10-02).",
        "- **Loader**: `src/old/loader.ts` retries twice (2026-10-01).",
      ],
    );
    const shape = (ctx: string): string[] => {
      const lines = ctx.split("\n");
      expect(lines[0]).toBe(INJECTION_HEADING);
      expect(lines[1]).toBe(
        "- Excerpt of `.crank/cerebrum.md`, this project's memory; grep it for more. Memory is not proof: verify a claim against the cited file before relying on it.",
      );
      expect(lines.filter((l) => l.startsWith("### "))).toEqual([
        "### User Preferences",
        "### Memory",
      ]);
      for (const dropped of ["journal.md", "agent-kept", "append at its end", "consolidate"])
        expect(ctx).not.toContain(dropped);
      expect(ctx).toContain("- **Tabs**: user wants tabs");
      expect(ctx).toContain("- **Build**: `make -j8` OOMs on CI");
      return lines;
    };

    // Digests off, no store: no recall pointer.
    const off = context(root);
    expect(shape(off)[2]).toBe(CODE_BULLET);
    expect(off).not.toContain(RECALL_BULLET);
    // A cited file that no longer exists is tagged.
    expect(off).toContain("[cited file missing: src/old/loader.ts]");
    // Read-only: a subagent spawn does not refresh the index.
    expect(fs.existsSync(path.join(root, ".crank/anatomy-index.json"))).toBe(false);

    // Digests on, no store: the recall pointer follows the code pointer.
    setDigest(root, true);
    const on = shape(context(root));
    expect(on[2]).toBe(CODE_BULLET);
    expect(on[3]).toBe(RECALL_BULLET);
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
    for (const kept of ["this project's memory;", RECALL_BULLET, "### Memory\n"])
      expect(running).toContain(kept);
    for (const dropped of ["journal.md", "agent-kept", "append at its end"])
      expect(running).not.toContain(dropped);
    const runningExcerpt = running.slice(running.indexOf("\n\n") + 2);
    expect(Buffer.byteLength(runningExcerpt, "utf-8")).toBeLessThanOrEqual(2048);
  });

  test("injects the code pointer wherever the project root is found, and stays silent outside one", () => {
    // The template cerebrum holds headings and no bullets.
    const fresh = makeCrankProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crank-none-"));
    const noCerebrum = makeCrankProject();
    fs.rmSync(path.join(noCerebrum, ".crank/cerebrum.md"));
    const dirCerebrum = makeCrankProject();
    fs.rmSync(path.join(dirCerebrum, ".crank/cerebrum.md"));
    fs.mkdirSync(path.join(dirCerebrum, ".crank/cerebrum.md")); // the read fails with EISDIR
    for (const root of [fresh, noCerebrum, dirCerebrum])
      expect(context(root)).toBe(`${INJECTION_HEADING}\n${CODE_BULLET}`);
    const none = runHook(HOOK, JSON.stringify(claudeSubagentStart(outside)), undefined, {
      CRANK_HOME: HOME,
    });
    expect(none.status).toBe(0);
    expect(none.stdout).toBe("");
    const garbage = runHook(HOOK, "not json", undefined, { CRANK_HOME: HOME });
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe("");

    // No excerpt, but recall applies: the heading and the two pointers alone.
    seedMemory(noCerebrum, [{ title: "a stored observation" }]);
    expect(context(noCerebrum)).toBe(`${INJECTION_HEADING}\n${CODE_BULLET}\n${RECALL_BULLET}`);
  });

  test("a bullet citing a linked project's file reads that project's anatomy", () => {
    const ws = workspace();
    seedMemory(ws.H, [], { links: ["payments-api"] });
    const env = { CRANK_HOME: ws.home };
    const start = runHook(
      "src/hooks/session-start.ts",
      JSON.stringify(claudeSessionStart(ws.payments)),
      ws.payments,
      env,
    );
    expect(start.status).toBe(0);
    const bullet = "- **Pay**: see `payments-api/src/a.ts` (2020-01-01).";
    fs.appendFileSync(path.join(ws.H, ".crank/cerebrum.md"), `${bullet}\n`);

    const run = runHook(HOOK, JSON.stringify(claudeSubagentStart(ws.H, "Explore")), ws.H, env);
    expect(run.status).toBe(0);
    const ctx: string = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(
      `${bullet} [cited file modified after this note; check: payments-api/src/a.ts]`,
    );
    expect(ctx).not.toContain("[cited file missing");
  });

  test("a store whose queries throw after it opens still prints the excerpt, its citations read at home", () => {
    const root = makeCrankProject({ "src/app.ts": "export const app = 1;\n" });
    const bullet = "- **Linked**: see `payments-api/src/a.ts`.";
    writeCerebrum(root, [], [bullet]);
    const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite;
    const db = new mod.DatabaseSync(path.join(root, ".crank/memory.db"));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.close();
    expect(context(root).split("\n")).toContain(
      `${bullet} [cited file missing: payments-api/src/a.ts]`,
    );
  });
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  makeCrankHome,
  makeCrankProject,
  runHook,
  setMtime,
  spoolFiles,
  stopDigests,
} from "./helpers.ts";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { claudeSessionStart, claudeStop } from "./fixtures/payloads.ts";

const HOOK = "src/hooks/stop.ts";

/** Build the initial index (records each file's mtime) as a real session would. */
function seedIndex(root: string): void {
  runHook("src/hooks/session-start.ts", JSON.stringify(claudeSessionStart(root)));
}
function cerebrum(root: string): string {
  return path.join(root, ".crank/cerebrum.md");
}

/** 25 source files: more change than a stale memory file ever needed to draw a reminder. */
const MANY = Object.fromEntries(
  Array.from({ length: 25 }, (_, i) => [`f${i}.ts`, `const x${i} = 1;`]),
);
// Any epoch well before the files were written: every indexed file is "changed".
const STALE = 1000;

describe("stop hook (black-box)", () => {
  test("stop_hook_active is respected (no stacking)", () => {
    const root = makeCrankProject(MANY);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root, true)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("no cerebrum.md: exit 0, silent", () => {
    const root = makeCrankProject(MANY);
    seedIndex(root);
    fs.rmSync(cerebrum(root));
    // A stale journal says nothing either.
    const journal = path.join(root, ".crank/journal.md");
    fs.writeFileSync(journal, "# Journal\n\n- 2026-07-01: earlier session\n");
    setMtime(journal, STALE);

    const run = runHook(HOOK, JSON.stringify(claudeStop(root)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("with digests on, writes the session's spool entry and emits nothing", () => {
    const root = makeCrankProject(MANY);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);
    saveConfig(path.join(root, ".crank"), { ...defaultConfig(), digest: true });
    const home = makeCrankHome();
    // Stopped digests start no daemon, and the signal is written all the same.
    stopDigests(home);
    const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crank-stop-")), "s1.jsonl");

    const run = runHook(
      HOOK,
      JSON.stringify({ ...claudeStop(root), transcript_path: transcript }),
      root,
      { CRANK_HOME: home },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(spoolFiles(home)).toEqual(["s1.json"]);
  });

  test("garbage stdin: exit 0", () => {
    expect(runHook(HOOK, "]]garbage").status).toBe(0);
  });

  test("empty stdin: exit 0", () => {
    expect(runHook(HOOK, "").status).toBe(0);
  });
});

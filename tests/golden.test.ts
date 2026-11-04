import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, makeCrankHome, makeCrankProject, runHook, setMtime } from "./helpers.ts";
import { claudeSessionStart, claudeStop, claudeSubagentStart } from "./fixtures/payloads.ts";

// Characterization: the stdout of session-start, subagent-start and stop on a fixed project,
// with no memory.db and digest off, must stay byte-identical to the golden files.

const GOLDEN = path.join(REPO_ROOT, "tests/fixtures/golden");

function goldenProject(): string {
  const files: Record<string, string> = {
    ".crank/journal.md": "- 2026-01-02: did a thing; NEXT: do the other thing\n",
  };
  for (let i = 0; i < 25; i++) files[`src/f${i}.ts`] = `export const a${i} = ${i};\n`;
  const root = makeCrankProject(files);
  fs.appendFileSync(path.join(root, ".crank/cerebrum.md"), "\n- **Sample**: a memory bullet (2026-01-02)\n");
  const yesterday = Date.now() - 86_400_000;
  setMtime(path.join(root, ".crank/cerebrum.md"), yesterday);
  setMtime(path.join(root, ".crank/journal.md"), yesterday);
  return root;
}

test("session-start, subagent-start and stop print their golden stdout", () => {
  const root = goldenProject();
  const runs: Array<[string, object]> = [
    ["session-start", claudeSessionStart(root)],
    ["subagent-start", claudeSubagentStart(root)],
    ["stop", claudeStop(root)],
  ];
  for (const [hook, payload] of runs) {
    const run = runHook(`src/hooks/${hook}.ts`, JSON.stringify(payload), root, { CRANK_HOME: makeCrankHome() });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(fs.readFileSync(path.join(GOLDEN, `${hook}.json`), "utf-8"));
  }
});

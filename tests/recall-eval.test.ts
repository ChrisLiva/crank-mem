import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { childEnv, initedCopy, REPO_ROOT, seedMemory, tempDir } from "./helpers.ts";

const SCRIPT = path.join(REPO_ROOT, "scripts/recall-eval.ts");
const FILES = {
  "src/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
  "src/b.ts": "export const b = 1;\n",
};

function evalRun(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: childEnv(),
    encoding: "utf-8",
  });
}

describe("recall-eval", () => {
  test("prints each query's recall@10 with and without the graph, then the means", () => {
    const root = initedCopy(FILES);
    seedMemory(root, [{ title: "kiwi fruit", narrative: "plain" }], { request: "kiwi" });
    seedMemory(
      root,
      [{ title: "Lock budget raised", narrative: "budget", filesModified: ["src/b.ts"] }],
      { request: "why did src/a.ts change" },
    );
    const [z] = seedMemory(root, [{ title: "zebra stripe", narrative: "plain" }], {
      request: "zebra",
    });
    seedMemory(root, [{ title: "mango ripe", narrative: "plain" }], {
      request: "mango",
      stale: [{ id: z!, reason: "gone" }],
    });
    seedMemory(
      root,
      Array.from({ length: 6 }, (_, i) => ({ title: `papaya ${i}`, narrative: "plain" })),
      { request: "papaya" },
    );
    const expected =
      "1 base@10 1.00 graph@10 1.00\n" +
      "2 base@10 0.00 graph@10 1.00\n" +
      "4 base@10 1.00 graph@10 1.00\n" +
      "5 base@10 1.00 graph@10 1.00\n" +
      "base recall@5 0.75 recall@10 0.75\n" +
      "graph recall@5 1.00 recall@10 1.00\n" +
      "lost 0 of 4 queries\n";
    for (const [cwd, args] of [
      [root, ["--root", root]],
      [path.join(root, "src"), []],
    ] as const) {
      const run = evalRun(cwd, [...args]);
      expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 0, stdout: expected });
    }
  });

  test("lost counts the queries whose graph top 10 drops a relevant id the baseline holds", () => {
    const root = initedCopy(FILES);
    seedMemory(
      root,
      Array.from({ length: 9 }, (_, i) => ({ title: `kiwi kiwi filler ${i}`, narrative: "plain" })),
      { request: "qqq" },
    );
    seedMemory(root, [{ title: "kiwi graph", narrative: "plain", filesModified: ["src/b.ts"] }], {
      request: "rrr",
    });
    seedMemory(root, [{ title: "kiwi target", narrative: "plain" }], { request: "src/a.ts kiwi" });
    const run = evalRun(root, ["--root", root]);
    expect({ status: run.status, stdout: run.stdout }).toEqual({
      status: 0,
      stdout:
        "1 base@10 0.00 graph@10 0.00\n" +
        "2 base@10 0.00 graph@10 0.00\n" +
        "3 base@10 1.00 graph@10 0.00\n" +
        "base recall@5 0.00 recall@10 0.33\n" +
        "graph recall@5 0.00 recall@10 0.00\n" +
        "lost 1 of 3 queries\n",
    });
  });

  test("writes nothing to the store, the anatomy or the usage log", () => {
    const root = initedCopy(FILES);
    seedMemory(root, [{ title: "kiwi fruit", narrative: "plain" }], { request: "kiwi" });
    const crank = path.join(root, ".crank");
    const read = (name: string) => {
      const file = path.join(crank, name);
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    };
    const names = ["memory.db", "anatomy-index.json", "usage.jsonl"];
    const before = names.map(read);
    expect(before[0]).not.toBeNull();
    expect(before[1]).not.toBeNull();
    expect(evalRun(root, ["--root", root]).status).toBe(0);
    expect(names.map(read)).toEqual(before);
  });

  test("answers each store state and a bad root", () => {
    const outcome = (run: ReturnType<typeof evalRun>) => ({
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
    });
    const missing = initedCopy();
    const db = path.join(missing, ".crank", "memory.db");
    fs.rmSync(db, { force: true });
    expect(outcome(evalRun(missing, ["--root", missing]))).toEqual({
      status: 0,
      stdout: "crank-mem: no memory exists yet.\n",
      stderr: "",
    });
    expect(fs.existsSync(db)).toBe(false);

    const unreadable = initedCopy();
    fs.writeFileSync(path.join(unreadable, ".crank", "memory.db"), "not a database");
    expect(outcome(evalRun(unreadable, ["--root", unreadable]))).toEqual({
      status: 1,
      stdout: "",
      stderr: "crank-mem: .crank/memory.db is not a readable database.\n",
    });

    const empty = initedCopy();
    seedMemory(empty, [], { request: "x" });
    expect(outcome(evalRun(empty, ["--root", empty]))).toEqual({
      status: 0,
      stdout: "no queries\n",
      stderr: "",
    });

    expect(outcome(evalRun(tempDir("crank-noproj-"), []))).toEqual({
      status: 1,
      stdout: "",
      stderr: "crank-mem: not initialized here — run `crank-mem init` first.\n",
    });

    expect(outcome(evalRun(empty, ["--root"]))).toEqual({
      status: 1,
      stdout: "",
      stderr: "recall-eval: usage: recall-eval.ts [--root <dir>]\n",
    });
  });
});

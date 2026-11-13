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
      "mode keyword\n" +
      "1 base@10 1.00 graph@10 1.00\n" +
      "2 base@10 0.00 graph@10 1.00\n" +
      "4 base@10 1.00 graph@10 1.00\n" +
      "5 base@10 1.00 graph@10 1.00\n" +
      "base recall@5 0.75 recall@10 0.75 mrr 0.75\n" +
      "graph recall@5 1.00 recall@10 1.00 mrr 1.00\n" +
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
        "mode keyword\n" +
        "1 base@10 0.00 graph@10 0.00\n" +
        "2 base@10 0.00 graph@10 0.00\n" +
        "3 base@10 1.00 graph@10 0.00\n" +
        "base recall@5 0.00 recall@10 0.33 mrr 0.03\n" +
        "graph recall@5 0.00 recall@10 0.00 mrr 0.00\n" +
        "lost 1 of 3 queries\n",
    });
  });

  test("replays a labelled set's questions, skipping stale and unknown ids", () => {
    const root = initedCopy(FILES);
    seedMemory(
      root,
      [
        { title: "kiwi fruit", narrative: "plain" },
        { title: "kiwi jam", narrative: "plain" },
      ],
      { request: "r1" },
    );
    const [zebra] = seedMemory(root, [{ title: "zebra stripe", narrative: "plain" }], {
      request: "r2",
    });
    seedMemory(root, [{ title: "mango ripe", narrative: "plain" }], {
      request: "r3",
      stale: [{ id: zebra!, reason: "gone" }],
    });
    fs.writeFileSync(
      path.join(root, "set.jsonl"),
      [
        '{"id": 1, "query": "kiwi"}',
        "   ",
        '{"id": 2, "query": "kiwi"}',
        '{"id": 2, "query": "melon"}',
        '{"id": 3, "query": "zebra"}',
        '{"id": 99, "query": "kiwi"}',
        '{"id": 1, "query": "kiwi fruit", "note": "other keys are ignored"}',
        '{"id": 2, "query": "kiwi jam"}',
      ].join("\n") + "\n",
    );
    const expected =
      "mode keyword\n" +
      "1 base@10 1.00 graph@10 1.00\n" +
      "2 base@10 1.00 graph@10 1.00\n" +
      "2 base@10 0.00 graph@10 0.00\n" +
      "1 base@10 1.00 graph@10 1.00\n" +
      "2 base@10 1.00 graph@10 1.00\n" +
      "base recall@5 0.80 recall@10 0.80 mrr 0.70\n" +
      "graph recall@5 0.80 recall@10 0.80 mrr 0.70\n" +
      "lost 0 of 5 queries\n" +
      "skipped 2 of 7 questions\n";
    for (const [cwd, args] of [
      [root, ["--root", root, "--set", "set.jsonl"]],
      [path.join(root, "src"), ["--set", "../set.jsonl"]],
    ] as const) {
      const run = evalRun(cwd, [...args]);
      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({
        status: 0,
        stdout: expected,
        stderr: "",
      });
    }
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
    const listing = () => fs.readdirSync(root, { recursive: true }).map(String).sort();
    const listed = listing();
    expect(before[0]).not.toBeNull();
    expect(before[1]).not.toBeNull();
    const setFile = path.join(tempDir("crank-set-"), "set.jsonl");
    fs.writeFileSync(setFile, '{"id": 1, "query": "kiwi"}\n');
    expect(evalRun(root, ["--root", root]).status).toBe(0);
    expect(evalRun(root, ["--root", root, "--set", setFile]).status).toBe(0);
    expect(names.map(read)).toEqual(before);
    expect(listing()).toEqual(listed);
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

    const usage = {
      status: 1,
      stdout: "",
      stderr: "recall-eval: usage: recall-eval.ts [--root <dir>] [--set <file>]\n",
    };
    expect(outcome(evalRun(empty, ["--root"]))).toEqual(usage);
    expect(outcome(evalRun(empty, ["--set"]))).toEqual(usage);
    expect(outcome(evalRun(tempDir("crank-noproj-"), ["--set"]))).toEqual(usage);

    expect(outcome(evalRun(empty, ["--root", empty, "--set", "nope.jsonl"]))).toEqual({
      status: 1,
      stdout: "",
      stderr: "recall-eval: cannot read nope.jsonl\n",
    });
    expect(outcome(evalRun(empty, ["--root", empty, "--set", empty]))).toEqual({
      status: 1,
      stdout: "",
      stderr: `recall-eval: cannot read ${empty}\n`,
    });

    const dir = tempDir("crank-bad-");
    for (const line of [
      "not json",
      "[1]",
      "null",
      '"text"',
      '{"id": 0, "query": "x"}',
      '{"id": -1, "query": "x"}',
      '{"id": 1.5, "query": "x"}',
      '{"id": "1", "query": "x"}',
      '{"query": "x"}',
      '{"id": 1}',
      '{"id": 1, "query": 7}',
      '{"id": 1, "query": "   "}',
    ]) {
      fs.writeFileSync(path.join(dir, "bad.jsonl"), `\n${line}\n`);
      expect(outcome(evalRun(dir, ["--root", empty, "--set", "bad.jsonl"]))).toEqual({
        status: 1,
        stdout: "",
        stderr: "recall-eval: bad.jsonl:2: not a question\n",
      });
    }

    const good = path.join(tempDir("crank-good-"), "good.jsonl");
    fs.writeFileSync(good, '{"id": 1, "query": "x"}\n');
    expect(outcome(evalRun(tempDir("crank-noproj-"), ["--set", "nope.jsonl"]))).toEqual({
      status: 1,
      stdout: "",
      stderr: "crank-mem: not initialized here — run `crank-mem init` first.\n",
    });
    expect(outcome(evalRun(missing, ["--root", missing, "--set", "nope.jsonl"]))).toEqual({
      status: 1,
      stdout: "",
      stderr: "recall-eval: cannot read nope.jsonl\n",
    });
    expect(outcome(evalRun(missing, ["--root", missing, "--set", good]))).toEqual({
      status: 0,
      stdout: "crank-mem: no memory exists yet.\n",
      stderr: "",
    });
    expect(outcome(evalRun(unreadable, ["--root", unreadable, "--set", good]))).toEqual({
      status: 1,
      stdout: "",
      stderr: "crank-mem: .crank/memory.db is not a readable database.\n",
    });

    expect(outcome(evalRun(empty, ["--root", empty, "--set", good]))).toEqual({
      status: 0,
      stdout: "no queries\nskipped 1 of 1 questions\n",
      stderr: "",
    });
    const blank = path.join(tempDir("crank-blank-"), "blank.jsonl");
    fs.writeFileSync(blank, "\n");
    expect(outcome(evalRun(empty, ["--root", empty, "--set", blank]))).toEqual({
      status: 0,
      stdout: "no queries\nskipped 0 of 0 questions\n",
      stderr: "",
    });
  });
});

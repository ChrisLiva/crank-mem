import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildGraph, childEnv, REPO_ROOT, seedMemory, tempDir } from "./helpers.ts";
import { initedCopy } from "./release-fixtures.ts";

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

/** Every path under `root`, each file's bytes, so a run that writes, adds or removes a file changes it. */
function snapshot(root: string): Record<string, Buffer | null> {
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true })
      .map(String)
      .sort()
      .map((name) => {
        const file = path.join(root, name);
        return [name, fs.statSync(file).isFile() ? fs.readFileSync(file) : null];
      }),
  );
}

describe("recall-eval", () => {
  test("prints each query's recall@10 with and without the graph, then the means, and writes nothing", () => {
    const root = initedCopy(FILES);
    buildGraph(root);
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
    const before = snapshot(root);
    for (const [cwd, args] of [
      [root, ["--root", root]],
      [path.join(root, "src"), []],
    ] as const) {
      const run = evalRun(cwd, [...args]);
      expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 0, stdout: expected });
    }
    expect(snapshot(root)).toEqual(before);
  });

  test("lost counts the queries whose graph top 10 drops a relevant id the baseline holds", () => {
    const root = initedCopy(FILES);
    buildGraph(root);
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

  test("replays a labelled set's questions, skipping stale and unknown ids, and writes nothing", () => {
    const root = initedCopy(FILES);
    buildGraph(root);
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
        '{"id": 2, "query": "src/a.ts kiwi jam"}',
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
      "skipped 2 of 7 questions\n" +
      "seeded 1 of 5 queries\n";
    const before = snapshot(root);
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
    expect(snapshot(root)).toEqual(before);
  });

  test("answers each store state and a bad root", () => {
    const failed = (run: ReturnType<typeof evalRun>, stderr: string) => {
      expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 1, stdout: "" });
      expect(run.stderr).toContain(stderr);
    };
    const ok = (run: ReturnType<typeof evalRun>, stdout: string) =>
      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({
        status: 0,
        stdout,
        stderr: "",
      });
    const missing = initedCopy();
    const db = path.join(missing, ".crank", "memory.db");
    fs.rmSync(db, { force: true });
    ok(evalRun(missing, ["--root", missing]), "crank-mem: no memory exists yet.\n");
    expect(fs.existsSync(db)).toBe(false);

    const unreadable = initedCopy();
    fs.writeFileSync(path.join(unreadable, ".crank", "memory.db"), "not a database");
    failed(evalRun(unreadable, ["--root", unreadable]), "not a readable database");

    const empty = initedCopy();
    seedMemory(empty, [], { request: "x" });
    ok(evalRun(empty, ["--root", empty]), "no queries\n");

    failed(evalRun(tempDir("crank-noproj-"), []), "not initialized here");
    failed(evalRun(empty, ["--root"]), "usage");
    failed(evalRun(empty, ["--set"]), "usage");
    failed(evalRun(empty, ["--root", empty, "--set", "nope.jsonl"]), "cannot read nope.jsonl");
    failed(evalRun(empty, ["--root", empty, "--set", empty]), `cannot read ${empty}`);

    const dir = tempDir("crank-bad-");
    for (const line of [
      "not json",
      "[1]",
      '{"id": 0, "query": "x"}',
      '{"id": "1", "query": "x"}',
      '{"id": 1}',
      '{"id": 1, "query": "   "}',
    ]) {
      fs.writeFileSync(path.join(dir, "bad.jsonl"), `\n${line}\n`);
      failed(evalRun(dir, ["--root", empty, "--set", "bad.jsonl"]), "bad.jsonl:2");
    }

    const good = path.join(tempDir("crank-good-"), "good.jsonl");
    fs.writeFileSync(good, '{"id": 1, "query": "x"}\n');
    ok(evalRun(missing, ["--root", missing, "--set", good]), "crank-mem: no memory exists yet.\n");
    failed(evalRun(unreadable, ["--root", unreadable, "--set", good]), "not a readable database");
    ok(evalRun(empty, ["--root", empty, "--set", good]), "no queries\nskipped 1 of 1 questions\n");
    const blank = path.join(tempDir("crank-blank-"), "blank.jsonl");
    fs.writeFileSync(blank, "\n");
    ok(evalRun(empty, ["--root", empty, "--set", blank]), "no queries\nskipped 0 of 0 questions\n");
  });
});

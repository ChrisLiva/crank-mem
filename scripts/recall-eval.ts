// `bun scripts/recall-eval.ts [--root <dir>] [--set <file>]`: replay each digest's request,
// or each question of a labelled set, against the project's store and print recall@5,
// recall@10 and mean reciprocal rank with and without the graph list.
// A dev script: it writes nothing and records no usage line.

import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { parseArgs, stringFlag } from "../src/cli/args.ts";
import { openNearestProject } from "../src/cli/project.ts";
import { queryVector } from "../src/cli/recall.ts";
import { CRANK_DIR } from "../src/hooks/lib/config.ts";
import {
  memoryPath,
  NO_MEMORY_NOTE,
  withReader,
  type MemoryReader,
  type SearchQuery,
} from "../src/hooks/lib/memory.ts";
import { relatedFiles } from "../src/hooks/lib/related-files.ts";
import { loadIndex } from "../src/hooks/lib/store.ts";

type Query = { label: number; text: string; relevant: Set<number> };
type Arm = { at5: number; at10: number; rr: number; top10: number[] };

/** Each digest's request with its non-stale observation ids, read over a second read-only connection. */
function queries(file: string): Query[] {
  const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite;
  const db = new mod.DatabaseSync(file, { timeout: 200 });
  try {
    db.exec("PRAGMA query_only=ON");
    // node:sqlite keys a row by column name, so both ids need aliases.
    const rows = db
      .prepare(
        "SELECT d.id AS digest_id, d.request, o.id AS observation_id FROM digests d JOIN observations o ON o.digest_id = d.id WHERE o.stale_at IS NULL ORDER BY d.id, o.id",
      )
      .all() as { digest_id: number; request: string; observation_id: number }[];
    const byDigest = new Map<number, Query>();
    for (const row of rows) {
      const q = byDigest.get(row.digest_id) ?? {
        label: row.digest_id,
        text: row.request,
        relevant: new Set<number>(),
      };
      q.relevant.add(row.observation_id);
      byDigest.set(row.digest_id, q);
    }
    return [...byDigest.values()];
  } finally {
    db.close();
  }
}

function recall(relevant: Set<number>, ids: number[], k: number): number {
  const hits = ids.slice(0, k).filter((id) => relevant.has(id)).length;
  return hits / Math.min(k, relevant.size);
}

/** 1 over the 1-based position of the first relevant id in the top 10, or 0 when it holds none. */
function reciprocalRank(relevant: Set<number>, top10: number[]): number {
  const at = top10.findIndex((id) => relevant.has(id));
  return at < 0 ? 0 : 1 / (at + 1);
}

function mean(values: number[]): string {
  return (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
}

function runArm(
  memory: MemoryReader,
  q: Query,
  vector: SearchQuery["vector"],
  related: SearchQuery["related"],
): Arm {
  const ids = memory
    .search({
      text: q.text,
      vector,
      limit: 10,
      type: null,
      sinceMs: null,
      files: null,
      stale: false,
      related,
    })
    .map((hit) => hit.line.id);
  const top10 = ids.slice(0, 10);
  return {
    at5: recall(q.relevant, ids, 5),
    at10: recall(q.relevant, ids, 10),
    rr: reciprocalRank(q.relevant, top10),
    top10,
  };
}

/** The mode line, one line per query, both arms' means and the lost line; `no queries` for an empty list. */
async function evaluate(root: string, memory: MemoryReader, list: Query[]): Promise<string[]> {
  if (list.length === 0) return ["no queries"];
  const index = loadIndex(path.join(root, CRANK_DIR));
  const lines: string[] = [];
  const base: Arm[] = [];
  const graph: Arm[] = [];
  let lost = 0;
  let hybrid = true;
  for (const q of list) {
    const vector = await queryVector(memory, q.text);
    if (vector === null) hybrid = false;
    const b = runArm(memory, q, vector, { seeds: [], neighbours: [] });
    const g = runArm(memory, q, vector, relatedFiles(index, q.text));
    base.push(b);
    graph.push(g);
    if (b.top10.some((id) => q.relevant.has(id) && !g.top10.includes(id))) lost++;
    lines.push(`${q.label} base@10 ${b.at10.toFixed(2)} graph@10 ${g.at10.toFixed(2)}`);
  }
  for (const [name, arms] of [
    ["base", base],
    ["graph", graph],
  ] as const) {
    lines.push(
      `${name} recall@5 ${mean(arms.map((a) => a.at5))} recall@10 ${mean(arms.map((a) => a.at10))} mrr ${mean(arms.map((a) => a.rr))}`,
    );
  }
  lines.push(`lost ${lost} of ${list.length} queries`);
  return [`mode ${hybrid ? "hybrid" : "keyword"}`, ...lines];
}

type Question = { id: number; query: string };

/** The set file's questions in file order, blank lines dropped, or the stderr line for an unreadable file or a bad line. */
function readSet(file: string): Question[] | string {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // Missing, a directory, or no permission: each answers the same way.
    return `recall-eval: cannot read ${file}`;
  }
  const set: Question[] = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const question = parseQuestion(line);
    if (!question) return `recall-eval: ${file}:${i + 1}: not a question`;
    set.push(question);
  }
  return set;
}

/** A JSON object with a positive-integer `id` and a non-blank string `query`, else null. */
function parseQuestion(line: string): Question | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { id, query } = value as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return null;
  if (typeof query !== "string" || query.trim() === "") return null;
  return { id, query };
}

/** Replays each live question against its one relevant observation, then prints the skipped count. */
async function replaySet(root: string, memory: MemoryReader, set: Question[]): Promise<string[]> {
  const list: Query[] = [];
  for (const { id, query } of set) {
    const [observation] = memory.get([id]);
    if (observation && observation.staleFlag === null) {
      list.push({ label: id, text: query, relevant: new Set([id]) });
    }
  }
  const lines = await evaluate(root, memory, list);
  return [...lines, `skipped ${set.length - list.length} of ${set.length} questions`];
}

const { flags } = parseArgs(process.argv.slice(2), ["root", "set"]);
const rootFlag = stringFlag(flags.root);
const setFlag = stringFlag(flags.set);
if (rootFlag === null || setFlag === null) {
  process.stderr.write("recall-eval: usage: recall-eval.ts [--root <dir>] [--set <file>]\n");
  process.exit(1);
}
const root = rootFlag ?? openNearestProject()?.root;
if (!root) process.exit(1);
const set = setFlag === undefined ? undefined : readSet(setFlag);
if (typeof set === "string") {
  process.stderr.write(`${set}\n`);
  process.exit(1);
}
const result = await withReader(memoryPath(root), (memory) =>
  set ? replaySet(root, memory, set) : evaluate(root, memory, queries(memoryPath(root))),
);
if ("note" in result) {
  // A missing store is an empty result, as `crank-mem search` answers it.
  if (result.note !== NO_MEMORY_NOTE) {
    console.error(result.note);
    process.exit(1);
  }
  console.log(result.note);
} else {
  for (const line of result) console.log(line);
}

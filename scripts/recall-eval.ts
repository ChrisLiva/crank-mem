// `bun scripts/recall-eval.ts [--root <dir>]`: replay each digest's request against the
// project's store and print recall@5 and recall@10 with and without the graph list.
// A dev script: it writes nothing and records no usage line.

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

type Query = { digest: number; request: string; relevant: Set<number> };
type Arm = { at5: number; at10: number; top10: number[] };

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
        digest: row.digest_id,
        request: row.request,
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

function mean(values: number[]): string {
  return (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
}

async function evaluate(root: string, memory: MemoryReader): Promise<string[]> {
  const list = queries(memoryPath(root));
  if (list.length === 0) return ["no queries"];
  const index = loadIndex(path.join(root, CRANK_DIR));
  const lines: string[] = [];
  const base: Arm[] = [];
  const graph: Arm[] = [];
  let lost = 0;
  for (const q of list) {
    const vector = await queryVector(memory, q.request);
    const arm = (related: SearchQuery["related"]): Arm => {
      const ids = memory
        .search({
          text: q.request,
          vector,
          limit: 10,
          type: null,
          sinceMs: null,
          file: null,
          stale: false,
          related,
        })
        .map((hit) => hit.id);
      return {
        at5: recall(q.relevant, ids, 5),
        at10: recall(q.relevant, ids, 10),
        top10: ids.slice(0, 10),
      };
    };
    const b = arm({ seeds: [], neighbours: [] });
    const g = arm(relatedFiles(index, q.request));
    base.push(b);
    graph.push(g);
    if (b.top10.some((id) => q.relevant.has(id) && !g.top10.includes(id))) lost++;
    lines.push(`${q.digest} base@10 ${b.at10.toFixed(2)} graph@10 ${g.at10.toFixed(2)}`);
  }
  for (const [name, arms] of [
    ["base", base],
    ["graph", graph],
  ] as const) {
    lines.push(
      `${name} recall@5 ${mean(arms.map((a) => a.at5))} recall@10 ${mean(arms.map((a) => a.at10))}`,
    );
  }
  lines.push(`lost ${lost} of ${list.length} queries`);
  return lines;
}

const { flags } = parseArgs(process.argv.slice(2), ["root"]);
const rootFlag = stringFlag(flags.root);
if (rootFlag === null) {
  process.stderr.write("recall-eval: usage: recall-eval.ts [--root <dir>]\n");
  process.exit(1);
}
const root = rootFlag ?? openNearestProject()?.root;
if (!root) process.exit(1);
const result = await withReader(memoryPath(root), (memory) => evaluate(root, memory));
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

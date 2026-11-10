import type * as sqlite from "node:sqlite";
import type { Memory } from "./memory.ts";
import { all, hasVectors, LINE_COLUMNS, lineFilters, toLine } from "./memory-read.ts";
import type { ObservationLine } from "./wire.ts";

// Search fuses a keyword list and a vector list by reciprocal rank (k = RRF_K),
// each list cut at LIST_DEPTH rows; equal scores go to the newest row.
const RRF_K = 60;
const LIST_DEPTH = 50;

function newestFirst(a: ObservationLine, b: ObservationLine): number {
  return b.createdAtMs - a.createdAtMs || b.id - a.id;
}

/** Quotes every whitespace-separated term so raw input never parses as FTS5 syntax; "" when there are none. */
function ftsQuery(text: string, joiner: " " | " OR "): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(joiner);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i]! * b[i]!;
  return Number.isNaN(sum) ? -Infinity : sum;
}

export function search(
  db: sqlite.DatabaseSync,
  query: Parameters<Memory["search"]>[0],
): ReturnType<Memory["search"]> {
  const { filters, params } = lineFilters(query);
  const where = filters.map((f) => ` AND ${f}`).join("");
  const keyword = (joiner: " " | " OR "): ObservationLine[] => {
    const match = ftsQuery(query.text, joiner);
    if (!match) return [];
    return all(
      db,
      `SELECT ${LINE_COLUMNS} FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid
         WHERE observations_fts MATCH ?${where}
         ORDER BY bm25(observations_fts), o.created_at DESC, o.id DESC LIMIT ?`,
      match,
      ...params,
      LIST_DEPTH,
    ).map(toLine);
  };
  const vector = query.vector;
  if (!vector || !hasVectors(db, vector.model)) {
    const and = keyword(" ");
    return (and.length > 0 ? and : keyword(" OR ")).slice(0, query.limit);
  }
  const byVector = all(
    db,
    `SELECT ${LINE_COLUMNS}, v.vector FROM observation_vectors v JOIN observations o ON o.id = v.observation_id
       WHERE v.model = ?${where}`,
    vector.model,
    ...params,
  )
    .map((row) => {
      const bytes = row.vector as Uint8Array;
      const stored = new Float32Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      return { line: toLine(row), score: dot(stored, vector.values) };
    })
    .sort((x, y) => y.score - x.score || newestFirst(x.line, y.line))
    .slice(0, LIST_DEPTH)
    .map((s) => s.line);
  const fused = new Map<number, { line: ObservationLine; score: number }>();
  for (const list of [keyword(" "), byVector]) {
    list.forEach((line, i) => {
      const entry = fused.get(line.id) ?? { line, score: 0 };
      entry.score += 1 / (RRF_K + i + 1);
      fused.set(line.id, entry);
    });
  }
  return [...fused.values()]
    .sort((x, y) => y.score - x.score || newestFirst(x.line, y.line))
    .slice(0, query.limit)
    .map((entry) => entry.line);
}

import * as path from "node:path";
import type * as sqlite from "node:sqlite";

const MAX_TERM_FILES = 5;
/** Path-like (`.`, `/`) or identifier-shaped (`_`, a lowercase-then-uppercase pair); plain words seed nothing. */
const SEEDING_TERM = /[./_]|[a-z][A-Z]/;
const MAX_SEEDS = 20;
const MAX_NEIGHBOURS = 100;
const MAX_DECLARING_FILES = 10;

interface Node {
  imports: string[];
  /** Lowercased symbol names. */
  symbols: string[];
  declares: string[];
  uses: string[];
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Each file `code.db` holds, in code-unit path order, with its imports, lowercased symbol names and C# namespaces. */
function nodes(db: sqlite.DatabaseSync): Map<string, Node> {
  const out = new Map<string, Node>();
  const files = db.prepare("SELECT path FROM files").all() as { path: string }[];
  for (const { path: file } of files.sort((a, b) => byCodeUnit(a.path, b.path))) {
    out.set(file, { imports: [], symbols: [], declares: [], uses: [] });
  }
  const fill = (sql: string, add: (node: Node, a: string, b: string) => void): void => {
    for (const row of db.prepare(sql).all() as { file: string; a: string; b: string }[]) {
      const node = out.get(row.file);
      if (node) add(node, row.a, row.b);
    }
  };
  fill("SELECT from_path AS file, to_path AS a, '' AS b FROM imports", (n, a) => n.imports.push(a));
  fill("SELECT path AS file, name AS a, '' AS b FROM symbols", (n, a) =>
    n.symbols.push(a.toLowerCase()),
  );
  fill("SELECT path AS file, namespace AS a, role AS b FROM namespaces", (n, a, role) =>
    (role === "declares" ? n.declares : n.uses).push(a),
  );
  return out;
}

function terms(text: string): string[] {
  return text
    .split(/[\s,;:()[\]{}"'`]+/)
    .map((t) => t.replace(/[?!.]+$/, ""))
    .filter((t) => t.length >= 3 && SEEDING_TERM.test(t))
    .map((t) => t.toLowerCase());
}

function matches(term: string, file: string, node: Node): boolean {
  const lower = file.toLowerCase();
  const base = path.posix.basename(lower);
  return (
    term === lower ||
    (term.includes("/") && lower.endsWith(`/${term}`)) ||
    term === base ||
    term === base.slice(0, base.length - path.posix.extname(base).length) ||
    node.symbols.includes(term)
  );
}

/** Each file's edge to every file it imports, in graph order. */
function importEdges(graph: Map<string, Node>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [file, node] of graph) {
    for (const target of node.imports) out.push([file, target]);
  }
  return out;
}

/** Each C# namespace and the files declaring it, in graph order. */
function declaringFiles(graph: Map<string, Node>): Map<string, string[]> {
  const declaring = new Map<string, string[]>();
  for (const [file, node] of graph) {
    for (const ns of node.declares) declaring.set(ns, [...(declaring.get(ns) ?? []), file]);
  }
  return declaring;
}

/** A C# `using` to each other file declaring that namespace, skipping namespaces declared too widely. */
function namespaceEdges(
  graph: Map<string, Node>,
  declaring: Map<string, string[]>,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [file, node] of graph) {
    for (const ns of node.uses) {
      const targets = declaring.get(ns) ?? [];
      if (targets.length > MAX_DECLARING_FILES) continue;
      for (const target of targets) if (target !== file) out.push([file, target]);
    }
  }
  return out;
}

/** Import edges, plus a C# `using` to each other file declaring that namespace. */
function edges(graph: Map<string, Node>): Array<[string, string]> {
  return [...importEdges(graph), ...namespaceEdges(graph, declaringFiles(graph))];
}

/** Each file's distinct neighbours over both edge directions, files in the graph only. */
function adjacency(graph: Map<string, Node>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    out.set(a, (out.get(a) ?? new Set<string>()).add(b));
  };
  for (const [from, to] of edges(graph)) {
    if (from === to || !graph.has(from) || !graph.has(to)) continue;
    link(from, to);
    link(to, from);
  }
  return out;
}

/** A file one hop from a seed and the share of the seeds' weight it receives. */
export type Neighbour = { path: string; weight: number };

/**
 * The files a query names (seeds) and the files one hop from them (neighbours). Each seed holds
 * 1/seeds and splits it evenly over all its neighbours, so a seed with many edges passes little
 * to each; neighbours come heaviest first, ties in code-unit order.
 */
export function relatedFiles(
  db: sqlite.DatabaseSync | null,
  text: string,
): { seeds: string[]; neighbours: Neighbour[] } {
  if (db === null) return { seeds: [], neighbours: [] };
  const graph = nodes(db);
  const seeds = new Set<string>();
  for (const term of terms(text)) {
    const hits = [...graph].filter(([file, node]) => matches(term, file, node));
    if (hits.length > MAX_TERM_FILES) continue;
    for (const [file] of hits) seeds.add(file);
  }
  const starting = [...seeds].slice(0, MAX_SEEDS);
  const isSeed = new Set(starting);
  const near = adjacency(graph);
  const weights = new Map<string, number>();
  for (const seed of starting) {
    const around = near.get(seed) ?? new Set<string>();
    for (const n of around) {
      if (isSeed.has(n)) continue;
      weights.set(n, (weights.get(n) ?? 0) + 1 / around.size / starting.length);
    }
  }
  const neighbours = [...weights]
    .map(([path, weight]) => ({ path, weight }))
    .sort((a, b) => b.weight - a.weight || byCodeUnit(a.path, b.path));
  return { seeds: starting, neighbours: neighbours.slice(0, MAX_NEIGHBOURS) };
}

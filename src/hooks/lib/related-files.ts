import * as path from "node:path";
import { isObj } from "./config.ts";
import type { AnatomyIndex } from "./store.ts";

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

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** `loadIndex` checks only the top-level shape, so every entry field is read defensively. */
function nodes(index: AnatomyIndex): Map<string, Node> {
  const out = new Map<string, Node>();
  const paths = Object.keys(index.files).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const file of paths) {
    const entry: unknown = index.files[file];
    if (!isObj(entry)) continue;
    const symbols = Array.isArray(entry.symbols) ? entry.symbols : [];
    const namespaces = isObj(entry.namespaces) ? entry.namespaces : {};
    out.set(file, {
      imports: strings(entry.imports),
      symbols: strings(symbols.map((s: unknown) => (isObj(s) ? s.name : undefined))).map((s) =>
        s.toLowerCase(),
      ),
      declares: strings(namespaces.declares),
      uses: strings(namespaces.uses),
    });
  }
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
  index: AnatomyIndex,
  text: string,
): { seeds: string[]; neighbours: Neighbour[] } {
  const graph = nodes(index);
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
    .sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { seeds: starting, neighbours: neighbours.slice(0, MAX_NEIGHBOURS) };
}

import * as fs from "node:fs";
import * as path from "node:path";
import { ISO_DATE } from "./bullets.ts";
import { readCodeDb } from "./code-db.ts";
import { readStoreSync } from "./memory.ts";
import { linkedProjects } from "./registry.ts";

/** The linked projects a checker may consult. */
type Links = () => { name: string; root: string }[];

export interface CitationCheck {
  /** The files `text` cites that are missing or modified, each once. */
  status(text: string, sinceMs: number | null): { missing: string[]; modified: string[] };
}

/** A project's file paths from its `code.db`, read on the first lookup; none when the store is absent. */
interface Placement {
  root: string;
  has(rel: string): boolean;
  /** The paths whose basename is `name`. */
  named(name: string): string[];
}

function placement(root: string): Placement {
  let known: { paths: Set<string>; byName: Map<string, string[]> } | undefined;
  const load = () =>
    (known ??= (() => {
      const rows = readCodeDb(root, (db) =>
        db ? (db.prepare("SELECT path FROM files").all() as { path: string }[]) : [],
      );
      return { paths: new Set(rows.map((r) => r.path)), byName: basenameIndex(rows) };
    })());
  return {
    root,
    has: (rel) => load().paths.has(rel),
    named: (name) => load().byName.get(name) ?? [],
  };
}

/**
 * Linked projects' placements: `links` listed on the first lookup, each `code.db` opened on the
 * first citation that resolves in it, for read only.
 */
interface LinkedPlacements {
  rootOf(name: string): string | undefined;
  at(root: string): Placement;
}

function linkedPlacements(links: Links): LinkedPlacements {
  let roots: Map<string, string> | undefined;
  const placements = new Map<string, Placement>();
  return {
    rootOf: (name) => (roots ??= new Map(links().map((p) => [p.name, p.root]))).get(name),
    at: (root) => {
      let linked = placements.get(root);
      if (!linked) placements.set(root, (linked = placement(root)));
      return linked;
    },
  };
}

/**
 * A checker of the files a text cites. Missing: a cited file not on disk. Modified: a cited file
 * whose mtime on disk is past `sinceMs`, or, with `sinceMs` null, past the end of the text's latest
 * date; an undated text then has none. `code.db` only places a cited name: its rows may be
 * stale, so the disk alone answers whether the file exists and when it changed.
 *
 * A basename resolves by a unique suffix match against the project's `code.db` files, because agents cite
 * `geometry.py` far more often than its full path. An unresolved basename is never checked:
 * `code.db` omits unindexable files, and a dotted symbol such as
 * `fs.statSync` reads the same.
 *
 * A citation whose first segment names a linked project, where `home.root` holds no entry of that
 * name, resolves in that project with the segment stripped under `resolve`, and is skipped under
 * `ignore`. The policy defaults to resolving the home store's links.
 */
export function citationCheck(
  home: { root: string },
  linked: { resolve: Links } | { ignore: Links } = { resolve: () => storeLinks(home.root) },
): CitationCheck {
  const resolve = "resolve" in linked;
  const placements = linkedPlacements(resolve ? linked.resolve : linked.ignore);
  const own = placement(home.root);
  return {
    status(text, sinceMs) {
      const cutoffMs = sinceMs ?? latestDateEnd(text);
      const missing = new Set<string>();
      const modified = new Set<string>();
      for (const rel of fileCitations(text)) {
        const status = resolveCitation(rel, own, placements, resolve, cutoffMs);
        if (status === "missing") missing.add(rel);
        else if (status === "modified") modified.add(rel);
      }
      return { missing: [...missing], modified: [...modified] };
    },
  };
}

/** A backticked file citation: a path or basename with an extension, then an optional `:line`. */
const FILE_CITATION = /^([^\s*=:]+\.[A-Za-z]\w*)(?::\d+(?:-\d+)?)?$/;

function basenameIndex(rows: { path: string }[]): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const { path: rel } of rows) {
    const name = path.posix.basename(rel);
    byName.set(name, [...(byName.get(name) ?? []), rel]);
  }
  return byName;
}

/** The end of the latest ISO date in a text, local time, in ms; null without a date. */
function latestDateEnd(text: string): number | null {
  let latest: number | null = null;
  for (const [, y, m, d] of text.matchAll(ISO_DATE)) {
    const end = new Date(Number(y), Number(m) - 1, Number(d) + 1).getTime();
    if (latest === null || end > latest) latest = end;
  }
  return latest;
}

/** An entry in `home.root` named like a linked project keeps the citation at home. */
function resolveCitation(
  rel: string,
  home: Placement,
  placements: LinkedPlacements,
  resolve: boolean,
  cutoffMs: number | null,
): "missing" | "modified" | null {
  const slash = rel.indexOf("/");
  const head = rel.slice(0, Math.max(slash, 0));
  const root =
    head && !fs.existsSync(path.join(home.root, head)) ? placements.rootOf(head) : undefined;
  if (root === undefined) return resolveIn(rel, home, cutoffMs);
  return resolve ? resolveIn(rel.slice(slash + 1), placements.at(root), cutoffMs) : null;
}

function resolveIn(
  rel: string,
  cited: Placement,
  cutoffMs: number | null,
): "missing" | "modified" | null {
  const hits = cited.has(rel)
    ? [rel]
    : cited.named(path.posix.basename(rel)).filter((c) => c.endsWith("/" + rel));
  if (hits.length > 1 || (!hits.length && !rel.includes("/"))) return null;
  const mtimeMs = diskMtime(path.join(cited.root, hits[0] ?? rel));
  if (mtimeMs === null) return "missing";
  return cutoffMs !== null && mtimeMs > cutoffMs ? "modified" : null;
}

function diskMtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    // Bun throws ENOTDIR through a regular file even with throwIfNoEntry false.
    return null;
  }
}

/**
 * The files a text cites in backticks, as written minus a leading `./` and a
 * `:line` suffix. Spans starting with `-`, `/` or `~` are flags, routes and
 * home paths, and `*` or `=` marks a glob or an assignment, so none of them count.
 */
export function fileCitations(text: string): string[] {
  const cited: string[] = [];
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
    const match = /^[-/~]/.test(span!) ? null : FILE_CITATION.exec(span!);
    if (match) cited.push(match[1]!.replace(/^\.\//, ""));
  }
  return cited;
}

/** `registry.ts` → `linkedProjects` of the project's store; none when the store cannot be read. */
export function storeLinks(root: string): ReturnType<Links> {
  const links = readStoreSync(root, linkedProjects);
  return links.status === "open" ? links.value : [];
}

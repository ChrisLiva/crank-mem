import * as fs from "node:fs";
import * as path from "node:path";
import { ISO_DATE } from "./bullets.ts";
import { CRANK_DIR } from "./config.ts";
import { memoryPath, openMemory } from "./memory.ts";
import { linkedProjects } from "./registry.ts";
import { loadIndex, type AnatomyIndex } from "./store.ts";

// Which files a text cites are missing or modified: at home, or in a linked project when the link policy resolves them.

/** The linked projects a checker may consult, listed only when a citation needs them. */
type Links = () => { name: string; root: string }[];

export interface CitationCheck {
  /** The files `text` cites that are missing or modified, each once. */
  status(text: string, sinceMs: number | null): { missing: string[]; modified: string[] };
}

/** A project's anatomy, its files grouped by basename on the first lookup that needs them. */
interface Anatomy {
  root: string;
  index: AnatomyIndex;
  byName: () => Map<string, string[]>;
}

function anatomy(root: string, index: AnatomyIndex): Anatomy {
  let byName: Map<string, string[]> | undefined;
  return { root, index, byName: () => (byName ??= basenameIndex(index)) };
}

/**
 * Linked projects' anatomies: `links` listed on the first lookup, each anatomy read on the first
 * citation that resolves in it, none written.
 */
interface LinkedAnatomies {
  has(name: string): boolean;
  get(name: string): Anatomy;
}

function linkedAnatomies(links: Links): LinkedAnatomies {
  let roots: Map<string, string> | undefined;
  const anatomies = new Map<string, Anatomy>();
  const rootOf = (name: string) =>
    (roots ??= new Map(links().map((p) => [p.name, p.root]))).get(name);
  return {
    has: (name) => rootOf(name) !== undefined,
    get: (name) => {
      let linked = anatomies.get(name);
      if (!linked) {
        const root = rootOf(name)!;
        anatomies.set(name, (linked = anatomy(root, loadIndex(path.join(root, CRANK_DIR)))));
      }
      return linked;
    },
  };
}

/**
 * A checker of the files a text cites. Missing: a cited file not on disk. Modified: a cited file
 * whose mtime on disk is past `sinceMs`, or, with `sinceMs` null, past the end of the text's latest
 * date; an undated text then has none. The index only places a cited name: a caller's index may be
 * stale, so the disk alone answers whether the file exists and when it changed.
 *
 * A basename resolves by a unique suffix match against the index, because agents cite
 * `geometry.py` far more often than its full path. An unresolved basename is never checked:
 * the index omits files past max_files and unindexable ones, and a dotted symbol such as
 * `fs.statSync` reads the same.
 *
 * A citation whose first segment names a linked project, where `home.root` holds no entry of that
 * name, resolves in that project with the segment stripped under `resolve`, and is skipped under
 * `ignore`.
 */
export function citationCheck(
  home: { root: string; index: AnatomyIndex },
  linked: { resolve: Links } | { ignore: Links },
): CitationCheck {
  const resolve = "resolve" in linked;
  const anatomies = linkedAnatomies(resolve ? linked.resolve : linked.ignore);
  const own = anatomy(home.root, home.index);
  return {
    status(text, sinceMs) {
      const cutoffMs = sinceMs ?? latestDateEnd(text);
      const missing = new Set<string>();
      const modified = new Set<string>();
      for (const rel of fileCitations(text)) {
        const status = resolveCitation(rel, own, anatomies, resolve, cutoffMs);
        if (status === "missing") missing.add(rel);
        else if (status === "modified") modified.add(rel);
      }
      return { missing: [...missing], modified: [...modified] };
    },
  };
}

/** A backticked file citation: a path or basename with an extension, then an optional `:line`. */
const FILE_CITATION = /^([^\s*=:]+\.[A-Za-z]\w*)(?::\d+(?:-\d+)?)?$/;

/** The index's files grouped by basename, for resolving a cited basename. */
function basenameIndex(index: AnatomyIndex): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const rel of Object.keys(index.files)) {
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

/**
 * The linked project a citation's first segment names, or null. An entry of that name in `root`
 * keeps the citation in `root`.
 */
function linkedPrefix(
  rel: string,
  root: string,
  isLinked: (name: string) => boolean,
): string | null {
  const slash = rel.indexOf("/");
  if (slash <= 0) return null;
  const head = rel.slice(0, slash);
  return !fs.existsSync(path.join(root, head)) && isLinked(head) ? head : null;
}

/**
 * One citation's status: modified past `cutoffMs`, missing, or null for neither. A citation whose
 * `linkedPrefix` names a linked project resolves in that project, the segment stripped, or under
 * the `ignore` policy is null.
 */
function resolveCitation(
  rel: string,
  home: Anatomy,
  anatomies: LinkedAnatomies,
  resolve: boolean,
  cutoffMs: number | null,
): "missing" | "modified" | null {
  const head = linkedPrefix(rel, home.root, anatomies.has);
  if (head === null) return resolveIn(rel, home, cutoffMs);
  return resolve ? resolveIn(rel.slice(head.length + 1), anatomies.get(head), cutoffMs) : null;
}

function resolveIn(
  rel: string,
  cited: Anatomy,
  cutoffMs: number | null,
): "missing" | "modified" | null {
  const hits = cited.index.files[rel]
    ? [rel]
    : (cited.byName().get(path.posix.basename(rel)) ?? []).filter((c) => c.endsWith("/" + rel));
  if (hits.length > 1 || (!hits.length && !rel.includes("/"))) return null;
  const mtimeMs = diskMtime(path.join(cited.root, hits[0] ?? rel));
  if (mtimeMs === null) return "missing";
  return cutoffMs !== null && mtimeMs > cutoffMs ? "modified" : null;
}

/** A file's mtime on disk, or null when nothing is there. */
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
  const opened = openMemory(memoryPath(root), "read");
  if (opened.status !== "open") return [];
  try {
    return linkedProjects(opened.memory);
  } catch {
    return [];
  } finally {
    opened.memory.close();
  }
}

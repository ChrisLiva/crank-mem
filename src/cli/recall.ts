import * as path from "node:path";
import { EMBED_MODEL, embed, modelPresent } from "../daemon/embedder.ts";
import { redact } from "../daemon/redact.ts";
import { CRANK_DIR } from "../hooks/lib/config.ts";
import {
  formatLine,
  localDate,
  memoryPath,
  NO_MEMORY_NOTE,
  parseHandle,
  withReader,
  type MemoryReader,
  type SearchQuery,
} from "../hooks/lib/memory.ts";
import { toPosix } from "../hooks/lib/indexable.ts";
import { ownerOf, projectName } from "../hooks/lib/owner.ts";
import { linkedProjects, rootOfName } from "../hooks/lib/registry.ts";
import { relatedFiles } from "../hooks/lib/related-files.ts";
import { loadIndex } from "../hooks/lib/store.ts";
import { cliActor, recordUsage, type UsageEvent } from "../hooks/lib/usage.ts";
import { isObservationType, type Observation, type ObservationLine } from "../hooks/lib/wire.ts";
import { parseArgs, stringFlag } from "./args.ts";
import { COMMANDS } from "./commands.ts";
import { openNearestProject } from "./project.ts";

const KEYWORD_ONLY_NOTE =
  "crank-mem: keyword search only; run `crank-mem setup` for search by meaning.";

/** A missing store is an empty result for search (stdout, exit 0) and an error for the rest. */
async function withMemory(
  root: string,
  missingIsEmpty: boolean,
  fn: (memory: MemoryReader) => number | Promise<number>,
): Promise<number> {
  const r = await withReader(memoryPath(root), fn);
  if (typeof r === "number") return r;
  if (missingIsEmpty && r.note === NO_MEMORY_NOTE) {
    console.log(r.note);
    return 0;
  }
  console.error(r.note);
  return 1;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** Local midnight of a `YYYY-MM-DD` date, or null when it is not a real calendar date. */
function localMidnight(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

/** The longest query text a search usage line records. */
const QUERY_CHARS = 500;

export async function search(args: string[]): Promise<number> {
  const started = Date.now();
  const { flags, rest } = parseArgs(args, COMMANDS.search.value);
  // An unknown flag is query text, so `search --max-turns` finds that option.
  const known = [...COMMANDS.search.value, ...COMMANDS.search.bool];
  const extra = Object.keys(flags)
    .filter((key) => key !== "" && !known.includes(key))
    .map((key) => `--${key}`);
  const text = [...rest, ...extra].join(" ");
  const usage = () => {
    console.error(COMMANDS.search.usage);
    return 1;
  };
  const [limit, type, since, file, named] = [
    flags.limit,
    flags.type,
    flags.since,
    flags.file,
    flags.project,
  ].map(stringFlag);
  if (!text.trim()) return usage();
  if (limit === null || type === null || since === null || file === null || named === null)
    return usage();
  if (limit !== undefined && !/^[1-9]\d*$/.test(limit)) return usage();
  if (type !== undefined && !isObservationType(type)) return usage();
  const sinceMs = since === undefined ? null : localMidnight(since);
  if (since !== undefined && sinceMs === null) return usage();
  const project = openNearestProject();
  if (!project) return 1;
  const scope = searchScope(project.root, named, file);
  if (typeof scope === "number") return scope;
  const host = stringFlag(flags["model-host"]) ?? undefined;
  // `--project` searches the named store alone, so the current store need not open.
  const searched = scope.only?.root ?? project.root;
  return withMemory(searched, true, async (memory) => {
    const embeddable = memory.hasVectors(EMBED_MODEL);
    const vector = await queryVector(memory, text, host);
    if ((!embeddable && !modelPresent()) || (embeddable && vector === null)) {
      console.error(KEYWORD_ONLY_NOTE);
    }
    const applied = limit === undefined ? DEFAULT_LIMIT : Math.min(Number(limit), MAX_LIMIT);
    const stale = flags.stale === true;
    const hits = await federatedSearch(memory, searched, scope, {
      text,
      vector,
      limit: applied,
      type: type ?? null,
      sinceMs,
      stale,
    });
    for (const hit of hits) console.log(hit.name + formatLine(hit.line));
    recordSearch(project.root, hits, {
      channel: "search",
      query: redact(text).slice(0, QUERY_CHARS),
      limit: applied,
      type: type ?? null,
      since: since ?? null,
      file: scope.file?.rel ?? null,
      stale,
      mode: vector === null ? "keyword" : "hybrid",
      ms: Date.now() - started,
    });
    return 0;
  });
}

/** One store's search hit: `name` prefixes its line (`""` for the current project), `hash` is its dedupe key. */
type StoreHit = { name: string; root: string; line: ObservationLine; score: number; hash: string };

function storeHits(
  memory: MemoryReader,
  name: string,
  root: string,
  query: SearchQuery,
): StoreHit[] {
  const hits = memory.search(query);
  const hashes = memory.contentHashes(hits.map((hit) => hit.line.id));
  return hits.map((hit) => ({
    name,
    root,
    ...hit,
    hash: hashes.get(hit.line.id) ?? `${root}#${hit.line.id}`,
  }));
}

const PAIRED_PATHS = 50;

/** The paths in `project` that `pairedPaths` on the current store gives for each of its seeds, deduped. */
function pairedSeeds(memory: MemoryReader, seeds: string[], project: string): string[] {
  const paths = new Set<string>();
  for (const seed of seeds) {
    for (const pair of memory.pairedPaths(seed, PAIRED_PATHS)) {
      if (pair.project === project) paths.add(pair.path);
    }
  }
  return [...paths];
}

/** A store a search reads: `name` prefixes its lines (`""` for the current project). */
type Target = { name: string; root: string };

/** Which stores a search reads (`only`, or the current and its linked ones) and the `--file` path's owner. */
type Scope = { only: Target | null; file: { root: string; rel: string } | null };

/**
 * The scope `--project` and `--file` give; 1 once an unknown project name is printed, 0 when the file has
 * no owner (an empty result).
 */
function searchScope(
  current: string,
  named: string | undefined,
  file: string | undefined,
): Scope | number {
  const only = named === undefined ? null : namedStore(named, current);
  if (only === null && named !== undefined) return 1;
  if (file === undefined) return { only, file: null };
  // A sensitive path still searches: the store holds none, and its usage line records it as null.
  const owner = ownerOf(path.resolve(process.cwd(), file));
  if (owner.kind === "unowned" || !owner.rel) return 0;
  return { only, file: { root: owner.root, rel: toPosix(owner.rel) } };
}

/** The store `name` names, the current project as `""`; null once the unknown name is printed. */
function namedStore(name: string, current: string): Target | null {
  const root = name === projectName(current) ? current : rootOfName(name);
  if (root === null) {
    console.error(`crank-mem: no project ${name}.`);
    return null;
  }
  return { name: root === current ? "" : name, root };
}

/** Each store the scope reads, with its graph list: its own anatomy's, or a linked store's pairs with the current seeds. */
function searchTargets(
  memory: MemoryReader,
  current: string,
  only: Target | null,
  text: string,
): (Target & { related: SearchQuery["related"] })[] {
  const own = (t: Target) => ({
    ...t,
    related: relatedFiles(loadIndex(path.join(t.root, CRANK_DIR)), text),
  });
  if (only !== null) return [own(only)];
  const home = own({ name: "", root: current });
  const linked = linkedProjects(memory)
    .filter((l) => l.root !== current)
    .map((l) => ({
      ...l,
      related: { seeds: pairedSeeds(memory, home.related.seeds, l.name), neighbours: [] },
    }));
  return [home, ...linked];
}

/** The owner's `pairedPaths` for the `--file` path, read from the current store or the owner's; [] when it will not open. */
async function ownerPairs(
  memory: MemoryReader,
  current: string,
  file: { root: string; rel: string },
): Promise<{ project: string; path: string }[]> {
  if (file.root === current) return memory.pairedPaths(file.rel, PAIRED_PATHS);
  const r = await withReader(memoryPath(file.root), (m) => m.pairedPaths(file.rel, PAIRED_PATHS));
  return Array.isArray(r) ? r : [];
}

/** A target's `--file` filter: the owner-relative path in the owner's store, else the paired paths in its project. */
function targetFiles(
  target: Target,
  file: Scope["file"],
  pairs: { project: string; path: string }[],
): string[] | null {
  if (file === null) return null;
  if (target.root === file.root) return [file.rel];
  const project = projectName(target.root);
  return pairs.filter((p) => p.project === project).map((p) => p.path);
}

/**
 * Each target store's hits (the current one's from `memory`, the others' that open), by fused score with
 * ties to the current project, one per content hash, cut to the query's limit. A target whose `--file`
 * filter holds no paths adds nothing. `current` is the root `memory` reads: the `--project` store when
 * `scope.only` names one.
 */
async function federatedSearch(
  memory: MemoryReader,
  current: string,
  scope: Scope,
  base: Omit<SearchQuery, "files" | "related">,
): Promise<StoreHit[]> {
  const pairs = scope.file === null ? [] : await ownerPairs(memory, current, scope.file);
  const hits: StoreHit[] = [];
  for (const target of searchTargets(memory, current, scope.only, base.text)) {
    const files = targetFiles(target, scope.file, pairs);
    if (files?.length === 0) continue;
    const query = { ...base, files, related: target.related };
    const r =
      target.root === current
        ? storeHits(memory, target.name, target.root, query)
        : await withReader(memoryPath(target.root), (m) =>
            storeHits(m, target.name, target.root, query),
          );
    if (Array.isArray(r)) hits.push(...r);
  }
  // A stable sort keeps the current store's hits, listed first, ahead of equal scores.
  hits.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return hits.filter((hit) => !seen.has(hit.hash) && seen.add(hit.hash)).slice(0, base.limit);
}

type SearchEvent = Omit<Extract<UsageEvent, { channel: "search" }>, "ids">;

/** One search usage line per store with that store's bare ids: the current project's always, each other's when it shows ids. */
function recordSearch(current: string, hits: StoreHit[], event: SearchEvent): void {
  const roots = new Set([current, ...hits.map((hit) => hit.root)]);
  for (const root of roots) {
    const ids = hits.filter((hit) => hit.root === root).map((hit) => hit.line.id);
    recordUsage(root, cliActor(), { ...event, ids });
  }
}

/**
 * The query's embedding, or null when the store holds no `EMBED_MODEL` vectors or the local model
 * cannot run. It never fetches and never prints.
 */
export async function queryVector(
  memory: MemoryReader,
  text: string,
  host?: string,
): Promise<SearchQuery["vector"]> {
  if (!memory.hasVectors(EMBED_MODEL)) return null;
  try {
    const [values] = await embed([text], { remote: false, host });
    return { model: EMBED_MODEL, values: values! };
  } catch {
    return null;
  }
}

type Handle = NonNullable<ReturnType<typeof parseHandle>>;

/** A store the handles name: `name` prefixes its lines (`""` for the current project), `ids` in handle order. */
type HandleStore = { name: string; root: string; ids: number[] };

/** Every arg as a handle, or null when one is not a handle. */
function parseHandles(args: string[]): Handle[] | null {
  const handles = args.map(parseHandle);
  return handles.every((h): h is Handle => h !== null) ? handles : null;
}

/**
 * The stores the handles name, in the order they first appear, then the current project when no handle names it;
 * a handle naming the current project counts as `#<id>`. Null once an unknown name is printed.
 */
function routeHandles(handles: Handle[], current: string): HandleStore[] | null {
  const stores = new Map<string, HandleStore>();
  for (const h of handles) {
    const target = h.project === "" ? { name: "", root: current } : namedStore(h.project, current);
    if (target === null) return null;
    const store = stores.get(target.root) ?? { ...target, ids: [] };
    store.ids.push(h.id);
    stores.set(target.root, store);
  }
  if (!stores.has(current)) stores.set(current, { name: "", root: current, ids: [] });
  return [...stores.values()];
}

const DEFAULT_DEPTH = 5;
const NUMBER = /^\d+$/;

export async function timeline(args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, COMMANDS.timeline.value);
  const handle = rest.length === 1 ? parseHandle(rest[0]!) : null;
  const depth = flags.depth ?? String(DEFAULT_DEPTH);
  if (handle === null || typeof depth !== "string" || !NUMBER.test(depth)) {
    console.error(COMMANDS.timeline.usage);
    return 1;
  }
  const project = openNearestProject();
  if (!project) return 1;
  const [store] = routeHandles([handle], project.root) ?? [];
  if (store === undefined) return 1;
  const [anchor, span] = [handle.id, Number(depth)];
  if (store.root !== project.root) {
    recordUsage(project.root, cliActor(), { channel: "timeline", anchor, depth: span, ids: [] });
  }
  return withMemory(store.root, false, (memory) => {
    const lines = memory.timeline(anchor, span);
    recordUsage(store.root, cliActor(), {
      channel: "timeline",
      anchor,
      depth: span,
      ids: lines === null ? null : lines.map((line) => line.id),
    });
    if (lines === null) {
      console.error(`crank-mem: no observation ${store.name}#${anchor}.`);
      return 1;
    }
    for (const line of lines) console.log(store.name + formatLine(line));
    return 0;
  });
}

const MAX_GET = 20;

function formatObservation(o: Observation): string {
  const list = (paths: string[]) => (paths.length > 0 ? paths.join(", ") : "(none)");
  return [
    formatLine(o),
    `session: ${o.sessionId}`,
    ...(o.staleFlag ? [`stale: ${localDate(o.staleFlag.atMs)} ${o.staleFlag.reason}`] : []),
    `narrative: ${o.narrative}`,
    o.facts.length > 0
      ? ["facts:", ...o.facts.map((fact) => `- ${fact}`)].join("\n")
      : "facts: (none)",
    `files read: ${list(o.filesRead)}`,
    `files modified: ${list(o.filesModified)}`,
  ].join("\n");
}

export async function get(args: string[]): Promise<number> {
  const handles = parseHandles(args);
  if (handles === null || handles.length === 0) {
    console.error(COMMANDS.get.usage);
    return 1;
  }
  const project = openNearestProject();
  if (!project) return 1;
  const stores = routeHandles(handles.slice(0, MAX_GET), project.root);
  if (stores === null) return 1;
  const blocks: string[] = [];
  for (const store of stores) {
    const found = await getFrom(store, project.root);
    if (found === null) return 1;
    blocks.push(...found.map((o) => store.name + formatObservation(o)));
  }
  if (blocks.length === 0) {
    console.error("crank-mem: no observation found.");
    return 1;
  }
  console.log(blocks.join("\n\n"));
  return 0;
}

/** `store`'s observations of its ids, after its usage line; null once the current store's note is printed. */
async function getFrom(store: HandleStore, current: string): Promise<Observation[] | null> {
  const r =
    store.ids.length === 0
      ? []
      : await withReader(memoryPath(store.root), (memory) => memory.get(store.ids));
  if (!Array.isArray(r)) {
    if (store.root !== current) return [];
    console.error(r.note);
    return null;
  }
  recordUsage(store.root, cliActor(), {
    channel: "get",
    requested: store.ids,
    found: r.map((o) => o.id),
  });
  return r;
}

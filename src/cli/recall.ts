import { EMBED_MODEL, embed, modelPresent } from "../daemon/embedder.ts";
import { redact } from "../daemon/redact.ts";
import { repoRelative } from "../hooks/lib/hook-io.ts";
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
import { projectName } from "../hooks/lib/owner.ts";
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
  const [limit, type, since, file] = [flags.limit, flags.type, flags.since, flags.file].map(
    stringFlag,
  );
  if (!text.trim()) return usage();
  if (limit === null || type === null || since === null || file === null) return usage();
  if (limit !== undefined && !/^[1-9]\d*$/.test(limit)) return usage();
  if (type !== undefined && !isObservationType(type)) return usage();
  const sinceMs = since === undefined ? null : localMidnight(since);
  if (since !== undefined && sinceMs === null) return usage();
  const project = openNearestProject();
  if (!project) return 1;
  const relFile = file === undefined ? null : repoRelative(project.root, process.cwd(), file);
  if (file !== undefined && relFile === null) return 0;
  const host = stringFlag(flags["model-host"]) ?? undefined;
  return withMemory(project.root, true, async (memory) => {
    const embeddable = memory.hasVectors(EMBED_MODEL);
    const vector = await queryVector(memory, text, host);
    if ((!embeddable && !modelPresent()) || (embeddable && vector === null)) {
      console.error(KEYWORD_ONLY_NOTE);
    }
    const applied = limit === undefined ? DEFAULT_LIMIT : Math.min(Number(limit), MAX_LIMIT);
    const stale = flags.stale === true;
    const hits = await federatedSearch(memory, project.root, {
      text,
      vector,
      limit: applied,
      type: type ?? null,
      sinceMs,
      file: relFile,
      stale,
      related: relatedFiles(loadIndex(project.crankDir), text),
    });
    for (const hit of hits) console.log(hit.name + formatLine(hit.line));
    recordSearch(project.root, hits, {
      channel: "search",
      query: redact(text).slice(0, QUERY_CHARS),
      limit: applied,
      type: type ?? null,
      since: since ?? null,
      file: relFile,
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

/**
 * The current store's hits and each linked store's that opens, by fused score with ties to the current
 * project, one per content hash, cut to the query's limit. A linked store's graph list holds only the
 * paths its pairs with the current seeds give.
 */
async function federatedSearch(
  memory: MemoryReader,
  root: string,
  query: SearchQuery,
): Promise<StoreHit[]> {
  const hits = storeHits(memory, "", root, query);
  for (const linked of linkedProjects(memory)) {
    if (linked.root === root) continue;
    const seeds = pairedSeeds(memory, query.related.seeds, linked.name);
    const linkedQuery = { ...query, related: { seeds, neighbours: [] } };
    const r = await withReader(memoryPath(linked.root), (m) =>
      storeHits(m, linked.name, linked.root, linkedQuery),
    );
    if (Array.isArray(r)) hits.push(...r);
  }
  // A stable sort keeps the current store's hits, listed first, ahead of equal scores.
  hits.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return hits.filter((hit) => !seen.has(hit.hash) && seen.add(hit.hash)).slice(0, query.limit);
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
  return handles.every((h) => h !== null) ? (handles as Handle[]) : null;
}

/**
 * The stores the handles name, in the order they first appear, then the current project when no handle names it;
 * a handle naming the current project counts as `#<id>`. Null once an unknown name is printed.
 */
function routeHandles(handles: Handle[], current: string): HandleStore[] | null {
  const self = projectName(current);
  const stores = new Map<string, HandleStore>();
  for (const h of handles) {
    const name = h.project === self ? "" : h.project;
    const root = name === "" ? current : rootOfName(name);
    if (root === null) {
      console.error(`crank-mem: no project ${name}.`);
      return null;
    }
    const store = stores.get(root) ?? { name, root, ids: [] };
    store.ids.push(h.id);
    stores.set(root, store);
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

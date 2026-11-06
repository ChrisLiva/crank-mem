import { EMBED_MODEL, embed, modelPresent } from "../daemon/embedder.ts";
import { redact } from "../daemon/redact.ts";
import { repoRelative } from "../hooks/lib/hook-io.ts";
import {
  formatLine,
  isObservationType,
  localDate,
  memoryPath,
  NO_MEMORY_NOTE,
  withReader,
  type MemoryReader,
  type Observation,
  type SearchQuery,
} from "../hooks/lib/memory.ts";
import { cliActor, recordUsage } from "../hooks/lib/usage.ts";
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
  const host = typeof flags["model-host"] === "string" ? flags["model-host"] : undefined;
  return withMemory(project.root, true, async (memory) => {
    const embeddable = memory.hasVectors(EMBED_MODEL);
    const vector = await queryVector(memory, text, host);
    if ((!embeddable && !modelPresent()) || (embeddable && vector === null)) {
      console.error(KEYWORD_ONLY_NOTE);
    }
    const applied = limit === undefined ? DEFAULT_LIMIT : Math.min(Number(limit), MAX_LIMIT);
    const stale = flags.stale === true;
    const hits = memory.search({
      text,
      vector,
      limit: applied,
      type: type ?? null,
      sinceMs,
      file: relFile,
      stale,
    });
    for (const hit of hits) console.log(formatLine(hit));
    recordUsage(project.root, cliActor(), {
      channel: "search",
      query: redact(text).slice(0, QUERY_CHARS),
      limit: applied,
      type: type ?? null,
      since: since ?? null,
      file: relFile,
      stale,
      mode: vector === null ? "keyword" : "hybrid",
      ids: hits.map((hit) => hit.id),
      ms: Date.now() - started,
    });
    return 0;
  });
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

const DEFAULT_DEPTH = 5;
const NUMBER = /^\d+$/;

export async function timeline(args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, COMMANDS.timeline.value);
  const [id] = rest;
  const depth = flags.depth ?? String(DEFAULT_DEPTH);
  if (rest.length !== 1 || !NUMBER.test(id!) || typeof depth !== "string" || !NUMBER.test(depth)) {
    console.error(COMMANDS.timeline.usage);
    return 1;
  }
  const project = openNearestProject();
  if (!project) return 1;
  return withMemory(project.root, false, (memory) => {
    const lines = memory.timeline(Number(id), Number(depth));
    recordUsage(project.root, cliActor(), {
      channel: "timeline",
      anchor: Number(id),
      depth: Number(depth),
      ids: lines === null ? null : lines.map((line) => line.id),
    });
    if (lines === null) {
      console.error(`crank-mem: no observation #${id}.`);
      return 1;
    }
    for (const line of lines) console.log(formatLine(line));
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
  if (args.length === 0 || !args.every((arg) => NUMBER.test(arg))) {
    console.error(COMMANDS.get.usage);
    return 1;
  }
  const project = openNearestProject();
  if (!project) return 1;
  return withMemory(project.root, false, (memory) => {
    const requested = args.slice(0, MAX_GET).map(Number);
    const found = memory.get(requested);
    recordUsage(project.root, cliActor(), {
      channel: "get",
      requested,
      found: found.map((o) => o.id),
    });
    if (found.length === 0) {
      console.error("crank-mem: no observation found.");
      return 1;
    }
    console.log(found.map(formatObservation).join("\n\n"));
    return 0;
  });
}

import { EMBED_MODEL, embed, modelPresent } from "../daemon/embedder.ts";
import { repoRelative } from "../hooks/lib/hook-io.ts";
import {
  formatLine, memoryPath, openMemory, MEMORY_NEWER_NOTE, MEMORY_UNREADABLE_NOTE, OBSERVATION_TYPES,
  type MemoryReader, type Observation, type ObservationType, type SearchQuery,
} from "../hooks/lib/memory.ts";
import { parseArgs } from "./args.ts";
import { openNearestProject } from "./project.ts";

export const NO_MEMORY_NOTE = "crank-mem: no memory exists yet.";
const KEYWORD_ONLY_NOTE = "crank-mem: keyword search only; run `crank-mem setup` for search by meaning.";

const STATE_NOTES = { newer: MEMORY_NEWER_NOTE, unreadable: MEMORY_UNREADABLE_NOTE } as const;

/**
 * Runs `fn` on the project's store, closing it after. A missing store is an
 * empty result for search (stdout, exit 0) and an error for the rest.
 */
async function withMemory(
  root: string, missingIsEmpty: boolean, fn: (memory: MemoryReader) => number | Promise<number>,
): Promise<number> {
  const opened = openMemory(memoryPath(root), "read");
  if (opened.status === "missing") {
    if (missingIsEmpty) {
      console.log(NO_MEMORY_NOTE);
      return 0;
    }
    console.error(NO_MEMORY_NOTE);
    return 1;
  }
  if (opened.status !== "open") {
    console.error(STATE_NOTES[opened.status]);
    return 1;
  }
  try {
    return await fn(opened.memory);
  } finally {
    opened.memory.close();
  }
}

const SEARCH_USAGE = "Usage: crank-mem search <query> [--limit n] [--type t] [--since YYYY-MM-DD] [--file path]";
const SEARCH_FLAGS = ["limit", "type", "since", "file", "model-host"];
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

/** A value flag's string, undefined when absent, or null when it came without a value. */
function stringFlag(value: string | boolean | undefined): string | undefined | null {
  return value === undefined ? undefined : typeof value === "string" ? value : null;
}

const isObservationType = (value: string): value is ObservationType => OBSERVATION_TYPES.some((t) => t === value);

export async function search(args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, SEARCH_FLAGS);
  // An unknown flag is query text, so `search --max-turns` finds that option.
  const extra = Object.keys(flags).filter((key) => key !== "" && !SEARCH_FLAGS.includes(key)).map((key) => `--${key}`);
  const text = [...rest, ...extra].join(" ");
  const usage = () => { console.error(SEARCH_USAGE); return 1; };
  const [limit, type, since, file] = [flags.limit, flags.type, flags.since, flags.file].map(stringFlag);
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
    if (!embeddable && !modelPresent()) console.error(KEYWORD_ONLY_NOTE);
    const hits = memory.search({
      text, vector: embeddable ? await queryVector(text, host) : null,
      limit: limit === undefined ? DEFAULT_LIMIT : Math.min(Number(limit), MAX_LIMIT),
      type: type ?? null, sinceMs, file: relFile,
    });
    for (const hit of hits) console.log(formatLine(hit));
    return 0;
  });
}

/** The query's embedding, or null with a note on stderr when the local model cannot run; never fetches. */
async function queryVector(text: string, host: string | undefined): Promise<SearchQuery["vector"]> {
  try {
    const [values] = await embed([text], { remote: false, host });
    return { model: EMBED_MODEL, values: values! };
  } catch {
    console.error(KEYWORD_ONLY_NOTE);
    return null;
  }
}

const TIMELINE_USAGE = "Usage: crank-mem timeline <id> [--depth n]";
const DEFAULT_DEPTH = 5;
const NUMBER = /^\d+$/;

export async function timeline(args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, ["depth"]);
  const [id] = rest;
  const depth = flags.depth ?? String(DEFAULT_DEPTH);
  if (rest.length !== 1 || !NUMBER.test(id!) || typeof depth !== "string" || !NUMBER.test(depth)) {
    console.error(TIMELINE_USAGE);
    return 1;
  }
  const project = openNearestProject();
  if (!project) return 1;
  return withMemory(project.root, false, (memory) => {
    const lines = memory.timeline(Number(id), Number(depth));
    if (lines === null) {
      console.error(`crank-mem: no observation #${id}.`);
      return 1;
    }
    for (const line of lines) console.log(formatLine(line));
    return 0;
  });
}

const GET_USAGE = "Usage: crank-mem get <id...>";
const MAX_GET = 20;

function formatObservation(o: Observation): string {
  const list = (paths: string[]) => (paths.length > 0 ? paths.join(", ") : "(none)");
  return [
    formatLine(o),
    `session: ${o.sessionId}`,
    `narrative: ${o.narrative}`,
    o.facts.length > 0 ? ["facts:", ...o.facts.map((fact) => `- ${fact}`)].join("\n") : "facts: (none)",
    `files read: ${list(o.filesRead)}`,
    `files modified: ${list(o.filesModified)}`,
  ].join("\n");
}

export async function get(args: string[]): Promise<number> {
  if (args.length === 0 || !args.every((arg) => NUMBER.test(arg))) {
    console.error(GET_USAGE);
    return 1;
  }
  const project = openNearestProject();
  if (!project) return 1;
  return withMemory(project.root, false, (memory) => {
    const found = memory.get(args.slice(0, MAX_GET).map(Number));
    if (found.length === 0) {
      console.error("crank-mem: no observation found.");
      return 1;
    }
    console.log(found.map(formatObservation).join("\n\n"));
    return 0;
  });
}

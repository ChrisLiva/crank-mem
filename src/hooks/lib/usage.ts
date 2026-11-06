import * as fs from "node:fs";
import * as path from "node:path";
import { isSensitiveFile } from "./config.ts";
import { isCodexPayload, type HookPayload } from "./hook-io.ts";
import { memoryPath } from "./memory.ts";

// One JSON line per use of a memory or code channel, appended to the
// usage.jsonl beside memory.db, so a linked worktree records into its main
// checkout. Recording is advisory: it never creates .crank/, never throws and
// never writes stdout, so a read-only .crank/ or a full disk loses the line.

export const USAGE_FILE = "usage.jsonl";
export const USAGE_ROTATED_FILE = "usage.1.jsonl";
/** An append that would take usage.jsonl past this first renames it to USAGE_ROTATED_FILE. */
export const USAGE_MAX_BYTES = 4 * 1024 * 1024;
/** Every list in a line, nested ones included, keeps only its first USAGE_MAX_LIST entries. */
const USAGE_MAX_LIST = 100;

export type UsageActor = { agent: "claude" | "codex" | "manual"; session: string | null };

export type UsageChannel =
  | "session-start"
  | "subagent-start"
  | "file-history"
  | "search"
  | "timeline"
  | "get"
  | "outline"
  | "unfold";

export type CodeOutcome = "ok" | "refused" | "no-reader" | "not-found";

export type UsageEvent =
  | {
      channel: "session-start";
      source: string | null;
      ids: number[];
      nextSteps: boolean;
      cerebrum: boolean;
      adrs: boolean;
      cerebrumBullets: { shown: number; total: number } | null;
      bytes: number;
      budget: number;
      notes: number;
      recallPointer: boolean;
    }
  | {
      channel: "subagent-start";
      agentType: string | null;
      excerptBytes: number;
      recallPointer: boolean;
    }
  | {
      channel: "file-history";
      tool: string;
      shown: { path: string; ids: number[] }[];
      empty: string[];
      seen: string[];
      cut: string[];
      bytes: number;
    }
  | {
      channel: "search";
      query: string;
      limit: number;
      type: string | null;
      since: string | null;
      file: string | null;
      stale: boolean;
      mode: "hybrid" | "keyword";
      ids: number[];
      ms: number;
    }
  | { channel: "timeline"; anchor: number; depth: number; ids: number[] | null }
  | { channel: "get"; requested: number[]; found: number[] }
  | {
      channel: "outline";
      path: string | null;
      from: number | null;
      matches: number;
      chars: number;
      capped: boolean;
      outcome: CodeOutcome;
      ms: number;
    }
  | {
      channel: "unfold";
      path: string | null;
      symbol: string;
      matches: number;
      chars: number;
      capped: boolean;
      outcome: CodeOutcome;
      ms: number;
    };

export type UsageLine = UsageEvent & UsageActor & { v: 1; ts: number };

function capLists(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, USAGE_MAX_LIST).map(capLists);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capLists(v)]));
  }
  return value;
}

/** The event with a top-level `file` or `path` whose basename is sensitive set to null. */
function dropSensitive(event: UsageEvent): UsageEvent {
  const fields: Record<string, unknown> = { ...event };
  for (const key of ["file", "path"]) {
    const value = fields[key];
    if (typeof value === "string" && isSensitiveFile(path.basename(value))) fields[key] = null;
  }
  return fields as UsageEvent;
}

/**
 * Append one usage line for `root`'s store, rotating the file first when the line would take it
 * past USAGE_MAX_BYTES. A sensitive `file` or `path` is recorded as null. Never throws.
 */
export function recordUsage(root: string, actor: UsageActor, event: UsageEvent): void {
  try {
    const file = path.join(path.dirname(memoryPath(root)), USAGE_FILE);
    const fields = { v: 1, ts: Date.now(), ...actor, ...dropSensitive(event) };
    const line = JSON.stringify(capLists(fields)) + "\n";
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {}
    if (size + Buffer.byteLength(line, "utf-8") > USAGE_MAX_BYTES) {
      fs.renameSync(file, path.join(path.dirname(file), USAGE_ROTATED_FILE));
    }
    fs.appendFileSync(file, line);
  } catch {}
}

/** The agent and session a hook payload names. */
export function hookActor(payload: HookPayload): UsageActor {
  return {
    agent: isCodexPayload(payload) ? "codex" : "claude",
    session: typeof payload.session_id === "string" ? payload.session_id : null,
  };
}

/** The agent and session of the shell a CLI command runs in (ADR 0012). */
export function cliActor(): UsageActor {
  return process.env.CLAUDECODE
    ? { agent: "claude", session: process.env.CLAUDE_CODE_SESSION_ID || null }
    : { agent: "manual", session: null };
}

/** Whether a parsed line is a `v: 1` line whose channel is known and whose read fields hold their types. */
function isUsageLine(value: unknown): value is UsageLine {
  if (typeof value !== "object" || value === null) return false;
  const line = value as Record<string, unknown>;
  if (line.v !== 1 || typeof line.ts !== "number") return false;
  switch (line.channel) {
    case "session-start":
      return Array.isArray(line.ids);
    case "search":
      return Array.isArray(line.ids) && typeof line.query === "string";
    case "timeline":
      return line.ids === null || Array.isArray(line.ids);
    case "get":
      return Array.isArray(line.requested) && Array.isArray(line.found);
    case "file-history":
      return (
        Array.isArray(line.empty) &&
        Array.isArray(line.shown) &&
        line.shown.every((s) => typeof s === "object" && s !== null && Array.isArray(s.ids))
      );
    case "subagent-start":
    case "outline":
    case "unfold":
      return true;
    default:
      return false;
  }
}

const parsed = new Map<string, { size: number; mtimeMs: number; lines: UsageLine[] }>();

/** The well-formed `v: 1` lines of one usage file, parsed again only when its size or mtime changed. */
function readUsageFile(file: string): UsageLine[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    parsed.delete(file);
    return [];
  }
  const cached = parsed.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.lines;
  const lines: UsageLine[] = [];
  try {
    for (const text of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!text) continue;
      try {
        const line: unknown = JSON.parse(text);
        if (isUsageLine(line)) lines.push(line);
      } catch {}
    }
  } catch {
    return [];
  }
  parsed.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, lines });
  return lines;
}

/** The usage lines of the store in `storeDir`, the rotated file's first. Never throws. */
export function readUsage(storeDir: string): UsageLine[] {
  return [
    ...readUsageFile(path.join(storeDir, USAGE_ROTATED_FILE)),
    ...readUsageFile(path.join(storeDir, USAGE_FILE)),
  ];
}

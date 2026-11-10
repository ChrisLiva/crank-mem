import * as fs from "node:fs";
import * as path from "node:path";
import { isObj, isSensitiveFile } from "../hooks/lib/config.ts";
import type { Position } from "../hooks/lib/memory.ts";
import { shellReadPaths } from "../hooks/lib/shell-reads.ts";
import { redact, stripBlocks } from "./redact.ts";

/** `paths`: raw path strings the delta's tool calls name, each once, in first-seen order. */
export type Distilled = {
  text: string;
  next: Position | null;
  truncated: boolean;
  records: number;
  paths: string[];
};

const INPUT_CAP = 500;
const RESULT_CAP = 500;
const LONG_RESULT_CAP = 4000;
const LONG_RESULT_TOOLS = new Set(["Agent", "Task", "Workflow"]);
const SKIPPED_TOOLS = new Set([
  "ToolSearch",
  "Skill",
  "TodoWrite",
  "ListMcpResourcesTool",
  "ListAgents",
  "Monitor",
  "ScheduleWakeup",
  "TaskStop",
]);
const SENSITIVE = "[sensitive file omitted]";
const BLOCK_SEP = "\n\n";

type Rec = Record<string, unknown>;
type Block = Record<string, unknown>;
type Call = { name: string; skip: boolean; sensitive: boolean };

/**
 * Renders a Claude Code transcript (JSONL) into redacted, capped text for a digest.
 * Covers records after `after` and stops at a record boundary before `maxChars`.
 * Reads only `file`: subagent transcripts are never followed.
 */
export function distill(file: string, after: Position | null, maxChars: number): Distilled {
  const all = readRecords(file);
  const calls = indexCalls(all);
  const covered = coveredRecords(all, after);

  const kept: Kept = { parts: [], length: 0, truncated: false };
  let next: Position | null = null;
  let records = 0;
  const paths = new Set<string>();
  for (const r of covered) {
    const conversation = isConversation(r);
    const text = conversation ? renderRecord(r, calls).join(BLOCK_SEP) : "";
    if (text && !keep(kept, text, maxChars)) break;
    if (conversation) {
      records++;
      for (const p of toolPaths(r)) paths.add(p);
    }
    next = positionOf(r) ?? next;
    if (kept.truncated) break;
  }
  const { parts, truncated } = kept;
  return { text: parts.join(BLOCK_SEP), next, truncated, records, paths: [...paths] };
}

type Kept = { parts: string[]; length: number; truncated: boolean };

/** Adds a record's text to `kept`; false when `maxChars` holds the record back. */
function keep(kept: Kept, text: string, maxChars: number): boolean {
  const added = (kept.parts.length ? BLOCK_SEP.length : 0) + text.length;
  if (kept.length + added <= maxChars) {
    kept.parts.push(text);
    kept.length += added;
    return true;
  }
  kept.truncated = true;
  if (kept.parts.length) return false;
  kept.parts.push(cut(text, maxChars)); // a lone over-limit record goes alone, cut
  return true;
}

function toolPaths(r: Rec): string[] {
  const out: string[] = [];
  for (const b of blocksOf(r)) {
    if (b.type !== "tool_use" || !isObj(b.input)) continue;
    const { file_path, path: p, notebook_path, command } = b.input;
    for (const v of [file_path, p, notebook_path]) if (typeof v === "string") out.push(v);
    if (b.name === "Bash" && typeof command === "string") out.push(...shellReadPaths(command));
  }
  return out;
}

function readRecords(file: string): Rec[] {
  const out: Rec[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    try {
      const r: unknown = JSON.parse(line);
      if (isObj(r)) out.push(r);
    } catch {
      // a malformed, empty or partial (still being written) line is skipped
    }
  }
  return out;
}

function positionOf(r: Rec): Position | null {
  return typeof r.uuid === "string" && typeof r.timestamp === "string"
    ? { uuid: r.uuid, timestamp: r.timestamp }
    : null;
}

function coveredRecords(all: Rec[], after: Position | null): Rec[] {
  if (!after) return all;
  const i = all.findIndex((r) => r.uuid === after.uuid);
  if (i >= 0) return all.slice(i + 1);
  const since = Date.parse(after.timestamp);
  return all.filter((r) => typeof r.timestamp === "string" && Date.parse(r.timestamp) > since);
}

function isConversation(r: Rec): boolean {
  return (r.type === "user" || r.type === "assistant") && r.isCompactSummary !== true;
}

function contentOf(r: Rec): unknown {
  const message = r.message;
  return isObj(message) ? message.content : undefined;
}

function blocksOf(r: Rec): Block[] {
  const content = contentOf(r);
  return Array.isArray(content) ? content.filter(isObj) : [];
}

/** Every tool_use id in the file, so a result in a delta keeps its call's name and treatment. */
function indexCalls(all: Rec[]): Map<string, Call> {
  const calls = new Map<string, Call>();
  for (const r of all) {
    for (const b of blocksOf(r)) {
      if (b.type !== "tool_use" || typeof b.id !== "string") continue;
      const name = typeof b.name === "string" ? b.name : "unknown";
      calls.set(b.id, {
        name,
        skip: SKIPPED_TOOLS.has(name),
        sensitive: touchesSensitiveFile(name, b.input),
      });
    }
  }
  return calls;
}

function touchesSensitiveFile(name: string, input: unknown): boolean {
  if (!isObj(input)) return false;
  const { file_path, path: p, command } = input;
  const candidates = [file_path, p].filter((v): v is string => typeof v === "string");
  if (name === "Bash" && typeof command === "string") {
    candidates.push(...command.split(/\s+/).map((t) => t.replace(/["']/g, "")));
  }
  return candidates.some((c) => c !== "" && isSensitiveFile(path.posix.basename(c)));
}

function clean(text: string): string {
  return redact(stripBlocks(text));
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...[${text.length - max} chars cut]`;
}

function renderRecord(r: Rec, calls: Map<string, Call>): string[] {
  const role = r.type === "user" ? "[USER]" : "[ASSISTANT]";
  const content = contentOf(r);
  const blocks: Block[] =
    typeof content === "string" ? [{ type: "text", text: content }] : blocksOf(r);
  const out: string[] = [];
  for (const b of blocks) {
    const line = renderBlock(b, role, calls);
    if (line !== null) out.push(line);
  }
  return out;
}

/** One block's line, or null when the block is left out. */
function renderBlock(b: Block, role: string, calls: Map<string, Call>): string | null {
  if (b.type === "text") return renderText(b, role);
  if (b.type === "tool_use") return renderToolUse(b, calls);
  if (b.type === "tool_result") return renderToolResult(b, calls);
  return null; // thinking, top-level image and any other block type are left out
}

function renderText(b: Block, role: string): string | null {
  if (typeof b.text !== "string") return null;
  const text = clean(b.text);
  return text.trim() ? `${role}\n${text}` : null;
}

function renderToolUse(b: Block, calls: Map<string, Call>): string | null {
  const call = typeof b.id === "string" ? calls.get(b.id) : undefined;
  const name = call?.name ?? (typeof b.name === "string" ? b.name : "unknown");
  if (call?.skip) return null;
  const body = call?.sensitive ? SENSITIVE : cut(clean(JSON.stringify(b.input ?? {})), INPUT_CAP);
  return `[TOOL_USE ${name}] ${body}`;
}

function renderToolResult(b: Block, calls: Map<string, Call>): string | null {
  const call = typeof b.tool_use_id === "string" ? calls.get(b.tool_use_id) : undefined;
  const name = call?.name ?? "unknown";
  if (call?.skip) return null;
  const cap = LONG_RESULT_TOOLS.has(name) ? LONG_RESULT_CAP : RESULT_CAP;
  const body = call?.sensitive ? SENSITIVE : cut(clean(resultText(b.content)), cap);
  return `[TOOL_RESULT ${name}] ${body}`;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: unknown) => {
      const block: Block = isObj(b) ? b : {};
      return block.type === "text" && typeof block.text === "string"
        ? block.text
        : `[${String(block.type)}]`;
    })
    .join("\n");
}

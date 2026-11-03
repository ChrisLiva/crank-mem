import * as fs from "node:fs";
import * as path from "node:path";
import { isSensitiveFile } from "../hooks/lib/config.ts";
import { isObj } from "../hooks/lib/hook-io.ts";
import type { Position } from "../hooks/lib/memory.ts";
import { redact, stripBlocks } from "./redact.ts";

export type Distilled = { text: string; next: Position | null; truncated: boolean; records: number };

const INPUT_CAP = 500;
const RESULT_CAP = 500;
const LONG_RESULT_CAP = 4000;
const LONG_RESULT_TOOLS = new Set(["Agent", "Task", "Workflow"]);
const SKIPPED_TOOLS = new Set([
  "ToolSearch", "Skill", "TodoWrite", "ListMcpResourcesTool", "ListAgents", "Monitor", "ScheduleWakeup", "TaskStop",
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

  const parts: string[] = [];
  let length = 0;
  let next: Position | null = null;
  let records = 0;
  let truncated = false;
  for (const r of covered) {
    const conversation = isConversation(r);
    const text = conversation ? renderRecord(r, calls).join(BLOCK_SEP) : "";
    if (text) {
      const added = (parts.length ? BLOCK_SEP.length : 0) + text.length;
      if (length + added > maxChars) {
        truncated = true;
        if (parts.length) break;
        parts.push(cut(text, maxChars)); // a lone over-limit record goes alone, cut
      } else {
        parts.push(text);
        length += added;
      }
    }
    if (conversation) records++;
    next = positionOf(r) ?? next;
    if (truncated) break;
  }
  return { text: parts.join(BLOCK_SEP), next, truncated, records };
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
  return typeof r.uuid === "string" && typeof r.timestamp === "string" ? { uuid: r.uuid, timestamp: r.timestamp } : null;
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
  return message && typeof message === "object" ? (message as Rec).content : undefined;
}

function blocksOf(r: Rec): Block[] {
  const content = contentOf(r);
  return Array.isArray(content) ? content.filter((b): b is Block => !!b && typeof b === "object") : [];
}

/** Every tool_use id in the file, so a result in a delta keeps its call's name and treatment. */
function indexCalls(all: Rec[]): Map<string, Call> {
  const calls = new Map<string, Call>();
  for (const r of all) {
    for (const b of blocksOf(r)) {
      if (b.type !== "tool_use" || typeof b.id !== "string") continue;
      const name = typeof b.name === "string" ? b.name : "unknown";
      calls.set(b.id, { name, skip: SKIPPED_TOOLS.has(name), sensitive: touchesSensitiveFile(name, b.input) });
    }
  }
  return calls;
}

function touchesSensitiveFile(name: string, input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const { file_path, path: p, command } = input as Rec;
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
  const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : blocksOf(r);
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      const text = clean(b.text);
      if (text.trim()) out.push(`${role}\n${text}`);
    } else if (b.type === "tool_use") {
      const call = typeof b.id === "string" ? calls.get(b.id) : undefined;
      const name = call?.name ?? (typeof b.name === "string" ? b.name : "unknown");
      if (call?.skip) continue;
      const body = call?.sensitive ? SENSITIVE : cut(clean(JSON.stringify(b.input ?? {})), INPUT_CAP);
      out.push(`[TOOL_USE ${name}] ${body}`);
    } else if (b.type === "tool_result") {
      const call = typeof b.tool_use_id === "string" ? calls.get(b.tool_use_id) : undefined;
      const name = call?.name ?? "unknown";
      if (call?.skip) continue;
      const cap = LONG_RESULT_TOOLS.has(name) ? LONG_RESULT_CAP : RESULT_CAP;
      const body = call?.sensitive ? SENSITIVE : cut(clean(resultText(b.content)), cap);
      out.push(`[TOOL_RESULT ${name}] ${body}`);
    }
    // thinking, top-level image and any other block type are left out
  }
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: unknown) => {
      const block = (b && typeof b === "object" ? b : {}) as Block;
      return block.type === "text" && typeof block.text === "string" ? block.text : `[${String(block.type)}]`;
    })
    .join("\n");
}

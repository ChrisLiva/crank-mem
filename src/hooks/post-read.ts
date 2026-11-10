import * as fs from "node:fs";
import * as path from "node:path";
import {
  readStdin,
  parsePayload,
  findProjectRoot,
  emitAdditionalContext,
  runAdvisoryHook,
  memoryPaths,
  isProjectFile,
  type HookPayload,
} from "./lib/hook-io.ts";
import { CRANK_DIR, loadConfig } from "./lib/config.ts";
import { debugEvent, enableDebug, safePath } from "./lib/debug.ts";
import { formatLine, memoryPath, openMemory, type MemoryReader } from "./lib/memory.ts";
import { shellReadPaths } from "./lib/shell-reads.ts";
import { transcriptStem } from "./lib/spool.ts";
import { SEEN_DIR, crankHome, ensureCrankHome, writeJsonAtomic } from "./lib/user-state.ts";
import { hookActor, recordUsage } from "./lib/usage.ts";

// PostToolUse hook for Claude's Read and Bash, Claude Code only (ADR 0009).
// When the agent reads a file memory has observations on, it adds that file's
// newest lines, once per file per agent per session. Every path exits 0.

const HISTORY_LINES = 5;
const MAX_BYTES = 1536;
const SEP = "\n\n";

function readPaths(payload: HookPayload): string[] {
  const input = payload.tool_input ?? {};
  if (payload.tool_name === "Read")
    return typeof input.file_path === "string" ? [input.file_path] : [];
  if (payload.tool_name === "Bash")
    return typeof input.command === "string" ? shellReadPaths(input.command) : [];
  return [];
}

function readSeen(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function changedSince(file: string, ms: number): boolean {
  try {
    return fs.statSync(file).mtimeMs > ms;
  } catch {
    return false;
  }
}

function agentOf(payload: HookPayload): string {
  return typeof payload.agent_id === "string" && /^[\w-]+$/.test(payload.agent_id)
    ? payload.agent_id
    : "main";
}

type Histories = {
  sections: string[];
  shown: { path: string; ids: number[] }[];
  empty: string[];
  cut: string[];
};

/** Each unseen path's history section, in order, until the next one would pass MAX_BYTES. */
function histories(memory: MemoryReader, root: string, unseen: string[]): Histories {
  const out: Histories = { sections: [], shown: [], empty: [], cut: [] };
  for (const [i, rel] of unseen.entries()) {
    const lines = memory.fileHistory(rel, HISTORY_LINES);
    if (lines.length === 0) {
      out.empty.push(rel);
      continue;
    }
    const tag = changedSince(path.join(root, rel), lines[0]!.createdAtMs)
      ? " [file changed since]"
      : "";
    const section = `History of ${rel}:${tag}\n` + lines.map(formatLine).join("\n");
    if (Buffer.byteLength([...out.sections, section].join(SEP)) > MAX_BYTES) {
      out.cut = unseen.slice(i);
      break;
    }
    out.sections.push(section);
    out.shown.push({ path: rel, ids: lines.map((l) => l.id) });
  }
  return out;
}

function markSeen(seenFile: string, seen: string[], marked: string[]): void {
  try {
    ensureCrankHome();
    writeJsonAtomic(seenFile, [...seen, ...marked]);
  } catch {
    // A lost marker costs only a repeat of this history.
  }
}

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const paths = readPaths(payload);
  if (paths.length === 0) return;

  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const root = findProjectRoot(cwd);
  if (!root) return;
  const crankDir = path.join(root, CRANK_DIR);
  enableDebug(crankDir, loadConfig(crankDir).debug);

  const stem = transcriptStem(payload.transcript_path);
  if (!stem) return;
  const agent = agentOf(payload);

  const rels = memoryPaths(root, cwd, paths).filter((r) => isProjectFile(root, r));
  if (rels.length === 0) return;

  const file = memoryPath(root);
  if (!fs.existsSync(file)) return;

  const seenFile = path.join(crankHome(), SEEN_DIR, `${stem}-${agent}.json`);
  const seen = readSeen(seenFile);
  const opened = openMemory(file, "read");
  if (opened.status !== "open") return;

  const unseen = rels.filter((r) => !seen.includes(r));
  let found: Histories;
  try {
    found = histories(opened.memory, root, unseen);
  } finally {
    opened.memory.close();
  }
  const { sections, shown, empty, cut } = found;

  const context = sections.join(SEP);
  if (sections.length > 0) {
    const marked = shown.map((s) => s.path);
    markSeen(seenFile, seen, marked);
    emitAdditionalContext("PostToolUse", context);
    debugEvent("file-history", { paths: marked.map(safePath) });
  }
  recordUsage(root, hookActor(payload), {
    channel: "file-history",
    tool: payload.tool_name!,
    shown,
    empty,
    seen: rels.filter((r) => seen.includes(r)),
    cut,
    bytes: Buffer.byteLength(context, "utf-8"),
  });
}

await runAdvisoryHook("post-read", main);

import * as fs from "node:fs";
import * as path from "node:path";
import {
  readStdin,
  parsePayload,
  findProjectRoot,
  emitAdditionalContext,
  runAdvisoryHook,
  memoryPaths,
  type HookPayload,
} from "./lib/hook-io.ts";
import { CRANK_DIR, loadConfig } from "./lib/config.ts";
import { debugEvent, enableDebug, safePath } from "./lib/debug.ts";
import { formatLine, memoryPath, openMemory } from "./lib/memory.ts";
import { shellReadPaths } from "./lib/shell-reads.ts";
import { transcriptStem } from "./lib/spool.ts";
import { SEEN_DIR, crankHome, ensureCrankHome, writeJsonAtomic } from "./lib/user-state.ts";

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
  const agent =
    typeof payload.agent_id === "string" && /^[\w-]+$/.test(payload.agent_id)
      ? payload.agent_id
      : "main";

  const rels = memoryPaths(root, cwd, paths);
  if (rels.length === 0) return;

  const file = memoryPath(root);
  if (!fs.existsSync(file)) return;

  const seenFile = path.join(crankHome(), SEEN_DIR, `${stem}-${agent}.json`);
  const seen = readSeen(seenFile);
  const opened = openMemory(file, "read");
  if (opened.status !== "open") return;

  const sections: string[] = [];
  const marked: string[] = [];
  try {
    for (const rel of rels.filter((r) => !seen.includes(r))) {
      const lines = opened.memory.fileHistory(rel, HISTORY_LINES);
      if (lines.length === 0) continue;
      const tag = changedSince(path.join(root, rel), lines[0]!.createdAtMs)
        ? " [file changed since]"
        : "";
      const section = `History of ${rel}:${tag}\n` + lines.map(formatLine).join("\n");
      if (Buffer.byteLength([...sections, section].join(SEP)) > MAX_BYTES) break;
      sections.push(section);
      marked.push(rel);
    }
  } finally {
    opened.memory.close();
  }
  if (sections.length === 0) return;

  try {
    ensureCrankHome();
    writeJsonAtomic(seenFile, [...seen, ...marked]);
  } catch {
    // A lost marker costs only a repeat of this history.
  }
  emitAdditionalContext("PostToolUse", sections.join(SEP));
  debugEvent("file-history", { paths: marked.map(safePath) });
}

await runAdvisoryHook("post-read", main);

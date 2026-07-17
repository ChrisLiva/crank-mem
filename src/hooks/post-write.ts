import * as path from "node:path";
import { readStdin, parsePayload, findProjectRoot, runAdvisoryHook } from "./lib/hook-io.ts";
import { loadConfig, CRANK_DIR } from "./lib/config.ts";
import { commitIndex } from "./lib/store.ts";
import { indexFile } from "./lib/scanner.ts";
import { HOOK_LOCK_BUDGET_MS } from "./lib/lock.ts";
import { parseApplyPatch } from "./lib/apply-patch.ts";

// PostToolUse hook: silent re-index of written files. Claude matcher is
// Write|Edit|MultiEdit (file_path in tool_input); Codex matcher is
// apply_patch (paths parsed from the patch text; Delete drops the entry).
// Emits no context — the next session-start picks the changes up. Exit 0
// on every path.

interface WriteOp {
  relPath: string;
  deleted: boolean;
}

function toWriteOps(payload: Record<string, unknown>, root: string, cwd: string): WriteOp[] {
  const toolName = payload.tool_name;
  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;

  // Relative tool paths are relative to the session cwd, which may be a
  // subdirectory of the project root.
  const rel = (p: string): string | null => {
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    const r = path.relative(root, abs);
    if (r.startsWith("..") || path.isAbsolute(r)) return null; // outside project
    return r.split(path.sep).join("/");
  };

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const p = toolInput.file_path;
    if (typeof p !== "string") return [];
    const r = rel(p);
    return r ? [{ relPath: r, deleted: false }] : [];
  }

  if (toolName === "apply_patch") {
    const cmd = toolInput.command;
    if (typeof cmd !== "string") return [];
    const out: WriteOp[] = [];
    for (const op of parseApplyPatch(cmd)) {
      const r = rel(op.path);
      if (r) out.push({ relPath: r, deleted: op.deleted });
    }
    return out;
  }

  return [];
}

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const root = findProjectRoot(cwd);
  if (!root) return;

  const crankDir = path.join(root, CRANK_DIR);
  const config = loadConfig(crankDir);

  const ops = toWriteOps(payload, root, cwd);
  if (ops.length === 0) return;

  commitIndex(crankDir, HOOK_LOCK_BUDGET_MS, (index) => {
    let dirty = false;
    for (const op of ops) {
      if (op.deleted) {
        if (index.files[op.relPath]) {
          delete index.files[op.relPath];
          dirty = true;
        }
        continue;
      }
      const entry = indexFile(root, op.relPath, config, "hook");
      if (!entry) continue;
      index.files[op.relPath] = entry;
      dirty = true;
    }
    return dirty ? index : null;
  });
}

await runAdvisoryHook("post-write", main);

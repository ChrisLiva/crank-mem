import * as fs from "node:fs";
import * as path from "node:path";
import { readStdin, parsePayload, findProjectRoot } from "./lib/hook-io.ts";
import { loadConfig, CRANK_DIR } from "./lib/config.ts";
import { loadIndex, saveIndex, saveAnatomyMd } from "./lib/store.ts";
import { indexFile, isIndexable } from "./lib/scanner.ts";
import { withLock, HOOK_LOCK_BUDGET_MS } from "./lib/lock.ts";
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

  withLock(crankDir, HOOK_LOCK_BUDGET_MS, () => {
    const index = loadIndex(crankDir);
    let dirty = false;
    for (const op of ops) {
      if (op.deleted) {
        if (index.files[op.relPath]) {
          delete index.files[op.relPath];
          dirty = true;
        }
        continue;
      }
      const abs = path.join(root, op.relPath);
      // Cheap size/exclusion gate before slurping the file — a hook must not
      // read a large or binary write just to reject it.
      let size: number;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue;
      }
      if (!isIndexable(op.relPath, size, config)) continue;
      const entry = indexFile(abs, "hook");
      if (!entry) continue;
      index.files[op.relPath] = entry;
      dirty = true;
    }
    if (dirty) {
      saveIndex(crankDir, index);
      saveAnatomyMd(crankDir, index);
    }
  });
}

try {
  await main();
} catch (err) {
  console.error(`crank-mem post-write: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);

import * as path from "node:path";
import {
  readStdin, parsePayload, findProjectRoot, emitAdditionalContext, runAdvisoryHook,
} from "./lib/hook-io.ts";
import { loadConfig, CRANK_DIR } from "./lib/config.ts";
import { commitIndex } from "./lib/store.ts";
import { indexFile } from "./lib/scanner.ts";
import { HOOK_LOCK_BUDGET_MS } from "./lib/lock.ts";
import { parseApplyPatch } from "./lib/apply-patch.ts";
import { cerebrumNudge } from "./lib/cerebrum-nudge.ts";
import { enableDebug, debugEvent, safePath } from "./lib/debug.ts";

// PostToolUse hook: re-index of written files. Claude matcher is
// Write|Edit|MultiEdit (file_path in tool_input); Codex matcher is
// apply_patch (paths parsed from the patch text; Delete drops the entry).
// For Claude the re-index is silent (the Stop hook carries the cerebrum nudge
// at turn end); for Codex, which has no usable end-of-turn channel, the nudge
// rides this hook's additionalContext instead (see docs/adr/0004). Exit 0 on
// every path.

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
  enableDebug(crankDir, config.debug);

  const ops = toWriteOps(payload, root, cwd);
  if (ops.length === 0) {
    // Also the shape a matcher/payload mismatch takes (ADR 0003) — worth a trace.
    debugEvent("no-write-ops", { tool: typeof payload.tool_name === "string" ? payload.tool_name : null });
    return;
  }

  const skipped: string[] = [];
  const committed = commitIndex(crankDir, HOOK_LOCK_BUDGET_MS, (index) => {
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
      if (!entry) {
        // Excluded, oversized, or unreadable — indistinguishable here, but the
        // path alone answers "why didn't my file get indexed?".
        skipped.push(safePath(op.relPath));
        continue;
      }
      index.files[op.relPath] = entry;
      dirty = true;
    }
    return dirty ? index : null;
  });
  // commitIndex returns null for BOTH "lock lost" and "nothing to write"; the
  // lock-timeout event from withLock is what disambiguates the two in the log.
  debugEvent("reindex", {
    tool: typeof payload.tool_name === "string" ? payload.tool_name : null,
    paths: ops.map((o) => safePath(o.relPath)),
    deletes: ops.filter((o) => o.deleted).length,
    skipped,
    committed: committed !== null,
    fileCount: committed?.meta.fileCount ?? null,
  });

  // Codex delivers writes as apply_patch and has no usable end-of-turn hook, so
  // its cerebrum nudge rides here (PostToolUse additionalContext is model-visible
  // on Codex — ADR 0001). Claude gets the same nudge at turn end via the Stop
  // hook, so it is skipped here to avoid double-nudging.
  if (payload.tool_name === "apply_patch") {
    const msg = cerebrumNudge(crankDir);
    if (msg) emitAdditionalContext("PostToolUse", msg);
  }
}

await runAdvisoryHook("post-write", main);

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

// Why a write produced nothing to index. Only `no-path` and `unhandled-tool`
// mean something is wrong (a payload or matcher mismatch — ADR 0003); the other
// two are the everyday shape of editing outside the index. Collapsing them into
// one bare "nothing happened" event, as this once did, makes the log useless for
// the failure it exists to catch.
type SkipReason = "no-path" | "unhandled-tool" | "outside-root" | "crank-internal";

interface WriteScan {
  ops: WriteOp[];
  /** Set only when `ops` is empty: why, plus where when the answer is a place. */
  skip: { reason: SkipReason; dir?: string } | null;
}

function toWriteOps(payload: Record<string, unknown>, root: string, cwd: string): WriteScan {
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

  // Writes under .crank/ (cerebrum.md above all) are never indexable, so
  // resolving them costs an index lock to learn nothing. Answer here instead.
  const internal = (r: string): boolean => r === CRANK_DIR || r.startsWith(`${CRANK_DIR}/`);

  // A directory is enough to answer "why wasn't my file indexed?", and no
  // filename means no sensitive basename can reach the log.
  const dirOf = (p: string): string =>
    path.dirname(path.isAbsolute(p) ? p : path.resolve(cwd, p));

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const p = toolInput.file_path;
    if (typeof p !== "string") return { ops: [], skip: { reason: "no-path" } };
    const r = rel(p);
    if (!r) return { ops: [], skip: { reason: "outside-root", dir: dirOf(p) } };
    if (internal(r)) return { ops: [], skip: { reason: "crank-internal", dir: path.dirname(r) } };
    return { ops: [{ relPath: r, deleted: false }], skip: null };
  }

  if (toolName === "apply_patch") {
    const cmd = toolInput.command;
    if (typeof cmd !== "string") return { ops: [], skip: { reason: "no-path" } };
    const out: WriteOp[] = [];
    let skip: WriteScan["skip"] = null;
    for (const op of parseApplyPatch(cmd)) {
      const r = rel(op.path);
      // A patch can touch several files; one unindexable path among indexable
      // ones is not a skip, so only the all-empty case reports a reason.
      if (!r) skip ??= { reason: "outside-root", dir: dirOf(op.path) };
      else if (internal(r)) skip ??= { reason: "crank-internal", dir: path.dirname(r) };
      else out.push({ relPath: r, deleted: op.deleted });
    }
    return { ops: out, skip: out.length ? null : (skip ?? { reason: "no-path" }) };
  }

  return { ops: [], skip: { reason: "unhandled-tool" } };
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

  const { ops, skip } = toWriteOps(payload, root, cwd);
  if (ops.length === 0) {
    // `no-path`/`unhandled-tool` here is the shape a matcher or payload
    // mismatch takes (ADR 0003); the other reasons are benign.
    debugEvent("no-write-ops", {
      tool: typeof payload.tool_name === "string" ? payload.tool_name : null,
      ...skip,
    });
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

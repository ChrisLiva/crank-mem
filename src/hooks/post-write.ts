import * as fs from "node:fs";
import * as path from "node:path";
import {
  readStdin,
  parsePayload,
  projectContext,
  runAdvisoryHook,
  type HookPayload,
} from "./lib/hook-io.ts";
import {
  CRANK_DIR,
  errorMessage,
  loadConfig,
  readJsonObject,
  type CrankConfig,
} from "./lib/config.ts";
import { commitIndex, INDEX_FILE, INDEX_VERSION, type AnatomyIndex } from "./lib/store.ts";
import { indexFile } from "./lib/scanner.ts";
import { HOOK_LOCK_BUDGET_MS } from "./lib/lock.ts";
import { parseApplyPatch } from "./lib/apply-patch.ts";
import { debugEvent, safePath } from "./lib/debug.ts";
import { ownerOf } from "./lib/owner.ts";
import { recordUntouched } from "./lib/untouched.ts";
import { hookActor } from "./lib/usage.ts";

// PostToolUse hook: re-index of written files. Claude matcher is
// Write|Edit|MultiEdit (file_path in tool_input); Codex matcher is
// apply_patch (paths parsed from the patch text; Delete drops the entry).
// Each path goes to the anatomy of the project that owns it (owner.ts).
// Exit 0 on every path.

interface WriteOp {
  /** The owning project's root. */
  root: string;
  relPath: string;
  deleted: boolean;
}

// Why a write produced nothing to index. Only `no-path` and `unhandled-tool`
// mean something is wrong (a payload or matcher mismatch — ADR 0003); the
// others are the everyday shape of editing outside any index.
type SkipReason = "no-path" | "unhandled-tool" | "outside-root" | "crank-internal" | "worktree";

interface WriteScan {
  ops: WriteOp[];
  /** Set only when `ops` is empty: why, plus where when the answer is a place. */
  skip: { reason: SkipReason; dir?: string } | null;
}

/** Where the session runs: relative tool paths resolve against `cwd`. */
type Session = { cwd: string; id: string | null };

type PathClass = Omit<WriteOp, "deleted"> | { skip: NonNullable<WriteScan["skip"]> };

function classifyPath(at: Session, p: string): PathClass {
  const abs = path.resolve(at.cwd, p);
  const owner = ownerOf(abs);
  // A directory is enough to answer "why wasn't my file indexed?", and no
  // filename means no sensitive basename can reach the log.
  if (owner.kind === "unowned") {
    if (owner.repo !== null) recordUntouched(owner.repo, at.id);
    return { skip: { reason: "outside-root", dir: path.dirname(abs) } };
  }
  // A linked worktree shares its main checkout's anatomy, which describes the main's files.
  if (owner.kind === "worktree") return { skip: { reason: "worktree", dir: path.dirname(abs) } };
  const r = owner.rel.split(path.sep).join("/");
  if (!r) return { skip: { reason: "no-path" } };
  // Writes under .crank/ (cerebrum.md above all) are never indexable, so
  // resolving them costs an index lock to learn nothing. Answer here instead.
  if (r === CRANK_DIR || r.startsWith(`${CRANK_DIR}/`)) {
    return { skip: { reason: "crank-internal", dir: path.dirname(r) } };
  }
  return { root: owner.root, relPath: r };
}

function claudeWriteOps(input: Record<string, unknown>, at: Session): WriteScan {
  const p = input.file_path;
  if (typeof p !== "string") return { ops: [], skip: { reason: "no-path" } };
  const c = classifyPath(at, p);
  if ("skip" in c) return { ops: [], skip: c.skip };
  return { ops: [{ ...c, deleted: false }], skip: null };
}

function patchWriteOps(cmd: unknown, at: Session): WriteScan {
  if (typeof cmd !== "string") return { ops: [], skip: { reason: "no-path" } };
  const out: WriteOp[] = [];
  let skip: WriteScan["skip"] = null;
  for (const op of parseApplyPatch(cmd)) {
    const c = classifyPath(at, op.path);
    // A patch can touch several files; one unindexable path among indexable
    // ones is not a skip, so only the all-empty case reports a reason.
    if ("skip" in c) skip ??= c.skip;
    else out.push({ ...c, deleted: op.deleted });
  }
  return { ops: out, skip: out.length ? null : (skip ?? { reason: "no-path" }) };
}

function toWriteOps(payload: HookPayload, at: Session): WriteScan {
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input ?? {};
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    return claudeWriteOps(toolInput, at);
  }
  if (toolName === "apply_patch") return patchWriteOps(toolInput.command, at);
  return { ops: [], skip: { reason: "unhandled-tool" } };
}

/** Drop `rel`'s entry; true when there was one. */
function dropEntry(index: AnatomyIndex, rel: string): boolean {
  if (!index.files[rel]) return false;
  delete index.files[rel];
  return true;
}

/** Apply `ops` to `index`; returns it when anything changed, else null. Unindexable paths land in `skipped`. */
function applyOps(
  index: AnatomyIndex,
  root: string,
  ops: WriteOp[],
  config: CrankConfig,
  skipped: string[],
): AnatomyIndex | null {
  let dirty = false;
  for (const op of ops) {
    const entry = op.deleted ? null : indexFile(root, op.relPath, config);
    if (!entry) {
      // Deleted, or excluded, binary, oversized, or unreadable — indistinguishable
      // here, but the path alone answers "why didn't my file get indexed?". An
      // entry from before the write is stale; drop it as refreshIndex does.
      dirty = dropEntry(index, op.relPath) || dirty;
      if (!op.deleted) skipped.push(safePath(op.relPath));
      continue;
    }
    // Pin the write so the next refresh keeps the file past max_files, until
    // the churn list carries it.
    if (!index.meta.churn?.paths.includes(op.relPath)) {
      entry.writeCount = (index.files[op.relPath]?.writeCount ?? 0) + 1;
    }
    index.files[op.relPath] = entry;
    dirty = true;
  }
  return dirty ? index : null;
}

/** Whether another project's anatomy may be written: absent, or at this `INDEX_VERSION`. */
function sameIndexVersion(crankDir: string): boolean {
  const file = path.join(crankDir, INDEX_FILE);
  const raw = readJsonObject(file);
  return raw === null ? !fs.existsSync(file) : raw.version === INDEX_VERSION;
}

type Start = { root: string; config: CrankConfig };

/**
 * Commit `ops` into the anatomy of the project at `root` under its lock. The start project's
 * own anatomy is written as before; another is written only at an equal index version, so a
 * newer or older crank-mem's index is never rebuilt from nothing. A failure stays with its owner.
 */
function commitOwner(start: Start, root: string, ops: WriteOp[], tool: string | null): void {
  const own = root === start.root;
  const crankDir = path.join(root, CRANK_DIR);
  try {
    const config = own ? start.config : loadConfig(crankDir);
    const skipped: string[] = [];
    const committed = commitIndex(crankDir, HOOK_LOCK_BUDGET_MS, (index) =>
      own || sameIndexVersion(crankDir) ? applyOps(index, root, ops, config, skipped) : null,
    );
    debugEvent("reindex", {
      tool,
      root: own ? null : root,
      paths: ops.map((o) => safePath(o.relPath)),
      deletes: ops.filter((o) => o.deleted).length,
      skipped,
      committed: committed !== null,
      fileCount: committed?.meta.fileCount ?? null,
    });
  } catch (err) {
    debugEvent("reindex-failed", { tool, root: own ? null : root, error: errorMessage(err) });
  }
}

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const ctx = projectContext(payload);
  if (!ctx) return;

  const tool = typeof payload.tool_name === "string" ? payload.tool_name : null;
  const { ops, skip } = toWriteOps(payload, { cwd: ctx.cwd, id: hookActor(payload).session });
  if (ops.length === 0) {
    debugEvent("no-write-ops", { tool, ...skip });
    return;
  }

  const byOwner = new Map<string, WriteOp[]>();
  for (const op of ops) byOwner.set(op.root, [...(byOwner.get(op.root) ?? []), op]);
  for (const [root, owned] of byOwner) commitOwner(ctx, root, owned, tool);
}

await runAdvisoryHook("post-write", main);

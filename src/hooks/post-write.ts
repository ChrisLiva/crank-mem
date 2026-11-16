import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import {
  readStdin,
  parsePayload,
  projectContext,
  runAdvisoryHook,
  type HookPayload,
} from "./lib/hook-io.ts";
import { CRANK_DIR, errorMessage, loadConfig, type CrankConfig } from "./lib/config.ts";
import { parseApplyPatch } from "./lib/apply-patch.ts";
import { debugEvent, safePath } from "./lib/debug.ts";
import { toPosix } from "./lib/indexable.ts";
import { ownerOf } from "./lib/owner.ts";
import { deletePaths, openCodeDb, parseable, upsertFileFacts } from "./lib/code-db.ts";
import { transaction } from "./lib/transaction.ts";
import { readChurn } from "./lib/activity.ts";
import { fileFacts } from "./lib/scanner.ts";
import { ensureDaemon } from "./lib/spool.ts";
import { readStopState } from "./lib/user-state.ts";
import { recordUntouched } from "./lib/untouched.ts";
import { hookActor } from "./lib/usage.ts";

// PostToolUse hook: refresh of written files' facts in code.db. Claude matcher is
// Write|Edit|MultiEdit (file_path in tool_input); Codex matcher is
// apply_patch (paths parsed from the patch text; Delete drops the file's rows).
// Each path goes to the code.db of the project that owns it (owner.ts).
// Exit 0 on every path.

interface WriteOp {
  root: string;
  relPath: string;
  deleted: boolean;
}

// Why a write produced nothing to index. Only `no-path` and `unhandled-tool`
// mean something is wrong (a payload or matcher mismatch — ADR 0003); every
// other reason is the everyday shape of editing outside any index.
type SkipReason =
  | "no-path"
  | "unhandled-tool"
  | "outside-root"
  | "crank-internal"
  | "worktree"
  | "owner-root";

interface WriteScan {
  ops: WriteOp[];
  /** Set only when `ops` is empty: why, plus where when the answer is a place. */
  skip: { reason: SkipReason; dir?: string } | null;
}

/** Where the session runs: relative tool paths resolve against `cwd`. */
type Session = { cwd: string; id: string | null; unowned: Set<string> };

type PathClass = Omit<WriteOp, "deleted"> | { skip: NonNullable<WriteScan["skip"]> };

function classifyPath(at: Session, p: string): PathClass {
  const abs = path.resolve(at.cwd, p);
  const owner = ownerOf(abs);
  // A directory is enough to answer "why wasn't my file indexed?", and no
  // filename means no sensitive basename can reach the log.
  if (owner.kind === "unowned") {
    if (owner.repo !== null) at.unowned.add(owner.repo);
    return { skip: { reason: "outside-root", dir: path.dirname(abs) } };
  }
  // A linked worktree shares its main checkout's code.db, which describes the main's files.
  if (owner.kind === "worktree") return { skip: { reason: "worktree", dir: path.dirname(abs) } };
  const r = toPosix(owner.rel);
  if (!r) return { skip: { reason: "owner-root", dir: owner.root } };
  // Writes under .crank/ (cerebrum.md above all) are never indexable, so
  // resolving them costs a store open to learn nothing. Answer here instead.
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

type Start = { root: string; config: CrankConfig };

/** How long a write waits on another process's hold of a code.db. */
const GRAPH_BUSY_MS = 500;

/**
 * Applies `ops` to the open code.db in one transaction: a delete or a path the index no longer
 * takes loses its rows, any other file's facts are upserted and its write count rises unless the
 * churn list carries it. A path the index does not take, other than a delete, lands in `skipped`
 * (the path alone answers "why didn't my file get indexed?"). Returns whether a written file
 * awaits a parse.
 */
function writeFacts(
  db: sqlite.DatabaseSync,
  root: string,
  ops: WriteOp[],
  config: CrankConfig,
  skipped: string[],
): boolean {
  const churned = new Set(readChurn(db)?.paths);
  let parseWanted = false;
  transaction(db, () => {
    for (const op of ops) {
      const facts = op.deleted ? null : fileFacts(root, op.relPath, config);
      if (facts === null) {
        deletePaths(db, [op.relPath]);
        if (!op.deleted) skipped.push(safePath(op.relPath));
        continue;
      }
      upsertFileFacts(db, op.relPath, facts);
      if (!churned.has(op.relPath))
        db.prepare("UPDATE files SET write_count = write_count + 1 WHERE path = ?").run(op.relPath);
      parseWanted ||= parseable(op.relPath, facts.size);
    }
  });
  return parseWanted;
}

/**
 * Writes `ops` into the code.db of the project at `root`. The start project's store is created
 * when absent; another project's is written only when it is open at this schema version and left
 * absent otherwise. A store that is corrupt, another version, unreadable or read-only is left
 * as it is. Returns whether a written file awaits a parse. A failure stays with its owner.
 */
function commitFacts(start: Start, root: string, ops: WriteOp[], tool: string | null): boolean {
  const own = root === start.root;
  try {
    const config = own ? start.config : loadConfig(path.join(root, CRANK_DIR));
    if (!own) {
      const probe = openCodeDb(root, "read");
      probe.db?.close();
      if (probe.status !== "open") {
        debugEvent("graph-skip", { root, status: probe.status });
        return false;
      }
    }
    const opened = openCodeDb(root, "write", GRAPH_BUSY_MS);
    if (opened.status !== "open" || !opened.db) {
      debugEvent("graph-skip", { root: own ? null : root, status: opened.status });
      return false;
    }
    try {
      const skipped: string[] = [];
      const parseWanted = writeFacts(opened.db, root, ops, config, skipped);
      debugEvent("reindex", {
        tool,
        root: own ? null : root,
        paths: ops.map((o) => safePath(o.relPath)),
        deletes: ops.filter((o) => o.deleted).length,
        skipped,
      });
      return parseWanted;
    } finally {
      opened.db.close();
    }
  } catch (err) {
    debugEvent("graph-failed", { root: own ? null : root, error: errorMessage(err) });
    return false;
  }
}

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  if (!payload) return;

  const ctx = projectContext(payload);
  if (!ctx) return;

  const tool = typeof payload.tool_name === "string" ? payload.tool_name : null;
  const at = { cwd: ctx.cwd, id: hookActor(payload).session, unowned: new Set<string>() };
  const { ops, skip } = toWriteOps(payload, at);
  recordUntouched(at.unowned, at.id);
  if (ops.length === 0) {
    debugEvent("no-write-ops", { tool, ...skip });
    return;
  }

  const byOwner = new Map<string, WriteOp[]>();
  for (const op of ops) byOwner.set(op.root, [...(byOwner.get(op.root) ?? []), op]);
  let parseWanted = false;
  for (const [root, owned] of byOwner) {
    parseWanted = commitFacts(ctx, root, owned, tool) || parseWanted;
  }
  if (parseWanted && readStopState() === null) ensureDaemon(ctx.config);
}

await runAdvisoryHook("post-write", main);

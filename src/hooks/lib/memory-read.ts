import type * as sqlite from "node:sqlite";
import type { DigestSummary, Memory, PendingWork, Position, SearchQuery } from "./memory.ts";
import type {
  ConsolidationOutcome,
  ConsolidationRow,
  Observation,
  ObservationLine,
  ObservationType,
  ProposalKind,
  ProposalRow,
  ProposalState,
  StaleRow,
} from "./wire.ts";

// The store's read queries, each taking the open `db` first; memory.ts → createMemory wires them.

type Row = Record<string, unknown>;

export const LINE_COLUMNS = "o.id, o.created_at, o.type, o.title, o.stale_at";
const NEWEST_FIRST = "ORDER BY o.created_at DESC, o.id DESC";
const UNEMBEDDED =
  "NOT EXISTS (SELECT 1 FROM observation_vectors v WHERE v.observation_id = o.id AND v.model = ?)";

export function toLine(row: Row): ObservationLine {
  return {
    id: Number(row.id),
    createdAtMs: Number(row.created_at),
    type: row.type as ObservationType,
    title: String(row.title),
    stale: row.stale_at !== null,
  };
}

/** The terms (on observations `o`) and their bind values that `search` and `list` narrow by. */
export function lineFilters(q: Pick<SearchQuery, "type" | "sinceMs" | "file" | "stale">): {
  filters: string[];
  params: sqlite.SQLInputValue[];
} {
  const filters: string[] = q.stale ? [] : ["o.stale_at IS NULL"];
  const params: sqlite.SQLInputValue[] = [];
  if (q.type !== null) {
    filters.push("o.type = ?");
    params.push(q.type);
  }
  if (q.sinceMs !== null) {
    filters.push("o.created_at >= ?");
    params.push(q.sinceMs);
  }
  if (q.file !== null) {
    filters.push("o.id IN (SELECT observation_id FROM observation_files WHERE path = ?)");
    params.push(q.file);
  }
  return { filters, params };
}

export function one(db: sqlite.DatabaseSync, sql: string, ...params: sqlite.SQLInputValue[]) {
  return db.prepare(sql).get(...params) as Row | undefined;
}

export function all(db: sqlite.DatabaseSync, sql: string, ...params: sqlite.SQLInputValue[]) {
  return db.prepare(sql).all(...params) as Row[];
}

export function list(db: sqlite.DatabaseSync, q: Parameters<Memory["list"]>[0]): ObservationLine[] {
  const { filters, params } = lineFilters({ ...q, sinceMs: null });
  if (q.before !== null) {
    filters.push("(o.created_at, o.id) < (?, ?)");
    params.push(q.before.createdAtMs, q.before.id);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  return all(
    db,
    `SELECT ${LINE_COLUMNS} FROM observations o ${where} ${NEWEST_FIRST} LIMIT ?`,
    ...params,
    q.limit,
  ).map(toLine);
}

export function position(db: sqlite.DatabaseSync, sessionId: string): Position | null {
  const row = one(db, "SELECT position_uuid, position_ts FROM sessions WHERE id = ?", sessionId);
  if (!row || row.position_uuid === null || row.position_ts === null) return null;
  return { uuid: String(row.position_uuid), timestamp: String(row.position_ts) };
}

export function hasVectors(db: sqlite.DatabaseSync, model: string): boolean {
  return one(db, "SELECT 1 FROM observation_vectors WHERE model = ? LIMIT 1", model) !== undefined;
}

export function latestSummary(db: sqlite.DatabaseSync, sessionId: string): DigestSummary | null {
  const row = one(
    db,
    `SELECT request, investigated, learned, completed, next_steps FROM digests
       WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    sessionId,
  );
  if (!row) return null;
  return {
    request: String(row.request),
    investigated: String(row.investigated),
    learned: String(row.learned),
    completed: String(row.completed),
    next_steps: String(row.next_steps),
  };
}

export function unembedded(
  db: sqlite.DatabaseSync,
  model: string,
  limit: number,
): ReturnType<Memory["unembedded"]> {
  return all(
    db,
    `SELECT o.id, o.title, o.narrative FROM observations o WHERE ${UNEMBEDDED}
       ORDER BY o.created_at, o.id LIMIT ?`,
    model,
    limit,
  ).map((row) => ({
    id: Number(row.id),
    text: `${String(row.title)}\n${String(row.narrative)}`,
  }));
}

export function timeline(
  db: sqlite.DatabaseSync,
  id: number,
  depth: number,
): ObservationLine[] | null {
  const anchor = one(db, `SELECT ${LINE_COLUMNS} FROM observations o WHERE o.id = ?`, id);
  if (!anchor) return null;
  const at = Number(anchor.created_at);
  const before = all(
    db,
    `SELECT ${LINE_COLUMNS} FROM observations o WHERE (o.created_at, o.id) < (?, ?) ${NEWEST_FIRST} LIMIT ?`,
    at,
    id,
    depth,
  ).reverse();
  const after = all(
    db,
    `SELECT ${LINE_COLUMNS} FROM observations o WHERE (o.created_at, o.id) > (?, ?)
       ORDER BY o.created_at, o.id LIMIT ?`,
    at,
    id,
    depth,
  );
  return [...before, anchor, ...after].map(toLine);
}

export function get(db: sqlite.DatabaseSync, ids: number[]): Observation[] {
  const found: Observation[] = [];
  for (const id of ids) {
    const row = one(
      db,
      `SELECT ${LINE_COLUMNS}, o.stale_reason, o.narrative, o.facts, d.session_id FROM observations o
         JOIN digests d ON d.id = o.digest_id WHERE o.id = ?`,
      id,
    );
    if (!row) continue;
    const files = all(
      db,
      "SELECT path, kind FROM observation_files WHERE observation_id = ? ORDER BY path",
      id,
    );
    found.push({
      ...toLine(row),
      sessionId: String(row.session_id),
      narrative: String(row.narrative),
      facts: JSON.parse(String(row.facts)) as string[],
      filesRead: files.filter((f) => f.kind === "read").map((f) => String(f.path)),
      filesModified: files.filter((f) => f.kind === "modified").map((f) => String(f.path)),
      staleFlag:
        row.stale_at === null
          ? null
          : { atMs: Number(row.stale_at), reason: String(row.stale_reason) },
    });
  }
  return found;
}

export function recent(db: sqlite.DatabaseSync, limit: number): ObservationLine[] {
  return list(db, { limit, type: null, file: null, stale: false, before: null });
}

export function latestNextSteps(db: sqlite.DatabaseSync): string | null {
  const row = one(db, "SELECT next_steps FROM digests ORDER BY created_at DESC, id DESC LIMIT 1");
  if (!row) return null;
  const text = String(row.next_steps).trim();
  return text.toLowerCase().replace(/\.$/, "") === "none" ? null : text;
}

export function fileHistory(
  db: sqlite.DatabaseSync,
  relPath: string,
  limit: number,
): ObservationLine[] {
  return list(db, { limit, type: null, file: relPath, stale: false, before: null });
}

export function stats(
  db: sqlite.DatabaseSync,
  model: string,
  sinceMs: number,
): ReturnType<Memory["stats"]> {
  const counts = one(
    db,
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE ${UNEMBEDDED}) AS pending FROM observations o`,
    model,
  )!;
  const digests = one(
    db,
    "SELECT MAX(created_at) AS last, COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= ?), 0) AS cost FROM digests",
    sinceMs,
  )!;
  const runCost = one(
    db,
    "SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM consolidations WHERE started_at >= ?",
    sinceMs,
  )!;
  const last = one(
    db,
    "SELECT started_at, outcome FROM consolidations ORDER BY started_at DESC, id DESC LIMIT 1",
  );
  const flags = one(
    db,
    `SELECT (SELECT COUNT(*) FROM proposals WHERE state = 'pending') AS proposals,
              (SELECT COUNT(*) FROM observations WHERE stale_at IS NOT NULL) AS stale`,
  )!;
  return {
    observations: Number(counts.total),
    unembedded: Number(counts.pending),
    lastDigestMs: digests.last === null ? null : Number(digests.last),
    costUsdSince: Number(digests.cost) + Number(runCost.cost),
    pendingProposals: Number(flags.proposals),
    staleRows: Number(flags.stale),
    lastConsolidation: last
      ? { startedMs: Number(last.started_at), outcome: last.outcome as ConsolidationOutcome }
      : null,
  };
}

export function pending(db: sqlite.DatabaseSync, limit: number): PendingWork {
  const proposals = all(
    db,
    "SELECT id, kind, bullet FROM proposals WHERE state = 'pending' ORDER BY created_at, id LIMIT ?",
    limit,
  ).map((row) => ({
    id: Number(row.id),
    kind: row.kind as ProposalKind,
    bullet: String(row.bullet),
  }));
  const stale = all(
    db,
    `SELECT id, title, narrative, stale_reason FROM observations
       WHERE stale_at IS NOT NULL AND stale_reviewed = 0 ORDER BY stale_at, id LIMIT ?`,
    limit,
  ).map((row) => ({
    id: Number(row.id),
    title: String(row.title),
    narrative: String(row.narrative),
    reason: String(row.stale_reason),
  }));
  const runs = one(
    db,
    `SELECT MAX(started_at) AS last, MAX(started_at) FILTER (WHERE outcome = 'ok') AS lastOk FROM consolidations`,
  )!;
  const ms = (v: unknown) => (v === null ? null : Number(v));
  return { proposals, stale, lastStartMs: ms(runs.last), lastOkStartMs: ms(runs.lastOk) };
}

export function proposalRows(
  db: sqlite.DatabaseSync,
  q: Parameters<Memory["proposalRows"]>[0],
): ProposalRow[] {
  const filters: string[] = [];
  const params: (string | number)[] = [];
  if (q.state !== null) {
    filters.push("state = ?");
    params.push(q.state);
  }
  if (q.beforeId !== null) {
    filters.push("id < ?");
    params.push(q.beforeId);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  return all(
    db,
    `SELECT id, kind, bullet, state, reason, created_at, decided_at FROM proposals ${where}
       ORDER BY id DESC LIMIT ?`,
    ...params,
    q.limit,
  ).map((row) => ({
    id: Number(row.id),
    kind: row.kind as ProposalKind,
    bullet: String(row.bullet),
    state: row.state as ProposalState,
    reason: row.reason === null ? null : String(row.reason),
    createdAtMs: Number(row.created_at),
    decidedAtMs: row.decided_at === null ? null : Number(row.decided_at),
  }));
}

export function staleRows(
  db: sqlite.DatabaseSync,
  q: Parameters<Memory["staleRows"]>[0],
): StaleRow[] {
  const before = q.before === null ? "" : "AND (stale_at, id) < (?, ?)";
  const params = q.before === null ? [] : [q.before.staleAtMs, q.before.id];
  return all(
    db,
    `SELECT id, title, stale_at, stale_reason, stale_reviewed FROM observations
       WHERE stale_at IS NOT NULL ${before} ORDER BY stale_at DESC, id DESC LIMIT ?`,
    ...params,
    q.limit,
  ).map((row) => ({
    id: Number(row.id),
    title: String(row.title),
    staleAtMs: Number(row.stale_at),
    reason: String(row.stale_reason),
    reviewed: Number(row.stale_reviewed) === 1,
  }));
}

export function consolidationRows(
  db: sqlite.DatabaseSync,
  q: Parameters<Memory["consolidationRows"]>[0],
): ConsolidationRow[] {
  const before = q.beforeId === null ? "" : "WHERE id < ?";
  const params = q.beforeId === null ? [] : [q.beforeId];
  return all(
    db,
    `SELECT id, started_at, finished_at, outcome, model, cost_usd FROM consolidations
       ${before} ORDER BY id DESC LIMIT ?`,
    ...params,
    q.limit,
  ).map((row) => ({
    id: Number(row.id),
    startedAtMs: Number(row.started_at),
    finishedAtMs: Number(row.finished_at),
    outcome: row.outcome as ConsolidationOutcome,
    model: row.model === null ? null : String(row.model),
    costUsd: Number(row.cost_usd),
  }));
}

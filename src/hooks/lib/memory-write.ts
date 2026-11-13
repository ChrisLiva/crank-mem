import * as crypto from "node:crypto";
import type * as sqlite from "node:sqlite";
import { ISO_DATE } from "./bullets.ts";
import type { DigestInput, Memory, Position, SessionKey } from "./memory.ts";
import { one, position } from "./memory-read.ts";
import { transaction } from "./memory-schema.ts";
import { dailyUpkeep } from "./store-upkeep.ts";

// The store's writes, each taking the open `db` first; memory.ts → createMemory wires them.

/** A proposal still pending after this many counted runs expires. */
const MAX_ATTEMPTS = 3;

/** sha256 hex of the text, lowercased, with whitespace runs collapsed and trimmed. */
function normalizedHash(text: string): string {
  return crypto
    .createHash("sha256")
    .update(text.toLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex");
}

/** An observation's dedupe key: its normalized title and narrative. */
function contentHash(title: string, narrative: string): string {
  return normalizedHash(title + "\n" + narrative);
}

/** A proposal's dedupe key: its normalized bullet without dates or the `()` they leave empty. */
function bulletHash(bullet: string): string {
  return normalizedHash(bullet.replace(ISO_DATE, "").replace(/\(\s*\)/g, ""));
}

export function samePosition(a: Position | null, b: Position | null): boolean {
  return a === null || b === null ? a === b : a.uuid === b.uuid && a.timestamp === b.timestamp;
}

export function appendDigest(db: sqlite.DatabaseSync, input: DigestInput): "appended" | "stale" {
  const { session, next, summary } = input;
  const stale = Symbol();
  const result = transaction(db, () => {
    if (!samePosition(position(db, session.id), input.expected)) return stale;
    db.prepare(
      `INSERT INTO sessions (id, agent, transcript_path, position_uuid, position_ts, rejections)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, transcript_path = excluded.transcript_path,
           position_uuid = excluded.position_uuid, position_ts = excluded.position_ts, rejections = 0`,
    ).run(session.id, session.agent, session.transcriptPath, next.uuid, next.timestamp);
    const now = Date.now();
    const digestId = db
      .prepare(
        `INSERT INTO digests (session_id, created_at, model, cost_usd, request, investigated, learned, completed, next_steps, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        now,
        input.model,
        input.costUsd,
        summary.request,
        summary.investigated,
        summary.learned,
        summary.completed,
        summary.next_steps,
        input.origin,
      ).lastInsertRowid;
    // ON CONFLICT names the unique column so a CHECK violation still throws; OR IGNORE would swallow it.
    const insertObservation = db.prepare(
      `INSERT INTO observations (digest_id, type, title, narrative, facts, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING`,
    );
    const insertFile = db.prepare(
      "INSERT OR IGNORE INTO observation_files (path, observation_id, kind) VALUES (?, ?, ?)",
    );
    const insertRef = db.prepare(
      "INSERT OR IGNORE INTO observation_refs (observation_id, project, path, kind) VALUES (?, ?, ?, ?)",
    );
    for (const o of input.observations) {
      const inserted = insertObservation.run(
        digestId,
        o.type,
        o.title,
        o.narrative,
        JSON.stringify(o.facts),
        contentHash(o.title, o.narrative),
        now,
      );
      if (inserted.changes === 0) continue;
      for (const file of o.filesRead) insertFile.run(file, inserted.lastInsertRowid, "read");
      for (const file of o.filesModified)
        insertFile.run(file, inserted.lastInsertRowid, "modified");
      for (const r of o.refs) insertRef.run(inserted.lastInsertRowid, r.project, r.path, r.kind);
    }
    const insertProposal = db.prepare(
      `INSERT INTO proposals (digest_id, kind, bullet, bullet_hash, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(bullet_hash) DO NOTHING`,
    );
    for (const p of input.proposals)
      insertProposal.run(digestId, p.kind, p.bullet, bulletHash(p.bullet), now);
    // A row keeps its first flag.
    const flag = db.prepare(
      "UPDATE observations SET stale_at = ?, stale_reason = ?, stale_reviewed = 0 WHERE id = ? AND stale_at IS NULL",
    );
    for (const f of input.stale) flag.run(now, f.reason, f.id);
    const link = db.prepare(
      `INSERT INTO project_links (project, last_ms) VALUES (?, ?)
         ON CONFLICT(project) DO UPDATE SET last_ms = MAX(last_ms, excluded.last_ms)`,
    );
    for (const name of input.links) link.run(name, now);
    return "appended" as const;
  });
  return result === stale ? "stale" : result;
}

export function recordRejection(db: sqlite.DatabaseSync, session: SessionKey): number {
  const row = one(
    db,
    `INSERT INTO sessions (id, agent, transcript_path, rejections) VALUES (?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET rejections = rejections + 1 RETURNING rejections`,
    session.id,
    session.agent,
    session.transcriptPath,
  );
  return Number(row!.rejections);
}

export function putVectors(
  db: sqlite.DatabaseSync,
  model: string,
  rows: Parameters<Memory["putVectors"]>[1],
): void {
  transaction(db, () => {
    const put = db.prepare(
      "INSERT OR REPLACE INTO observation_vectors (observation_id, model, vector) VALUES (?, ?, ?)",
    );
    for (const { id, vector } of rows) {
      put.run(id, model, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
    }
  });
}

export function recordConsolidation(
  db: sqlite.DatabaseSync,
  run: Parameters<Memory["recordConsolidation"]>[0],
): void {
  transaction(db, () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO consolidations (started_at, finished_at, outcome, model, cost_usd) VALUES (?, ?, ?, ?, ?)",
    ).run(run.startedMs, now, run.outcome, run.model, run.costUsd);
    if (run.outcome === "conflict") return;
    const attempt = db.prepare(
      "UPDATE proposals SET attempts = attempts + 1 WHERE id = ? AND state = 'pending'",
    );
    for (const id of run.sent) attempt.run(id);
    if (run.outcome === "ok") {
      const decide = db.prepare(
        "UPDATE proposals SET state = ?, reason = ?, decided_at = ? WHERE id = ? AND state = 'pending'",
      );
      for (const d of run.decided) decide.run(d.state, d.reason, now, d.id);
      const confirm = db.prepare(
        "UPDATE observations SET stale_reviewed = 1 WHERE id = ? AND stale_at IS NOT NULL",
      );
      const clear = db.prepare(
        "UPDATE observations SET stale_at = NULL, stale_reason = NULL, stale_reviewed = 0 WHERE id = ?",
      );
      for (const v of run.verdicts) (v.verdict === "confirmed" ? confirm : clear).run(v.id);
    }
    const expire = db.prepare(
      "UPDATE proposals SET state = 'expired', decided_at = ? WHERE id = ? AND state = 'pending' AND attempts >= ?",
    );
    for (const id of run.sent) expire.run(now, id, MAX_ATTEMPTS);
  });
}

export function maintain(
  db: sqlite.DatabaseSync,
  file: string,
  nowMs = Date.now(),
): ReturnType<Memory["maintain"]> {
  return dailyUpkeep(db, file, nowMs, (cutoff) =>
    transaction(db, () => {
      const expired = "SELECT id FROM observations WHERE stale_at IS NOT NULL AND stale_at < ?";
      db.prepare(`DELETE FROM observation_files WHERE observation_id IN (${expired})`).run(cutoff);
      db.prepare(`DELETE FROM observation_refs WHERE observation_id IN (${expired})`).run(cutoff);
      db.prepare(`DELETE FROM observation_vectors WHERE observation_id IN (${expired})`).run(
        cutoff,
      );
      return Number(
        db
          .prepare("DELETE FROM observations WHERE stale_at IS NOT NULL AND stale_at < ?")
          .run(cutoff).changes,
      );
    }),
  );
}

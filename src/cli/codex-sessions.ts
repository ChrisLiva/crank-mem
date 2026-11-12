import * as fs from "node:fs";
import * as path from "node:path";
import { INJECTION_HEADING } from "../hooks/lib/injection.ts";

// Did crank's SessionStart injection reach this project's Codex threads?
// Rollouts live at sessions/YYYY/MM/DD/rollout-*.jsonl (ADR 0006). A file may
// embed its parent's session_meta, so each file is classified by its FIRST one.

const DAY_MS = 86_400_000;
/** The injection message as a rollout records it: a content item whose text opens with the heading. */
const INJECTED = `"text":${JSON.stringify(INJECTION_HEADING).slice(0, -1)}`;
/** A thread the user never prompted has no turn, so SessionStart had nothing to attach to. */
const TURN = `"type":"turn_context"`;

export interface InjectionGaps {
  /** Root threads (not sub-agents) for this project with at least one turn. */
  roots: number;
  /** Of those, the ones whose rollout holds no crank injection. */
  missed: number;
}

/** The first line of a file, read in chunks so a large rollout is never loaded whole. */
function firstLine(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(65_536);
    let out = "";
    for (let pos = 0; out.length < 8 * 1024 * 1024;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) return out;
      const chunk = buf.toString("utf-8", 0, n);
      const nl = chunk.indexOf("\n");
      if (nl >= 0) return out + chunk.slice(0, nl);
      out += chunk;
      pos += n;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((d) => /^\d+$/.test(d))
      .sort();
  } catch {
    return [];
  }
}

/** The y/m/d day directories under `sessionsDir`, oldest first, minus days wholly before `sinceMs`. */
function dayDirs(sessionsDir: string, sinceMs: number | null): string[] {
  const days: string[] = [];
  for (const y of subdirs(sessionsDir)) {
    for (const m of subdirs(path.join(sessionsDir, y))) {
      for (const d of subdirs(path.join(sessionsDir, y, m))) {
        // Directory dates are local; a day of slack keeps the boundary day in.
        if (sinceMs !== null && Date.UTC(+y, +m - 1, +d) + 2 * DAY_MS < sinceMs) continue;
        days.push(path.join(sessionsDir, y, m, d));
      }
    }
  }
  return days;
}

function rolloutFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** A rollout's verdict: null when it is not this project's root thread since `sinceMs` with a turn, or unreadable. */
function classifyRollout(
  file: string,
  root: string,
  sinceMs: number | null,
): "injected" | "missed" | null {
  try {
    const meta = JSON.parse(firstLine(file));
    const p = meta?.payload;
    if (meta?.type !== "session_meta" || p?.cwd !== root) return null;
    if (p.parent_thread_id || p.thread_source === "subagent") return null;
    if (sinceMs !== null && !(Date.parse(p.timestamp ?? meta.timestamp) >= sinceMs)) return null;
    const text = fs.readFileSync(file, "utf-8");
    if (!text.includes(TURN)) return null;
    return text.includes(INJECTED) ? "injected" : "missed";
  } catch {
    return null;
  }
}

/** Count this project's root Codex threads since `sinceMs` (all when null) and how many lack the injection. */
export function codexInjectionGaps(
  sessionsDir: string,
  root: string,
  sinceMs: number | null,
): InjectionGaps {
  const gaps: InjectionGaps = { roots: 0, missed: 0 };
  for (const dir of dayDirs(sessionsDir, sinceMs)) {
    for (const file of rolloutFiles(dir)) {
      const verdict = classifyRollout(file, root, sinceMs);
      if (verdict === null) continue;
      gaps.roots++;
      if (verdict === "missed") gaps.missed++;
    }
  }
  return gaps;
}

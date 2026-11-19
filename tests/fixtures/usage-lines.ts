import * as fs from "node:fs";
import * as path from "node:path";
import { runCli } from "../helpers.ts";

export const HOOK = "src/hooks/session-start.ts";
export const SUBAGENT_HOOK = "src/hooks/subagent-start.ts";
export const READ_HOOK = "src/hooks/post-read.ts";
export const TRANSCRIPT = "/u/.claude/projects/-proj/551be959.jsonl";

export function usageLines(root: string): Array<Record<string, any>> {
  return fs
    .readFileSync(path.join(root, ".crank/usage.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The number of lines in the project's usage.jsonl, 0 when it is absent. */
export function lineCount(root: string): number {
  const file = path.join(root, ".crank/usage.jsonl");
  return fs.existsSync(file) ? usageLines(root).length : 0;
}

/** The ids of a run's printed `#<id>` lines, in order. */
export function printedIds(stdout: string): number[] {
  return [...stdout.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
}

export const CLAUDE_SHELL = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "sess-1" };

/** A crank-mem command run from a Claude Code shell with session sess-1. */
export function claudeCli(root: string, args: string[], env: Record<string, string> = {}) {
  return runCli(root, args, { ...CLAUDE_SHELL, ...env });
}

export const THREE =
  "export function one() {}\nexport function two() {}\nexport function three() {}\n";

export const D = 86_400_000;
export const X = 999_999;
export const CHANNELS = [
  "anatomy",
  "callees",
  "callers",
  "file-history",
  "get",
  "impact",
  "outline",
  "search",
  "session-start",
  "subagent-start",
  "symbol-lookup",
  "timeline",
  "unfold",
];
const SEARCH = {
  limit: 10,
  type: null,
  since: null,
  file: null,
  stale: false,
  ms: 1,
  mode: "keyword",
};

export function searchLine(
  ts: number,
  agent: string,
  session: string | null,
  query: string,
  ids: number[],
) {
  return { v: 1, ts, agent, session, channel: "search", ...SEARCH, query, ids };
}

/** The window journey's lines, from `now`, over the ids A, B and C. */
export function windowLines(now: number, [A, B, C]: number[]) {
  const L1 = { ...searchLine(now - 3 * D, "claude", "s1", "Foo  Bar ", [A!, B!]), mode: "hybrid" };
  const L2 = {
    v: 1,
    ts: now - 3 * D + 300_000,
    agent: "claude",
    session: "s1",
    channel: "get",
    requested: [B],
    found: [B],
  };
  const L3 = searchLine(now - 3 * D + 60_000, "manual", null, "manual q", [A!]);
  const L4 = searchLine(now - 20 * D, "claude", "s2", "foo bar", []);
  const L5 = {
    v: 1,
    ts: now - 20 * D,
    agent: "claude",
    session: "s2",
    channel: "session-start",
    source: "startup",
    ids: [A, C, X],
    nextSteps: false,
    cerebrum: false,
    adrs: false,
    cerebrumBullets: null,
    bytes: 1,
    budget: 8192,
    notes: 0,
    recallPointer: false,
  };
  const L6 = searchLine(now - 60 * D, "claude", "s3", "baz", [C!]);
  const L7 = {
    v: 1,
    ts: now - 60 * D,
    agent: "claude",
    session: "s3",
    channel: "file-history",
    tool: "Read",
    shown: [{ path: "a.ts", ids: [A] }],
    empty: ["b.ts", "gone.ts", "~/.crank/projects.json"],
    seen: [],
    cut: [],
    bytes: 1,
  };
  const L8 = searchLine(now - 100 * D, "claude", "s4", "old", [A!]);
  return {
    L1,
    L2,
    L3,
    L4,
    L5,
    L6,
    L7,
    L8,
    log: [L1, L2, L3, L4, L5, L6, L7, L8, "not json", { ...L1, v: 2 }],
  };
}

export const TITLES = ["Alpha one", "Bravo two", "Charlie three", "Delta four"];

/** Each channel's count summed over `perDay`. */
export function totals(body: Record<string, any>): Record<string, number> {
  const sum: Record<string, number> = {};
  for (const day of body.perDay) {
    for (const [channel, n] of Object.entries(day.counts as Record<string, number>)) {
      sum[channel] = (sum[channel] ?? 0) + n;
    }
  }
  return sum;
}

export function channelCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(CHANNELS.map((c) => [c, counts[c] ?? 0]));
}

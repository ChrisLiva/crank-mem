// The shapes, constants and guards the dashboard server answers in and the
// dashboard page reads. This file imports nothing, so the dashboard's
// tsconfig, which cannot resolve `node:` imports, compiles it too.

/** SCHEMA_V1's observations.type CHECK repeats this list as a literal; schema v1 freezes it. */
export const OBSERVATION_TYPES = [
  "bugfix",
  "feature",
  "refactor",
  "change",
  "discovery",
  "decision",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];
export const isObservationType = (value: string): value is ObservationType =>
  OBSERVATION_TYPES.some((t) => t === value);
export const PROPOSAL_KINDS = ["preference", "memory"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const PROPOSAL_STATES = ["pending", "accepted", "rejected", "expired"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];
export const isProposalState = (value: string): value is ProposalState =>
  PROPOSAL_STATES.some((s) => s === value);
export type ProposalRow = {
  id: number;
  kind: ProposalKind;
  bullet: string;
  state: ProposalState;
  reason: string | null;
  createdAtMs: number;
  decidedAtMs: number | null;
};
export type StaleRow = {
  id: number;
  title: string;
  staleAtMs: number;
  reason: string;
  reviewed: boolean;
};
export type ObservationLine = {
  id: number;
  createdAtMs: number;
  type: ObservationType;
  title: string;
  stale: boolean;
};
export type Observation = ObservationLine & {
  sessionId: string;
  narrative: string;
  facts: string[];
  filesRead: string[];
  filesModified: string[];
  staleFlag: { atMs: number; reason: string } | null;
};
export type ConsolidationOutcome = "ok" | "conflict" | "rejected" | "retry" | "stopped";
export type ConsolidationRow = {
  id: number;
  startedAtMs: number;
  finishedAtMs: number;
  outcome: ConsolidationOutcome;
  model: string | null;
  costUsd: number;
};

/** Whether memory.db opened for reading, or why not. */
export type StoreStatus = "open" | "missing" | "older" | "newer" | "unreadable";

export type Tone = "ok" | "warn" | "bad" | "off";

/** What a project's capture needs: a tone, a short label, and the fact and command that fix it when one exists. */
export type Status = { tone: Tone; label: string; fix: { text: string; command?: string } | null };

/**
 * One project's capture health as values: what `crank-mem stats` prints as capture rows,
 * except that the spool counts only this project's entries. `memory` is null unless the
 * store opened; `monthCostUsd` is digests plus consolidations since the local month began.
 * `status` is `projectStatus` over the other fields.
 */
export type HealthSummary = {
  digest: "on" | "off" | "stopped";
  stopReason: string | null;
  daemonAlive: boolean;
  spool: { waiting: number; parked: number };
  store: StoreStatus;
  memory: {
    observations: number;
    unembedded: number;
    lastDigestMs: number | null;
    monthCostUsd: number;
    pendingProposals: number;
    staleFlags: number;
    lastConsolidation: { startedMs: number; outcome: ConsolidationOutcome } | null;
  } | null;
  lastSnapshotMs: number | null;
  embedderReady: boolean;
  status: Status;
};

const STORE_FIX = {
  missing: { text: "The first digest creates it." },
  older: { text: "memory.db predates this version.", command: "crank-mem upgrade" },
  newer: { text: "memory.db is newer than this version.", command: "crank-mem upgrade" },
  unreadable: {
    text: "memory.db is not a readable database.",
    command: "crank-mem restore-memory",
  },
} as const;

/**
 * The first problem in order of how much capture it stops: digests off or stopped,
 * a store that does not open, a daemon that is down while entries wait, parked
 * entries, an embedder that is not ready.
 */
export function projectStatus(h: Omit<HealthSummary, "status">): Status {
  if (h.digest === "off")
    return {
      tone: "off",
      label: "Digests off",
      fix: { text: "Digests are off in this checkout.", command: "crank-mem digest on" },
    };
  if (h.digest === "stopped")
    return {
      tone: "bad",
      label: "Stopped",
      fix: {
        text:
          h.stopReason === "credential"
            ? "Digests stopped on a credential other than your Claude login."
            : "Digests stopped: claude is not logged in. Log in, then resume.",
        command: "crank-mem digest resume",
      },
    };
  if (h.store !== "open")
    return {
      tone: h.store === "missing" ? "off" : "bad",
      label: h.store === "missing" ? "No memory yet" : "Store needs a look",
      fix: STORE_FIX[h.store],
    };
  if (!h.daemonAlive && h.spool.waiting > 0)
    return {
      tone: "warn",
      label: "Daemon down",
      fix: {
        text: `${h.spool.waiting} waiting with no daemon to digest them.`,
        command: "crank-mem digest resume",
      },
    };
  if (h.spool.parked > 0)
    return {
      tone: "warn",
      label: "Parked entries",
      fix: {
        text: `${h.spool.parked} parked: no digest job could finish them. Each returns when its session writes again.`,
      },
    };
  if (!h.embedderReady)
    return {
      tone: "warn",
      label: "Keyword search only",
      fix: { text: "The local search model is not installed.", command: "crank-mem setup" },
    };
  return { tone: "ok", label: "Healthy", fix: null };
}

/** One local day of a store's upkeep: digests and observations made, list-price cost, consolidation decisions. */
export type ActivityDay = {
  date: string;
  digests: number;
  observations: number;
  costUsd: number;
  consolidations: number;
  accepted: number;
  rejected: number;
  staleFlags: number;
};

export const ACTIVITY_DAYS = [7, 30, 90] as const;
export type ActivityWindow = (typeof ACTIVITY_DAYS)[number];

export const USAGE_CHANNELS = [
  "session-start",
  "subagent-start",
  "file-history",
  "search",
  "timeline",
  "get",
  "outline",
  "unfold",
] as const;
export type UsageChannel = (typeof USAGE_CHANNELS)[number];

export type UsageMetrics = {
  perDay: { date: string; counts: Record<UsageChannel, number> }[];
  searches: number;
  zeroResultShare: number | null;
  keywordShare: number | null;
  followThrough: number | null;
  topQueries: {
    query: string;
    count: number;
    lastMs: number;
    meanResults: number;
    runs: { ts: number; ids: number[] }[];
  }[];
  surfaced: { id: number; count: number; title: string }[];
  neverSurfacedShare: number | null;
  filesWithoutMemory: { path: string; count: number }[];
};

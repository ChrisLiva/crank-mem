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

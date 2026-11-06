/** A non-2xx answer from the dashboard server. */
export class HttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`${path} returned ${status}`);
  }
}

/** GETs `path` from the dashboard server as JSON, throwing `HttpError` on a non-2xx status. */
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new HttpError(path, res.status);
  return (await res.json()) as T;
}

// These shapes repeat the server's (`src/cli/dashboard-server.ts`, `src/hooks/lib/memory.ts`) by
// hand: the dashboard's tsconfig cannot resolve the `node:` imports under the repo's `src/`.

/** The six observation types; schema v1 freezes the list. */
export const OBSERVATION_TYPES = [
  "bugfix",
  "feature",
  "refactor",
  "change",
  "discovery",
  "decision",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export type Note = { note: string };
export type Dot = "green" | "amber" | "grey";
export type Project = { id: string; name: string; root: string; dot: Dot; memory: string };

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
/** One page of a list; `next` is the `before` that asks for the page after it. */
export type Page<T> = { rows: T[]; next: string | null; mode?: "keyword" | "hybrid" } | Note;
export type ObservationFilters = {
  type: ObservationType | null;
  file: string;
  stale: boolean;
  q: string;
};

/** `route` under the project's API path, with `params` as its query when there are any. */
function projectPath(projectId: string, route: string, params?: URLSearchParams): string {
  const query = params === undefined || params.toString() === "" ? "" : `?${params}`;
  return `/api/projects/${encodeURIComponent(projectId)}${route}${query}`;
}

export async function fetchProjects(): Promise<Project[]> {
  return (await getJson<{ projects: Project[] }>("/api/projects")).projects;
}

/** One page of a project's observations; `before` is the previous page's `next`. */
export function fetchObservations(
  projectId: string,
  filters: ObservationFilters,
  before: string | null,
): Promise<Page<ObservationLine>> {
  const params = new URLSearchParams();
  if (filters.type !== null) params.set("type", filters.type);
  if (filters.file !== "") params.set("file", filters.file);
  if (filters.stale) params.set("stale", "1");
  if (filters.q.trim() !== "") params.set("q", filters.q);
  if (before !== null) params.set("before", before);
  return getJson(projectPath(projectId, "/observations", params));
}

/** One whole observation, or null when the server answers 400 or 404 for `oid`. */
export async function fetchObservation(
  projectId: string,
  oid: string,
): Promise<Observation | Note | null> {
  try {
    return await getJson(projectPath(projectId, `/observations/${encodeURIComponent(oid)}`));
  } catch (err) {
    if (err instanceof HttpError && (err.status === 400 || err.status === 404)) return null;
    throw err;
  }
}

export const PROPOSAL_STATES = ["pending", "accepted", "rejected", "expired"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];
export type ProposalRow = {
  id: number;
  kind: "preference" | "memory";
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
export type ConsolidationRow = {
  id: number;
  startedAtMs: number;
  finishedAtMs: number;
  outcome: "ok" | "conflict" | "rejected" | "retry" | "stopped";
  model: string | null;
  costUsd: number;
};

function beforeParams(before: string | null): URLSearchParams {
  const params = new URLSearchParams();
  if (before !== null) params.set("before", before);
  return params;
}

export function fetchProposals(
  projectId: string,
  state: ProposalState | null,
  before: string | null,
): Promise<Page<ProposalRow>> {
  const params = beforeParams(before);
  if (state !== null) params.set("state", state);
  return getJson(projectPath(projectId, "/proposals", params));
}

export function fetchStale(projectId: string, before: string | null): Promise<Page<StaleRow>> {
  return getJson(projectPath(projectId, "/stale", beforeParams(before)));
}

export function fetchConsolidations(
  projectId: string,
  before: string | null,
): Promise<Page<ConsolidationRow>> {
  return getJson(projectPath(projectId, "/consolidations", beforeParams(before)));
}

/** The capture rows `crank-mem stats` prints, as label and value pairs. */
export async function fetchHealth(projectId: string): Promise<[label: string, value: string][]> {
  return (await getJson<{ rows: [string, string][] }>(projectPath(projectId, "/health"))).rows;
}

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
export const USAGE_DAYS = [7, 30, 90] as const;
export type UsageDays = (typeof USAGE_DAYS)[number];

/** The fields of the server's `UsageMetrics` (`src/cli/usage-metrics.ts`) the Usage view reads. */
export type UsageMetrics = {
  perDay: { date: string; counts: Record<UsageChannel, number> }[];
  searches: number;
  zeroResultShare: number | null;
  keywordShare: number | null;
  followThrough: number | null;
  neverSurfacedShare: number | null;
  topQueries: {
    query: string;
    count: number;
    lastMs: number;
    meanResults: number;
    runs: { ts: number; ids: number[] }[];
  }[];
  surfaced: { id: number; count: number; title: string }[];
  filesWithoutMemory: { path: string; count: number }[];
  /** The store's note when memory.db did not open, so `surfaced` has no titles. */
  note?: string;
};

export function fetchUsage(
  projectId: string,
  days: UsageDays,
  manual: boolean,
): Promise<UsageMetrics> {
  const params = new URLSearchParams({ days: String(days), manual: manual ? "1" : "0" });
  return getJson(projectPath(projectId, "/usage", params));
}

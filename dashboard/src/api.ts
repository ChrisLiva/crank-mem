import type {
  ActivityDay,
  ActivityWindow,
  ConsolidationRow,
  HealthSummary,
  Observation,
  ObservationLine,
  ObservationType,
  ProposalRow,
  ProposalState,
  StaleRow,
  UpdateStatus,
  UsageMetrics,
} from "../../src/hooks/lib/wire";

export {
  ACTIVITY_DAYS,
  formatUsd,
  OBSERVATION_TYPES,
  PROPOSAL_STATES,
  type ActivityDay,
  type ActivityWindow,
  type ConsolidationRow,
  type HealthSummary,
  type Observation,
  type ObservationLine,
  type ObservationType,
  type ProposalRow,
  type ProposalState,
  type StaleRow,
  type Status,
  type Tone,
  type UpdateStatus,
  type UsageChannel,
  type UsageMetrics,
} from "../../src/hooks/lib/wire";

/** A non-2xx answer from the dashboard server. */
class HttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`${path} returned ${status}`);
  }
}

/** GETs `path` from the dashboard server as JSON, throwing `HttpError` on a non-2xx status. */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new HttpError(path, res.status);
  return (await res.json()) as T;
}

export type Note = { note: string };
export type Project = { id: string; name: string; root: string; memory: string };

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

export function fetchHealth(projectId: string): Promise<HealthSummary> {
  return getJson(projectPath(projectId, "/health"));
}

/** One entry per local day of the window, oldest first, or the store's note. */
export async function fetchActivity(
  projectId: string,
  days: ActivityWindow,
): Promise<ActivityDay[] | Note> {
  const body = await getJson<{ days: ActivityDay[] } | Note>(
    projectPath(projectId, "/activity", new URLSearchParams({ days: String(days) })),
  );
  return "note" in body ? body : body.days;
}

/** `UsageMetrics`, with the store's note when memory.db did not open, so `surfaced` has no titles. */
export type UsageAnswer = UsageMetrics & { note?: string };

export function fetchUsage(
  projectId: string,
  days: ActivityWindow,
  manual: boolean,
): Promise<UsageAnswer> {
  const params = new URLSearchParams({ days: String(days), manual: manual ? "1" : "0" });
  return getJson(projectPath(projectId, "/usage", params));
}

export function fetchUpdates(): Promise<UpdateStatus> {
  return getJson("/api/updates");
}

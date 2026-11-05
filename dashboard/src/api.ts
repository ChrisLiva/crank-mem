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
export type ObservationPage =
  | { lines: ObservationLine[]; next: string | null; mode?: "keyword" | "hybrid" }
  | Note;
export type ObservationFilters = {
  type: ObservationType | null;
  file: string;
  stale: boolean;
  q: string;
};

export async function fetchProjects(): Promise<Project[]> {
  return (await getJson<{ projects: Project[] }>("/api/projects")).projects;
}

/** One page of a project's observations; `before` is the previous page's `next`. */
export function fetchObservations(
  projectId: string,
  filters: ObservationFilters,
  before: string | null,
): Promise<ObservationPage> {
  const params = new URLSearchParams();
  if (filters.type !== null) params.set("type", filters.type);
  if (filters.file !== "") params.set("file", filters.file);
  if (filters.stale) params.set("stale", "1");
  if (filters.q.trim() !== "") params.set("q", filters.q);
  if (before !== null) params.set("before", before);
  const query = params.toString() === "" ? "" : `?${params}`;
  return getJson(`/api/projects/${encodeURIComponent(projectId)}/observations${query}`);
}

/** One whole observation, or null when the server answers 400 or 404 for `oid`. */
export async function fetchObservation(
  projectId: string,
  oid: string,
): Promise<Observation | Note | null> {
  try {
    return await getJson(
      `/api/projects/${encodeURIComponent(projectId)}/observations/${encodeURIComponent(oid)}`,
    );
  } catch (err) {
    if (err instanceof HttpError && (err.status === 400 || err.status === 404)) return null;
    throw err;
  }
}

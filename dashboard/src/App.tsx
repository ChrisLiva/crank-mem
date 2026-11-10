import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cn } from "cn";
import { fetchHealth, fetchProjects, type HealthSummary, type Project } from "./api";
import { usePerProject } from "./hooks/use-per-project";
import { usePoll } from "./hooks/use-poll";
import { projectStatus, projectTone } from "./status";
import { CurationView } from "./views/curation";
import { HealthView } from "./views/health";
import { MemoryView } from "./views/memory";
import { Dot } from "./views/shared";
import { UsageView } from "./views/usage";

const VIEWS = [
  ["health", "Health"],
  ["curation", "Curation"],
  ["usage", "Usage"],
  ["memory", "Memory"],
] as const;
type View = (typeof VIEWS)[number][0];

/** Where the page is; the URL query holds each field so a reload opens the same place. */
type Place = { project: string | null; view: View; tab: string | null; item: string | null };

function readPlace(): Place {
  const q = new URLSearchParams(location.search);
  const view = q.get("view");
  return {
    project: q.get("project"),
    view: VIEWS.find(([v]) => v === view)?.[0] ?? "health",
    tab: q.get("tab"),
    item: q.get("item"),
  };
}

function writePlace(place: Place): void {
  const q = new URLSearchParams();
  if (place.project !== null) q.set("project", place.project);
  q.set("view", place.view);
  if (place.tab !== null) q.set("tab", place.tab);
  if (place.item !== null) q.set("item", place.item);
  history.replaceState(null, "", `?${q}`);
}

export function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState(readPlace);

  usePoll(async () => {
    try {
      const list = await fetchProjects();
      setProjects(list);
      setError(null);
      setPlace((p) =>
        list.some((x) => x.id === p.project)
          ? p
          : { ...p, project: list[0]?.id ?? null, tab: null, item: null },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  const health = usePerProject(projects ?? [], fetchHealth);

  useEffect(() => {
    if (projects !== null) writePlace(place);
  }, [projects, place]);

  const setItem = useCallback((item: string | null) => setPlace((p) => ({ ...p, item })), []);
  const setTab = useCallback((tab: string) => setPlace((p) => ({ ...p, tab, item: null })), []);
  const openObservation = useCallback(
    (id: number) => setPlace((p) => ({ ...p, view: "memory", tab: null, item: String(id) })),
    [],
  );
  const focus = useCallback(
    (project: string) =>
      setPlace((p) => (p.project === project ? p : { ...p, project, tab: null, item: null })),
    [],
  );
  const go = (view: View) => setPlace((p) => ({ ...p, view, tab: null, item: null }));

  return (
    <div className="flex min-h-dvh flex-col text-sm leading-normal md:h-dvh">
      <TopBar projects={projects} health={health} place={place} go={go} focus={focus} />
      {error !== null ? (
        <Message tone="error">
          {error}. The dashboard server may have stopped: run crank-mem dashboard again.
        </Message>
      ) : projects === null ? null : projects.length === 0 ? (
        <Message>No projects yet: run crank-mem init in a project.</Message>
      ) : (
        place.project !== null && (
          <ViewSwitch
            projects={projects}
            health={health}
            place={{ ...place, project: place.project }}
            go={go}
            focus={focus}
            setItem={setItem}
            setTab={setTab}
            openObservation={openObservation}
          />
        )
      )}
    </div>
  );
}

function Message({ tone, children }: { tone?: "error"; children: ReactNode }) {
  return (
    <p
      className={cn(
        "mx-auto mt-16 max-w-md px-6 text-center text-muted-foreground",
        tone === "error" && "text-destructive",
      )}
    >
      {children}
    </p>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-5">
      <rect width="16" height="16" rx="3.5" className="fill-foreground" />
      <path
        d="M4 11V5h3a2 2 0 0 1 0 4H4m4 0 3 2"
        fill="none"
        className="stroke-background"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The wordmark, the views as tabs, the project the views show, and the host. */
function TopBar({
  projects,
  health,
  place,
  go,
  focus,
}: {
  projects: Project[] | null;
  health: Record<string, HealthSummary | undefined>;
  place: Place;
  go: (view: View) => void;
  focus: (project: string) => void;
}) {
  const current = projects?.find((p) => p.id === place.project);
  const currentHealth = current && health[current.id];
  const status = currentHealth ? projectStatus(currentHealth) : null;
  return (
    <header className="sticky top-0 z-20 flex-none border-b bg-card">
      <div className="flex h-14 items-center gap-4 px-4 md:px-6">
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <Mark />
          crank-mem
        </span>
        {projects !== null && projects.length > 0 && (
          <label className="relative flex items-center">
            <span className="sr-only">Project</span>
            {current && (
              <Dot
                tone={projectTone(current, health[current.id])}
                className="pointer-events-none absolute left-2.5"
              />
            )}
            {status && (
              <span id="project-status" className="sr-only">
                {status.label}
              </span>
            )}
            <select
              aria-describedby={status ? "project-status" : undefined}
              title={status?.label}
              value={place.project ?? ""}
              onChange={(e) => focus(e.target.value)}
              className="h-8 max-w-56 appearance-none truncate rounded-md border border-input bg-card pr-8 pl-6 text-sm font-medium hover:bg-accent [&_option]:bg-popover"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <svg
              viewBox="0 0 16 16"
              aria-hidden
              className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground"
            >
              <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </label>
        )}
        <span className="flex-1" />
        <span className="hidden items-center gap-2 rounded-md border px-2 py-1 font-mono text-xs text-muted-foreground sm:flex">
          {location.host}
          <span className="rounded-sm bg-muted px-1.5 font-sans text-[11px] font-medium text-foreground">
            read-only
          </span>
        </span>
      </div>
      <nav aria-label="Views" className="-mb-px flex gap-1 overflow-x-auto px-2 md:px-4">
        {VIEWS.map(([view, label]) => (
          <button
            key={view}
            type="button"
            aria-current={place.view === view ? "page" : undefined}
            onClick={() => go(view)}
            className="relative h-10 rounded-md px-3 text-sm text-muted-foreground outline-offset-[-2px] hover:text-foreground aria-[current=page]:font-medium aria-[current=page]:text-foreground aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-2 aria-[current=page]:after:bottom-0 aria-[current=page]:after:h-0.5 aria-[current=page]:after:rounded-full aria-[current=page]:after:bg-foreground"
          >
            {label}
          </button>
        ))}
      </nav>
    </header>
  );
}

/** The view the place names, keyed by project so a switch starts it fresh. */
function ViewSwitch({
  projects,
  health,
  place,
  go,
  focus,
  setItem,
  setTab,
  openObservation,
}: {
  projects: Project[];
  health: Record<string, HealthSummary | undefined>;
  place: Place & { project: string };
  go: (view: View) => void;
  focus: (project: string) => void;
  setItem: (item: string | null) => void;
  setTab: (tab: string) => void;
  openObservation: (id: number) => void;
}) {
  if (place.view === "health")
    return (
      <HealthView
        projects={projects}
        health={health}
        projectId={place.project}
        focus={focus}
        openCuration={() => go("curation")}
      />
    );
  if (place.view === "curation")
    return (
      <CurationView
        key={place.project}
        projectId={place.project}
        tab={place.tab}
        setTab={setTab}
        item={place.item}
        setItem={setItem}
        openObservation={openObservation}
      />
    );
  if (place.view === "usage")
    return (
      <UsageView
        key={place.project}
        projectId={place.project}
        item={place.item}
        setItem={setItem}
        openObservation={openObservation}
      />
    );
  return (
    <MemoryView key={place.project} projectId={place.project} item={place.item} setItem={setItem} />
  );
}

import { useCallback, useEffect, useState } from "react";
import { cn } from "cn";
import { fetchProjects, type Dot, type Project } from "./api";
import { CurationView } from "./views/curation";
import { HealthView } from "./views/health";
import { MemoryView } from "./views/memory";
import { UsageView } from "./views/usage";

const VIEWS = [
  ["memory", "Memory"],
  ["curation", "Curation"],
  ["health", "Health"],
  ["usage", "Usage"],
] as const;
type View = (typeof VIEWS)[number][0];

/** Where the page is; the URL query holds each field so a reload opens the same place. */
type Place = { project: string | null; view: View; tab: string | null; item: string | null };

function readPlace(): Place {
  const q = new URLSearchParams(location.search);
  const view = q.get("view");
  return {
    project: q.get("project"),
    view: VIEWS.find(([v]) => v === view)?.[0] ?? "memory",
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

const DOT_CLASS: Record<Dot, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  grey: "bg-muted-foreground",
};

export function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState(readPlace);
  const [expanded, setExpanded] = useState(() => new Set<string>());

  useEffect(() => {
    fetchProjects()
      .then((list) => {
        setProjects(list);
        setPlace((p) =>
          list.some((x) => x.id === p.project)
            ? p
            : { project: list[0]?.id ?? null, view: "memory", tab: null, item: null },
        );
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (projects !== null) writePlace(place);
  }, [projects, place]);

  const project = place.project;
  useEffect(() => {
    if (project !== null) setExpanded((s) => (s.has(project) ? s : new Set(s).add(project)));
  }, [project]);

  const setItem = useCallback((item: string | null) => setPlace((p) => ({ ...p, item })), []);
  const setTab = useCallback((tab: string) => setPlace((p) => ({ ...p, tab, item: null })), []);
  const openObservation = useCallback(
    (id: number) => setPlace((p) => ({ ...p, view: "memory", tab: null, item: String(id) })),
    [],
  );
  const go = (projectId: string, view: View) =>
    setPlace({ project: projectId, view, tab: null, item: null });
  const toggle = (id: string) => {
    if (!expanded.has(id)) return go(id, "memory");
    setExpanded((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  };

  if (error !== null) return <p className="p-4 text-destructive">{error}</p>;
  if (projects === null) return null;
  if (projects.length === 0)
    return <p className="p-4">No projects yet: run crank-mem init in a project.</p>;

  return (
    <div className="flex h-screen flex-col text-[13px] leading-normal">
      <header className="flex h-11 flex-none items-center gap-3 border-b px-4">
        <span className="font-semibold tracking-tight">crank-mem</span>
        <span className="font-mono text-xs text-muted-foreground">{location.host}</span>
      </header>
      <main className="grid min-h-0 flex-1 grid-cols-[236px_minmax(340px,420px)_1fr]">
        <nav
          aria-label="Projects"
          className="min-h-0 overflow-auto border-r bg-sidebar px-2 py-2.5"
        >
          <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Projects
          </div>
          {projects.map((p) => {
            const open = expanded.has(p.id);
            return (
              <div key={p.id}>
                <button
                  type="button"
                  aria-expanded={open}
                  title={p.root}
                  onClick={() => toggle(p.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  <span
                    className={cn(
                      "inline-block w-3 text-muted-foreground transition-transform",
                      open && "rotate-90",
                    )}
                  >
                    ›
                  </span>
                  <span
                    data-dot={p.dot}
                    title={`health: ${p.dot}`}
                    className={cn("size-[7px] flex-none rounded-full", DOT_CLASS[p.dot])}
                  />
                  <span className="truncate">{p.name}</span>
                </button>
                {open &&
                  VIEWS.map(([view, label]) => {
                    const active = place.project === p.id && place.view === view;
                    return (
                      <button
                        key={view}
                        type="button"
                        aria-current={active || undefined}
                        onClick={() => go(p.id, view)}
                        className={cn(
                          "flex w-full rounded-md py-1.5 pr-2 pl-[30px] text-left hover:bg-accent",
                          active && "bg-accent font-semibold",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </nav>
        {place.project === null ? null : place.view === "memory" ? (
          <MemoryView
            key={place.project}
            projectId={place.project}
            item={place.item}
            setItem={setItem}
          />
        ) : place.view === "curation" ? (
          <CurationView
            key={place.project}
            projectId={place.project}
            tab={place.tab}
            setTab={setTab}
            item={place.item}
            setItem={setItem}
            openObservation={openObservation}
          />
        ) : place.view === "health" ? (
          <HealthView
            key={place.project}
            projectId={place.project}
            item={place.item}
            setItem={setItem}
          />
        ) : (
          <UsageView
            key={place.project}
            projectId={place.project}
            item={place.item}
            setItem={setItem}
            openObservation={openObservation}
          />
        )}
      </main>
    </div>
  );
}

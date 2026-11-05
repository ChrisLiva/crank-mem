import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import {
  fetchConsolidations,
  fetchProposals,
  fetchStale,
  PROPOSAL_STATES,
  type ConsolidationRow,
  type Note,
  type ProposalRow,
  type ProposalState,
  type RowPage,
  type StaleRow,
} from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePoll } from "@/hooks/use-poll";
import { useListKeys } from "@/hooks/use-list-keys";
import { formatTime, LABEL } from "./memory";

export { formatTime, LABEL };

/**
 * Keeps `item` on one of `keys`, which are the list's rows in order: the first key when
 * `item` is missing or gone, null when the list is empty. j/k move it. While `keys` is
 * null (the list is still loading), `item` stays as it is.
 */
export function useSelection(
  keys: string[] | null,
  item: string | null,
  setItem: (item: string | null) => void,
): void {
  const selected = keys === null || item === null ? -1 : keys.indexOf(item);
  const first = keys?.[0] ?? null;
  useEffect(() => {
    if (keys !== null && selected < 0 && first !== item) setItem(first);
  }, [keys, selected, first, item, setItem]);
  const select = useCallback(
    (i: number) => {
      const key = keys?.[i];
      if (key !== undefined) setItem(key);
    },
    [keys, setItem],
  );
  useListKeys(keys?.length ?? 0, selected, select);
}

/** A list row button: the left bar and background mark the selected row. */
export function Row({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <button
      ref={ref}
      type="button"
      data-row
      aria-current={selected || undefined}
      onClick={onClick}
      className={cn(
        "grid w-full gap-0.5 border-b border-l-2 border-l-transparent px-3 py-2 text-left hover:bg-accent/60",
        selected && "border-l-primary bg-accent",
      )}
    >
      {children}
    </button>
  );
}

/** A link to observation `id` in the Memory view. */
export function ObservationLink({ id, open }: { id: number; open: (id: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => open(id)}
      className="font-mono underline-offset-2 hover:underline"
    >
      #{id}
    </button>
  );
}

const CURATION_TABS = [
  ["proposals", "Proposals"],
  ["stale", "Stale flags"],
  ["consolidations", "Consolidations"],
] as const;
type CurationTab = (typeof CURATION_TABS)[number][0];

type Listed<T> = { key: string; rows: T[]; next: string | null; pages: number };

/** A fresh first page, with the older pages already loaded kept beneath it. */
function withOlderPages<T extends { id: number }>(prev: Listed<T> | null, first: Listed<T>) {
  if (prev === null || prev.pages < 2 || first.next === null) return first;
  const last = first.rows[first.rows.length - 1];
  const at = last === undefined ? -1 : prev.rows.findIndex((r) => r.id === last.id);
  if (at < 0) return first;
  return {
    ...first,
    rows: [...first.rows, ...prev.rows.slice(at + 1)],
    next: prev.next,
    pages: prev.pages,
  };
}

/** Page 1 of `fetchPage` on each `key` and each poll, and `older` to append the page after the last. */
function usePaged<T extends { id: number }>(
  key: string,
  fetchPage: (before: string | null) => Promise<RowPage<T>>,
) {
  const keyRef = useRef(key);
  keyRef.current = key;
  const [listed, setListed] = useState<Listed<T> | Note | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (before: string | null) => {
    const asked = key;
    try {
      const page = await fetchPage(before);
      if (keyRef.current !== asked) return;
      setError(null);
      if ("note" in page) return setListed(page);
      const got: Listed<T> = { key: asked, rows: page.rows, next: page.next, pages: 1 };
      setListed((prev) => {
        const same = prev !== null && !("note" in prev) && prev.key === asked ? prev : null;
        if (before === null) return withOlderPages(same, got);
        if (same === null) return prev;
        return { ...got, rows: [...same.rows, ...got.rows], pages: same.pages + 1 };
      });
    } catch (err) {
      if (keyRef.current === asked) setError(err instanceof Error ? err.message : String(err));
    }
  };
  usePoll(() => load(null), [key]);

  const current = listed !== null && !("note" in listed) && listed.key === key ? listed : null;
  const note = listed !== null && "note" in listed ? listed.note : null;
  return { current, note, error, older: () => current?.next != null && load(current.next) };
}

type ListSpec<T> = {
  key: string;
  fetchPage: (before: string | null) => Promise<RowPage<T>>;
  row: (row: T) => ReactNode;
  detail: (row: T) => ReactNode;
};

/** Columns 2 and 3 for one paged list: `head` above the rows, the selected row's detail beside. */
function PagedList<T extends { id: number }>({
  spec,
  head,
  item,
  setItem,
}: {
  spec: ListSpec<T>;
  head: ReactNode;
  item: string | null;
  setItem: (item: string | null) => void;
}) {
  const { current, note, error, older } = usePaged(spec.key, spec.fetchPage);
  const keys = current === null ? null : current.rows.map((r) => String(r.id));
  useSelection(note === null ? keys : [], item, setItem);
  const chosen = current?.rows.find((r) => String(r.id) === item);

  return (
    <>
      <section aria-label="List" className="flex min-h-0 flex-col border-r">
        <div className="grid gap-2 border-b px-3 py-2.5">{head}</div>
        <div data-list className="min-h-0 flex-1 overflow-auto">
          {note !== null ? (
            <p className="px-4 py-8 text-center text-muted-foreground">{note}</p>
          ) : error !== null ? (
            <p className="px-4 py-8 text-center text-destructive">{error}</p>
          ) : current !== null && current.rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-muted-foreground">Nothing here yet.</p>
          ) : (
            current?.rows.map((r) => (
              <Row
                key={r.id}
                selected={String(r.id) === item}
                onClick={() => setItem(String(r.id))}
              >
                {spec.row(r)}
              </Row>
            ))
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <span>{current !== null && `${current.rows.length} shown`}</span>
          <span className="flex items-center gap-2">
            <span>
              <kbd className="font-mono">j</kbd> <kbd className="font-mono">k</kbd>
            </span>
            {current !== null && current.next !== null && (
              <Button variant="outline" size="xs" onClick={older}>
                Older
              </Button>
            )}
          </span>
        </div>
      </section>
      <section aria-label="Detail" className="min-h-0 overflow-auto">
        {note !== null ? (
          <p className="px-6 py-8 text-muted-foreground">{note}</p>
        ) : chosen === undefined ? null : (
          <div className="grid max-w-3xl gap-5 px-6 pt-5 pb-10">{spec.detail(chosen)}</div>
        )}
      </section>
    </>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/** Label and value pairs in a bordered two-column card; the `highlight` label's pair stands out. */
export function Pairs({
  pairs,
  highlight,
}: {
  pairs: [label: string, value: ReactNode][];
  highlight?: string;
}) {
  return (
    <div className="grid grid-cols-[160px_1fr] rounded-lg border bg-card text-card-foreground">
      {pairs.map(([label, value], i) => {
        const cell = cn(
          "px-3.5 py-2",
          i < pairs.length - 1 && "border-b",
          label === highlight && "bg-accent font-semibold",
        );
        return (
          <div key={label} data-pair className="contents">
            <div className={cn(cell, "text-xs text-muted-foreground")}>{label}</div>
            <div className={cell}>{value}</div>
          </div>
        );
      })}
    </div>
  );
}

const STATE_BADGE: Record<ProposalState, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  accepted: "default",
  rejected: "destructive",
  expired: "outline",
};

function proposalSpec(projectId: string, state: ProposalState | null): ListSpec<ProposalRow> {
  return {
    key: JSON.stringify([projectId, "proposals", state]),
    fetchPage: (before) => fetchProposals(projectId, state, before),
    row: (p) => (
      <>
        <span className="flex min-w-0 items-center gap-2">
          <Badge variant={STATE_BADGE[p.state]}>{p.state}</Badge>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {p.bullet.replace(/^- /, "")}
          </span>
        </span>
        <span className="flex min-w-0 gap-2 text-xs text-muted-foreground">
          <span>{p.kind}</span>
          <span className="tabular-nums">{formatTime(p.createdAtMs)}</span>
          {p.reason !== null && <span className="truncate">{p.reason}</span>}
        </span>
      </>
    ),
    detail: (p) => (
      <>
        <div className="grid gap-1.5">
          <Meta>
            <Badge variant={STATE_BADGE[p.state]}>{p.state}</Badge>
            <span>
              {p.kind} proposal <span className="font-mono">#{p.id}</span>
            </span>
            <span>{formatTime(p.createdAtMs)}</span>
          </Meta>
          <h1 className="text-lg leading-snug font-semibold">Cerebrum {p.kind} proposal</h1>
        </div>
        <div className="rounded-lg border bg-card px-3.5 py-3 font-mono text-xs whitespace-pre-wrap">
          {p.bullet}
        </div>
        <div className="grid gap-1.5">
          <div className={LABEL}>Reason</div>
          {p.reason !== null ? (
            <p className="whitespace-pre-wrap">{p.reason}</p>
          ) : (
            <p className="text-muted-foreground">
              Pending: the next consolidation reviews it against the code.
            </p>
          )}
        </div>
        {p.decidedAtMs !== null && <Pairs pairs={[["Decided", formatTime(p.decidedAtMs)]]} />}
      </>
    ),
  };
}

function staleSpec(projectId: string, openObservation: (id: number) => void): ListSpec<StaleRow> {
  return {
    key: JSON.stringify([projectId, "stale"]),
    fetchPage: (before) => fetchStale(projectId, before),
    row: (s) => (
      <>
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-xs text-destructive">stale</span>
          <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
        </span>
        <span className="flex min-w-0 gap-2 text-xs text-muted-foreground">
          <span className="font-mono">#{s.id}</span>
          <span className="truncate">{s.reason}</span>
        </span>
      </>
    ),
    detail: (s) => (
      <>
        <div className="grid gap-1.5">
          <Meta>
            <span>
              observation <ObservationLink id={s.id} open={openObservation} />
            </span>
            <span>{s.reviewed ? "reviewed: confirmed stale" : "not reviewed yet"}</span>
          </Meta>
          <h1 className="text-lg leading-snug font-semibold">{s.title}</h1>
        </div>
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-3">
          <div className={cn(LABEL, "text-destructive")}>Stale since {formatTime(s.staleAtMs)}</div>
          <div>{s.reason}</div>
        </div>
      </>
    ),
  };
}

function consolidationSpec(projectId: string): ListSpec<ConsolidationRow> {
  return {
    key: JSON.stringify([projectId, "consolidations"]),
    fetchPage: (before) => fetchConsolidations(projectId, before),
    row: (c) => (
      <>
        <span className="flex min-w-0 items-center gap-2">
          <Badge variant={c.outcome === "ok" ? "default" : "destructive"}>{c.outcome}</Badge>
          <span className="flex-1 tabular-nums">{formatTime(c.startedAtMs)}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            ${c.costUsd.toFixed(4)}
          </span>
        </span>
        <span className="font-mono text-xs text-muted-foreground">{c.model ?? "no model"}</span>
      </>
    ),
    detail: (c) => (
      <>
        <div className="grid gap-1.5">
          <Meta>
            <Badge variant={c.outcome === "ok" ? "default" : "destructive"}>{c.outcome}</Badge>
            <span className="font-mono">#{c.id}</span>
          </Meta>
          <h1 className="text-lg leading-snug font-semibold">
            Consolidation {formatTime(c.startedAtMs)}
          </h1>
        </div>
        <Pairs
          pairs={[
            ["Started", formatTime(c.startedAtMs)],
            ["Finished", formatTime(c.finishedAtMs)],
            ["Outcome", c.outcome],
            ["Model", <span className="font-mono">{c.model ?? "none"}</span>],
            ["Cost", `$${c.costUsd.toFixed(4)}`],
          ]}
        />
      </>
    ),
  };
}

export function CurationView({
  projectId,
  tab,
  setTab,
  item,
  setItem,
  openObservation,
}: {
  projectId: string;
  tab: string | null;
  setTab: (tab: string) => void;
  item: string | null;
  setItem: (item: string | null) => void;
  openObservation: (id: number) => void;
}) {
  const current: CurationTab = CURATION_TABS.find(([t]) => t === tab)?.[0] ?? "proposals";
  const [state, setState] = useState<ProposalState | null>(null);
  const head = (
    <>
      <h2 className="text-sm font-semibold">Curation</h2>
      <Tabs value={current} onValueChange={setTab}>
        <TabsList className="w-full">
          {CURATION_TABS.map(([t, label]) => (
            <TabsTrigger key={t} value={t}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {current === "proposals" && (
        <select
          aria-label="State"
          value={state ?? "all"}
          onChange={(e) =>
            setState(e.target.value === "all" ? null : (e.target.value as ProposalState))
          }
          className="h-8 w-fit rounded-md border border-input bg-transparent px-2 text-sm [&_option]:bg-popover"
        >
          <option value="all">all</option>
          {PROPOSAL_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}
    </>
  );
  const props = { head, item, setItem };
  if (current === "proposals")
    return <PagedList key="proposals" spec={proposalSpec(projectId, state)} {...props} />;
  if (current === "stale")
    return <PagedList key="stale" spec={staleSpec(projectId, openObservation)} {...props} />;
  return <PagedList key="consolidations" spec={consolidationSpec(projectId)} {...props} />;
}

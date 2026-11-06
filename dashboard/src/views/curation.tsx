import { useState, type ReactNode } from "react";
import { cn } from "cn";
import {
  fetchConsolidations,
  fetchProposals,
  fetchStale,
  PROPOSAL_STATES,
  type ConsolidationRow,
  type ProposalRow,
  type ProposalState,
  type RowPage,
  type StaleRow,
} from "@/api";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  formatTime,
  LABEL,
  ListFoot,
  ObservationLink,
  Pairs,
  Row,
  usePaged,
  useSelection,
} from "./shared";

const CURATION_TABS = [
  ["proposals", "Proposals"],
  ["stale", "Stale flags"],
  ["consolidations", "Consolidations"],
] as const;
type CurationTab = (typeof CURATION_TABS)[number][0];

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
        <ListFoot start={current !== null && `${current.rows.length} shown`} older={older} />
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

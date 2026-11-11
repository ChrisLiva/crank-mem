import { useState, type ReactNode } from "react";
import { cn } from "cn";
import {
  fetchConsolidations,
  fetchProposals,
  fetchStale,
  formatUsd,
  PROPOSAL_STATES,
  type ConsolidationRow,
  type ProposalRow,
  type ProposalState,
  type Page,
  type StaleRow,
  type Tone,
} from "@/api";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DETAIL_BODY,
  DETAIL_COLUMN,
  formatTime,
  LABEL,
  LIST_COLUMN,
  ListFoot,
  ObservationLink,
  OUTCOME_TONE,
  Pairs,
  Pill,
  Prose,
  Row,
  SPLIT,
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
  fetchPage: (before: string | null) => Promise<Page<T>>;
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
    <main className={SPLIT}>
      <section aria-label="List" className={LIST_COLUMN}>
        <div className="grid gap-3 border-b px-4 py-4">{head}</div>
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
      <section aria-label="Detail" className={DETAIL_COLUMN}>
        {note !== null ? (
          <p className="px-6 py-8 text-muted-foreground md:px-8">{note}</p>
        ) : chosen === undefined ? null : (
          <div className={DETAIL_BODY}>{spec.detail(chosen)}</div>
        )}
      </section>
    </main>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/** A cerebrum bullet's text, without its leading `- `. */
const bulletText = (bullet: string) => bullet.replace(/^- /, "");

const STATE_TONE: Record<ProposalState, Tone> = {
  pending: "warn",
  accepted: "ok",
  rejected: "bad",
  expired: "off",
};

function proposalSpec(projectId: string, state: ProposalState | null): ListSpec<ProposalRow> {
  return {
    key: JSON.stringify([projectId, "proposals", state]),
    fetchPage: (before) => fetchProposals(projectId, state, before),
    row: (p) => (
      <>
        <span className="flex min-w-0 items-center gap-2">
          <Pill tone={STATE_TONE[p.state]}>{p.state}</Pill>
          <span className="min-w-0 flex-1 truncate">
            <Prose text={bulletText(p.bullet)} />
          </span>
        </span>
        <span className="flex min-w-0 gap-2 text-xs text-muted-foreground">
          <span className="flex-none">{p.kind}</span>
          <span className="flex-none tabular-nums">{formatTime(p.createdAtMs)}</span>
          {p.reason !== null && (
            <span className="min-w-0 truncate">
              <Prose text={p.reason} />
            </span>
          )}
        </span>
      </>
    ),
    detail: (p) => (
      <>
        <div className="grid gap-2">
          <h1 className="text-lg leading-snug font-semibold whitespace-pre-wrap">
            <Prose text={bulletText(p.bullet)} />
          </h1>
          <Meta>
            <Pill tone={STATE_TONE[p.state]}>{p.state}</Pill>
            <span>
              cerebrum {p.kind} proposal <span className="font-mono">#{p.id}</span>
            </span>
            <span>{formatTime(p.createdAtMs)}</span>
          </Meta>
        </div>
        <div className="grid gap-1.5">
          <div className={LABEL}>Reason</div>
          {p.reason !== null ? (
            <p className="whitespace-pre-wrap">
              <Prose text={p.reason} />
            </p>
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
          <Pill tone="bad">stale</Pill>
          <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
        </span>
        <span className="flex min-w-0 gap-2 text-xs text-muted-foreground">
          <span className="flex-none font-mono">#{s.id}</span>
          <span className="min-w-0 truncate">
            <Prose text={s.reason} />
          </span>
        </span>
      </>
    ),
    detail: (s) => (
      <>
        <div className="grid gap-2">
          <h1 className="text-lg leading-snug font-semibold">{s.title}</h1>
          <Meta>
            <span>
              observation <ObservationLink id={s.id} open={openObservation} />
            </span>
            <span>{s.reviewed ? "reviewed: confirmed stale" : "not reviewed yet"}</span>
          </Meta>
        </div>
        <div className="grid gap-1 rounded-lg border border-bad-line bg-bad-soft px-4 py-3">
          <div className={cn(LABEL, "text-bad")}>Stale since {formatTime(s.staleAtMs)}</div>
          <div>
            <Prose text={s.reason} />
          </div>
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
          <Pill tone={OUTCOME_TONE[c.outcome]}>{c.outcome}</Pill>
          <span className="flex-1 tabular-nums">{formatTime(c.startedAtMs)}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{formatUsd(c.costUsd)}</span>
        </span>
        <span className="font-mono text-xs text-muted-foreground">{c.model ?? "no model"}</span>
      </>
    ),
    detail: (c) => (
      <>
        <div className="grid gap-2">
          <h1 className="text-lg leading-snug font-semibold">
            Consolidation {formatTime(c.startedAtMs)}
          </h1>
          <Meta>
            <Pill tone={OUTCOME_TONE[c.outcome]}>{c.outcome}</Pill>
            <span className="font-mono">#{c.id}</span>
          </Meta>
        </div>
        <Pairs
          pairs={[
            ["Started", formatTime(c.startedAtMs)],
            ["Finished", formatTime(c.finishedAtMs)],
            ["Outcome", c.outcome],
            ["Model", <span className="font-mono">{c.model ?? "none"}</span>],
            ["Cost", `${formatUsd(c.costUsd)} at list price`],
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
      <div className="grid gap-0.5">
        <h1 className="text-base font-semibold">Curation</h1>
        <p className="text-xs text-muted-foreground">
          What consolidation accepted, rejected and flagged, and why
        </p>
      </div>
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
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          State
          <select
            value={state ?? "all"}
            onChange={(e) =>
              setState(e.target.value === "all" ? null : (e.target.value as ProposalState))
            }
            className="h-8 w-fit rounded-md border border-input bg-card px-2 text-sm text-foreground [&_option]:bg-popover"
          >
            <option value="all">all states</option>
            {PROPOSAL_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
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

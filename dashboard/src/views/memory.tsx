import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { cn } from "cn";
import { Check } from "lucide-react";
import {
  fetchObservation,
  fetchObservations,
  OBSERVATION_TYPES,
  type Note,
  type Observation,
  type ObservationFilters,
  type ObservationLine,
  type ObservationType,
} from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "../../../src/hooks/lib/wire";
import {
  DETAIL_BODY,
  DETAIL_COLUMN,
  formatTime,
  LABEL,
  ListColumn,
  ListFoot,
  Pairs,
  Pill,
  Prose,
  SPLIT,
  useListNav,
  usePaged,
} from "./shared";

const TYPE_DELAY_MS = 300;

/** `value`, once it has held still for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** The observation `item` names, fetched when it changes; `item` clears when the store has no such row. */
function useObservationDetail(
  projectId: string,
  item: string | null,
  setItem: (item: string | null) => void,
): Observation | Note | null {
  const [detail, setDetail] = useState<Observation | Note | null>(null);
  useEffect(() => {
    setDetail(null);
    if (item === null) return;
    let live = true;
    fetchObservation(projectId, item)
      .then((got) => {
        if (!live) return;
        if (got === null) setItem(null);
        else setDetail(got);
      })
      .catch((err: unknown) => {
        if (live) setDetail({ note: errorMessage(err) });
      });
    return () => {
      live = false;
    };
  }, [projectId, item, setItem]);
  return detail;
}

export function MemoryView({
  projectId,
  item,
  setItem,
}: {
  projectId: string;
  item: string | null;
  setItem: (item: string | null) => void;
}) {
  const [type, setType] = useState<ObservationType | null>(null);
  const [fileText, setFileText] = useState("");
  const [stale, setStale] = useState(false);
  const [qText, setQText] = useState("");
  const file = useSettled(fileText.trim(), TYPE_DELAY_MS);
  const q = useSettled(qText.trim(), TYPE_DELAY_MS);
  const filters: ObservationFilters = { type, file, stale, q };
  const key = JSON.stringify([projectId, filters]);
  const { current, note, error, older } = usePaged<ObservationLine>(key, (before) =>
    fetchObservations(projectId, filters, before),
  );

  const rows = current?.rows ?? null;
  const first = rows?.[0];
  useEffect(() => {
    if (item === null && first !== undefined) setItem(String(first.id));
  }, [item, first, setItem]);

  const detail = useObservationDetail(projectId, item, setItem);

  useListNav(rows?.map((l) => String(l.id)) ?? null, item, setItem);

  return (
    <main className={SPLIT}>
      <ListColumn
        head={
          <>
            <div className="grid gap-0.5">
              <h1 className="text-base font-semibold">Memory</h1>
              <p className="text-xs text-muted-foreground">
                Observations digests stored from past sessions
              </p>
            </div>
            {note === null && (
              <MemoryFilters
                qText={qText}
                setQText={setQText}
                type={type}
                setType={setType}
                fileText={fileText}
                setFileText={setFileText}
                stale={stale}
                setStale={setStale}
              />
            )}
          </>
        }
        note={note}
        error={error}
        rows={rows}
        empty="Nothing matches."
        item={item}
        setItem={setItem}
        renderRow={(line) => <MemoryRow line={line} />}
        foot={
          <ListFoot
            start={
              <>
                {current !== null && <span>{current.rows.length} shown</span>}
                {current?.mode != null && <span>{current.mode} search</span>}
              </>
            }
            older={older}
          />
        }
      />
      <section aria-label="Detail" className={DETAIL_COLUMN}>
        <MemoryDetail note={note} detail={detail} />
      </section>
    </main>
  );
}

/** The search box, the type select, the file filter and the stale toggle. */
function MemoryFilters({
  qText,
  setQText,
  type,
  setType,
  fileText,
  setFileText,
  stale,
  setStale,
}: {
  qText: string;
  setQText: (text: string) => void;
  type: ObservationType | null;
  setType: (type: ObservationType | null) => void;
  fileText: string;
  setFileText: (text: string) => void;
  stale: boolean;
  setStale: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <div className="grid gap-1.5">
      <Input
        aria-label="Search"
        placeholder="Search memory…"
        value={qText}
        onChange={(e) => setQText(e.target.value)}
        className="h-8"
      />
      <div className="flex gap-1.5">
        <select
          aria-label="Type"
          title="Type"
          value={type ?? "all"}
          onChange={(e) =>
            setType(e.target.value === "all" ? null : (e.target.value as ObservationType))
          }
          className="h-8 rounded-md border border-input bg-card px-2 text-sm [&_option]:bg-popover"
        >
          <option value="all">all types</option>
          {OBSERVATION_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Input
          aria-label="File"
          placeholder="File path"
          value={fileText}
          onChange={(e) => setFileText(e.target.value)}
          className="h-8 flex-1"
        />
        <Button
          variant="outline"
          size="sm"
          aria-pressed={stale}
          onClick={() => setStale((s) => !s)}
          className="aria-pressed:border-ring aria-pressed:bg-selected aria-pressed:text-foreground"
        >
          {stale && <Check aria-hidden className="size-3.5" />}
          Include stale
        </Button>
      </div>
    </div>
  );
}

/** One observation's list row: its title and stale pill, then its type, time and id. */
function MemoryRow({ line }: { line: ObservationLine }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span data-title className="min-w-0 flex-1 truncate font-medium">
          {line.title}
        </span>
        {line.stale && <Pill tone="bad">stale</Pill>}
      </span>
      <span className="flex gap-2 text-xs text-muted-foreground">
        <span>{line.type}</span>
        <span className="tabular-nums">{formatTime(line.createdAtMs)}</span>
        <span className="font-mono">#{line.id}</span>
      </span>
    </>
  );
}

/** The chosen observation, or the note that stands in for it. */
function MemoryDetail({
  note,
  detail,
}: {
  note: string | null;
  detail: Observation | Note | null;
}) {
  return note !== null ? (
    <p className="px-6 py-8 text-muted-foreground md:px-8">{note}</p>
  ) : detail === null ? null : "note" in detail ? (
    <p className="px-6 py-8 text-muted-foreground md:px-8">{detail.note}</p>
  ) : (
    <ObservationDetail o={detail} />
  );
}

function Files({ paths }: { paths: string[] }) {
  if (paths.length === 0) return <span className="text-muted-foreground">none</span>;
  return (
    <ul className="grid gap-0.5">
      {paths.map((p) => (
        <li key={p} className="font-mono text-xs">
          {p}
        </li>
      ))}
    </ul>
  );
}

function ObservationDetail({ o }: { o: Observation }) {
  return (
    <div className={DETAIL_BODY}>
      <div className="grid gap-2">
        <h1 className="text-lg leading-snug font-semibold">{o.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{o.type}</span>
          <span className="font-mono">#{o.id}</span>
          <span>{formatTime(o.createdAtMs)}</span>
          <span>
            session <span className="font-mono">{o.sessionId}</span>
          </span>
        </div>
      </div>
      {o.staleFlag !== null && (
        <div className="grid gap-1 rounded-lg border border-bad-line bg-bad-soft px-4 py-3">
          <div className={cn(LABEL, "text-bad")}>Stale since {formatTime(o.staleFlag.atMs)}</div>
          <div>
            <Prose text={o.staleFlag.reason} />
          </div>
        </div>
      )}
      <div className="grid gap-1.5">
        <div className={LABEL}>Narrative</div>
        <p className="whitespace-pre-wrap">{o.narrative}</p>
      </div>
      <div className="grid gap-1.5">
        <div className={LABEL}>Facts</div>
        {o.facts.length === 0 ? (
          <span className="text-muted-foreground">none</span>
        ) : (
          <ul className="list-disc pl-5">
            {o.facts.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        )}
      </div>
      <Pairs
        pairs={[
          ["Files read", <Files paths={o.filesRead} />],
          ["Files modified", <Files paths={o.filesModified} />],
        ]}
      />
    </div>
  );
}

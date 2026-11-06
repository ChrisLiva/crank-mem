import { useCallback, useEffect, useState } from "react";
import { cn } from "cn";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useListKeys } from "@/hooks/use-list-keys";
import { formatTime, LABEL, ListFoot, Pairs, Row, usePaged } from "./shared";

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

  const lines = current?.rows ?? [];
  useEffect(() => {
    if (item === null && lines.length > 0) setItem(String(lines[0]!.id));
  }, [item, lines, setItem]);

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
        if (live) setDetail({ note: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      live = false;
    };
  }, [projectId, item, setItem]);

  const selected = lines.findIndex((l) => String(l.id) === item);
  const selectIndex = useCallback(
    (i: number) => {
      const line = lines[i];
      if (line !== undefined) setItem(String(line.id));
    },
    [lines, setItem],
  );
  useListKeys(lines.length, selected, selectIndex);

  return (
    <>
      <section aria-label="List" className="flex min-h-0 flex-col border-r">
        <div className="grid gap-2 border-b px-3 py-2.5">
          <h2 className="text-sm font-semibold">Memory</h2>
          {note === null && (
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
                  value={type ?? "all"}
                  onChange={(e) =>
                    setType(e.target.value === "all" ? null : (e.target.value as ObservationType))
                  }
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-sm [&_option]:bg-popover"
                >
                  <option value="all">all</option>
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
                  aria-label="Stale"
                  aria-pressed={stale}
                  onClick={() => setStale((s) => !s)}
                  className={cn(stale && "bg-accent text-accent-foreground")}
                >
                  Stale
                </Button>
              </div>
            </div>
          )}
        </div>
        <div data-list className="min-h-0 flex-1 overflow-auto">
          {note !== null ? (
            <p className="px-4 py-8 text-center text-muted-foreground">{note}</p>
          ) : error !== null ? (
            <p className="px-4 py-8 text-center text-destructive">{error}</p>
          ) : current !== null && current.rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-muted-foreground">Nothing matches.</p>
          ) : (
            lines.map((line) => (
              <Row
                key={line.id}
                selected={String(line.id) === item}
                onClick={() => setItem(String(line.id))}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span data-title className="min-w-0 flex-1 truncate font-medium">
                    {line.title}
                  </span>
                  {line.stale && <span className="text-xs text-destructive">stale</span>}
                </span>
                <span className="flex gap-2 text-xs text-muted-foreground">
                  <span>{line.type}</span>
                  <span className="tabular-nums">{formatTime(line.createdAtMs)}</span>
                  <span className="font-mono">#{line.id}</span>
                </span>
              </Row>
            ))
          )}
        </div>
        <ListFoot
          start={
            <>
              {current !== null && <span>{current.rows.length} shown</span>}
              {current?.mode != null && <Badge variant="outline">{current.mode}</Badge>}
            </>
          }
          older={older}
        />
      </section>
      <section aria-label="Detail" className="min-h-0 overflow-auto">
        {note !== null ? (
          <p className="px-6 py-8 text-muted-foreground">{note}</p>
        ) : detail === null ? null : "note" in detail ? (
          <p className="px-6 py-8 text-muted-foreground">{detail.note}</p>
        ) : (
          <ObservationDetail o={detail} />
        )}
      </section>
    </>
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
    <div className="grid max-w-3xl gap-5 px-6 pt-5 pb-10">
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs text-muted-foreground">
          <Badge variant="secondary">{o.type}</Badge>
          <span className="font-mono">#{o.id}</span>
          <span>{formatTime(o.createdAtMs)}</span>
          <span>
            session <span className="font-mono">{o.sessionId}</span>
          </span>
        </div>
        <h1 className="text-lg leading-snug font-semibold">{o.title}</h1>
      </div>
      {o.staleFlag !== null && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-3">
          <div className={cn(LABEL, "text-destructive")}>
            Stale since {formatTime(o.staleFlag.atMs)}
          </div>
          <div>{o.staleFlag.reason}</div>
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

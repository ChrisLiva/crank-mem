import { useCallback, useEffect, useRef, useState } from "react";
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
import { usePoll } from "@/hooks/use-poll";
import { useListKeys } from "@/hooks/use-list-keys";

const TYPE_DELAY_MS = 300;

type Listed = {
  key: string;
  lines: ObservationLine[];
  next: string | null;
  mode: string | null;
  pages: number;
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** `value`, once it has held still for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Newest first: by `createdAtMs`, then by `id`. */
function olderThan(a: ObservationLine, b: ObservationLine): boolean {
  return a.createdAtMs < b.createdAtMs || (a.createdAtMs === b.createdAtMs && a.id < b.id);
}

/** A fresh first page, with the older pages already loaded kept beneath it. */
function withOlderPages(prev: Listed | Note | null, first: Listed): Listed {
  if (prev === null || "note" in prev || prev.key !== first.key || prev.pages < 2) return first;
  const last = first.lines[first.lines.length - 1];
  if (last === undefined || first.next === null) return first;
  const older = prev.lines.filter((l) => olderThan(l, last));
  return { ...first, lines: [...first.lines, ...older], next: prev.next, pages: prev.pages };
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
  const keyRef = useRef(key);
  keyRef.current = key;

  const [listed, setListed] = useState<Listed | Note | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (before: string | null) => {
    const asked = key;
    try {
      const page = await fetchObservations(projectId, filters, before);
      if (keyRef.current !== asked) return;
      setError(null);
      if ("note" in page) return setListed(page);
      const got: Listed = {
        key: asked,
        lines: page.lines,
        next: page.next,
        mode: page.mode ?? null,
        pages: 1,
      };
      setListed((prev) => {
        if (before === null) return withOlderPages(prev, got);
        if (prev === null || "note" in prev || prev.key !== asked) return prev;
        return { ...got, lines: [...prev.lines, ...got.lines], pages: prev.pages + 1 };
      });
    } catch (err) {
      if (keyRef.current === asked) setError(err instanceof Error ? err.message : String(err));
    }
  };
  usePoll(() => load(null), [key]);

  const lines = listed !== null && !("note" in listed) && listed.key === key ? listed.lines : [];
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

  const selectedRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: "nearest" });
  }, [item]);

  const note = listed !== null && "note" in listed ? listed.note : null;
  const current = listed !== null && !("note" in listed) && listed.key === key ? listed : null;

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
          ) : current !== null && current.lines.length === 0 ? (
            <p className="px-4 py-8 text-center text-muted-foreground">Nothing matches.</p>
          ) : (
            lines.map((line) => {
              const isSelected = String(line.id) === item;
              return (
                <button
                  key={line.id}
                  type="button"
                  data-row
                  data-id={line.id}
                  ref={isSelected ? selectedRow : undefined}
                  aria-current={isSelected || undefined}
                  onClick={() => setItem(String(line.id))}
                  className={cn(
                    "grid w-full gap-0.5 border-b border-l-2 border-l-transparent px-3 py-2 text-left hover:bg-accent/60",
                    isSelected && "border-l-primary bg-accent",
                  )}
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
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            {current !== null && <span>{current.lines.length} shown</span>}
            {current?.mode != null && <Badge variant="outline">{current.mode}</Badge>}
          </span>
          <span className="flex items-center gap-2">
            <span>
              <kbd className="font-mono">j</kbd> <kbd className="font-mono">k</kbd>
            </span>
            {current !== null && current.next !== null && (
              <Button variant="outline" size="xs" onClick={() => load(current.next)}>
                Older
              </Button>
            )}
          </span>
        </div>
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

const LABEL = "text-[11px] font-medium tracking-wide text-muted-foreground uppercase";

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
      <div className="grid grid-cols-[160px_1fr] rounded-lg border bg-card text-card-foreground">
        <div className="border-b px-3.5 py-2 text-xs text-muted-foreground">Files read</div>
        <div className="border-b px-3.5 py-2">
          <Files paths={o.filesRead} />
        </div>
        <div className="px-3.5 py-2 text-xs text-muted-foreground">Files modified</div>
        <div className="px-3.5 py-2">
          <Files paths={o.filesModified} />
        </div>
      </div>
    </div>
  );
}

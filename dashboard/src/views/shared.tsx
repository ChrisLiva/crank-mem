import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import type { Note } from "@/api";
import { Button } from "@/components/ui/button";
import { usePoll } from "@/hooks/use-poll";
import { useListKeys } from "@/hooks/use-list-keys";

export const LABEL = "text-[11px] font-medium tracking-wide text-muted-foreground uppercase";

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

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

/** The list's foot: `start` on the left, the j/k hint and an "Older" control when `older` is set. */
export function ListFoot({ start, older }: { start?: ReactNode; older?: (() => void) | null }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-2">{start}</span>
      <span className="flex items-center gap-2">
        <span>
          <kbd className="font-mono">j</kbd> <kbd className="font-mono">k</kbd>
        </span>
        {older != null && (
          <Button variant="outline" size="xs" onClick={older}>
            Older
          </Button>
        )}
      </span>
    </div>
  );
}

/** One page of a list; `next` is the `before` that asks for the page after it. */
export type Page<T> = { rows: T[]; next: string | null; mode?: string } | Note;

type Listed<T> = {
  key: string;
  rows: T[];
  next: string | null;
  mode: string | null;
  pages: number;
};

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

/**
 * Page 1 of `fetchPage` on each `key` and each poll, and `older` to append the page after the
 * last, or null when there is none. An answer for a key that is no longer current is dropped.
 */
export function usePaged<T extends { id: number }>(
  key: string,
  fetchPage: (before: string | null) => Promise<Page<T>>,
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
      const got: Listed<T> = {
        key: asked,
        rows: page.rows,
        next: page.next,
        mode: page.mode ?? null,
        pages: 1,
      };
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
  const next = current?.next ?? null;
  return { current, note, error, older: next === null ? null : () => void load(next) };
}

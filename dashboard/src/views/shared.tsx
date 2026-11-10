import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import { Check, Copy } from "lucide-react";
import type { Note, Page, Tone } from "@/api";
import { Button } from "@/components/ui/button";
import { usePoll } from "@/hooks/use-poll";
import { useListKeys } from "@/hooks/use-list-keys";

export const LABEL = "text-xs font-medium text-muted-foreground";

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** How long ago `ms` was, in the largest whole unit: "40s ago", "3m ago", "2h ago", "5d ago". */
export function formatAgo(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

/** Dollars to the cent, or to two significant digits under a cent, as `crank-mem stats` prints them. */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toPrecision(2)}` : `$${usd.toFixed(2)}`;
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  off: "text-off",
};
const TONE_PILL: Record<Tone, string> = {
  ok: "border-ok-line bg-ok-soft text-ok",
  warn: "border-warn-line bg-warn-soft text-warn",
  bad: "border-bad-line bg-bad-soft text-bad",
  off: "border-off-line bg-off-soft text-off",
};
const TONE_DOT: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  off: "bg-off",
};

/** A small rounded label whose tone carries state; the words always say it too. */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        TONE_PILL[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 flex-none rounded-full", TONE_DOT[tone], className)}
    />
  );
}

/** A command in mono with a button that copies it. */
export function Command({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-muted py-0.5 pr-0.5 pl-2 font-mono text-xs">
      {command}
      <button
        type="button"
        aria-label={copied ? "Copied" : `Copy ${command}`}
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => setCopied(true));
        }}
        className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </span>
  );
}

/** A bordered card holding one figure: label, value, and a line of context under it. */
export function Stat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="grid min-w-0 content-start gap-1 rounded-lg border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "truncate text-2xl leading-tight font-semibold tracking-tight",
          tone && tone !== "ok" && TONE_TEXT[tone],
        )}
      >
        {value}
      </div>
      {detail !== undefined && <div className="text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

/** A segmented control of standard buttons; the pressed one is the current value. */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border bg-card p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className="h-6 rounded-[5px] px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
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

/** The list-and-detail views' split: the list column, then the chosen row's detail. */
export const SPLIT = "grid min-h-0 flex-1 md:grid-cols-[minmax(20rem,28rem)_1fr]";
export const LIST_COLUMN =
  "flex max-h-[70dvh] min-h-0 flex-col border-b bg-card md:max-h-none md:border-r md:border-b-0";
export const DETAIL_COLUMN = "min-h-0 overflow-auto";
export const DETAIL_BODY = "grid max-w-3xl gap-6 px-6 pt-6 pb-12 md:px-8";

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
        "grid w-full gap-1 border-b px-4 py-2.5 text-left outline-offset-[-2px] hover:bg-accent/70",
        selected && "bg-selected hover:bg-selected",
      )}
    >
      {children}
    </button>
  );
}

/** A link to observation `id` in the Memory view. */
export function ObservationLink({ id, open }: { id: number; open: (id: number) => void }) {
  return (
    <button type="button" onClick={() => open(id)} className="font-mono text-link hover:underline">
      #{id}
    </button>
  );
}

/**
 * Label and value pairs in two columns, in a bordered card unless `bare` (inside a card
 * that already has one); the `highlight` label's pair stands out.
 */
export function Pairs({
  pairs,
  highlight,
  bare,
}: {
  pairs: [label: string, value: ReactNode][];
  highlight?: string;
  bare?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(7rem,10rem)_1fr] text-card-foreground",
        !bare && "rounded-lg border bg-card",
      )}
    >
      {pairs.map(([label, value], i) => {
        const cell = cn(
          bare ? "py-2 pr-4" : "px-4 py-2.5",
          i < pairs.length - 1 && "border-b",
          label === highlight && "bg-selected font-medium",
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

/** Markdown's `code` and **bold** spans in `text` as inline elements; everything else stays text. */
export function Prose({ text }: { text: string }) {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).map((part, i) =>
    i % 2 === 0 ? (
      <Fragment key={i}>{part}</Fragment>
    ) : part.startsWith("`") ? (
      <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.9em]">
        {part.slice(1, -1)}
      </code>
    ) : (
      <strong key={i} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ),
  );
}

/** The list's foot: `start` on the left, the j/k hint and an "Older" control when `older` is set. */
export function ListFoot({ start, older }: { start?: ReactNode; older?: (() => void) | null }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t bg-card px-4 py-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-2">{start}</span>
      <span className="flex items-center gap-2">
        <span className="flex items-center gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>
          to move
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

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="grid h-5 min-w-5 place-items-center rounded border bg-muted px-1 font-mono text-[11px] text-foreground">
      {children}
    </kbd>
  );
}

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

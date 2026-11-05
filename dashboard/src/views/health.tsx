import { useState } from "react";
import { fetchHealth } from "@/api";
import { usePoll } from "@/hooks/use-poll";
import { Pairs, Row, useSelection } from "./curation";

/** Columns 2 and 3 for a project's health: the `crank-mem stats` capture rows, keyed by label. */
export function HealthView({
  projectId,
  item,
  setItem,
}: {
  projectId: string;
  item: string | null;
  setItem: (item: string | null) => void;
}) {
  const [rows, setRows] = useState<[string, string][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePoll(async () => {
    try {
      setRows(await fetchHealth(projectId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);
  useSelection(rows === null ? null : rows.map(([label]) => label), item, setItem);

  return (
    <>
      <section aria-label="List" className="flex min-h-0 flex-col border-r">
        <div className="border-b px-3 py-2.5">
          <h2 className="text-sm font-semibold">Health</h2>
        </div>
        <div data-list className="min-h-0 flex-1 overflow-auto">
          {error !== null ? (
            <p className="px-4 py-8 text-center text-destructive">{error}</p>
          ) : (
            rows?.map(([label, value]) => (
              <Row key={label} selected={label === item} onClick={() => setItem(label)}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex-1">{label}</span>
                  <span className="truncate text-right">{value}</span>
                </span>
              </Row>
            ))
          )}
        </div>
        <div className="flex justify-end border-t px-3 py-2 text-xs text-muted-foreground">
          <span>
            <kbd className="font-mono">j</kbd> <kbd className="font-mono">k</kbd>
          </span>
        </div>
      </section>
      <section aria-label="Detail" className="min-h-0 overflow-auto">
        {rows !== null && (
          <div className="grid max-w-3xl gap-5 px-6 pt-5 pb-10">
            <h1 className="text-lg leading-snug font-semibold">Health</h1>
            <Pairs pairs={rows} highlight={item ?? undefined} />
          </div>
        )}
      </section>
    </>
  );
}

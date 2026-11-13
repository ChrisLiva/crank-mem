import { useState } from "react";
import { fetchUntouched, type UntouchedRepo } from "@/api";
import { usePoll } from "@/hooks/use-poll";
import { Command, formatAgo, formatTime } from "./shared";

/** Repos agents wrote to that have no crank-mem install; hidden while there are none. */
export function UntouchedSection() {
  const [repos, setRepos] = useState<UntouchedRepo[] | null>(null);
  usePoll(async (isCurrent) => {
    const next = await fetchUntouched();
    if (isCurrent()) setRepos(next.repos);
  }, []);
  if (repos === null || repos.length === 0) return null;

  return (
    <section
      aria-labelledby="untouched-heading"
      className="grid content-start gap-3 rounded-lg border bg-card p-4"
    >
      <header className="grid gap-0.5">
        <h2 id="untouched-heading" className="text-sm font-semibold">
          Not installed
        </h2>
        <p className="text-xs text-muted-foreground">
          Agents wrote to these repos in the last 30 days; their memory is not captured
        </p>
      </header>
      <ul className="grid gap-1">
        {repos.map((r) => (
          <li key={r.root} className="flex flex-wrap items-baseline justify-between gap-x-4">
            <span className="font-mono text-xs break-all">{r.root}</span>
            <time
              dateTime={new Date(r.lastSeenMs).toISOString()}
              title={formatTime(r.lastSeenMs)}
              className="text-xs text-muted-foreground"
            >
              {formatAgo(r.lastSeenMs)}
            </time>
          </li>
        ))}
      </ul>
      <span className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Run in each repo to install:</span>
        <Command command="crank-mem init" />
      </span>
    </section>
  );
}

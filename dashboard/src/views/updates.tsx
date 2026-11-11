import { useState, type ReactNode } from "react";
import { fetchUpdates, type Tone, type UpdateStatus } from "@/api";
import { usePoll } from "@/hooks/use-poll";
import { Command, formatAgo, formatTime, Pairs, Pill } from "./shared";

const CLONE_NOTE = "Running from a clone — update with git pull, then crank-mem upgrade --all";

/** The state word for the pill: clone, never checked, last check failed, available or current. */
function stateOf(s: UpdateStatus): { tone: Tone; label: string } {
  if (!s.installedCopy) return { tone: "off", label: "Clone" };
  if (s.available) return { tone: "warn", label: "Update available" };
  if (s.error !== null) return { tone: "bad", label: "Check failed" };
  if (s.latest === null) return { tone: "off", label: "Not checked" };
  return { tone: "ok", label: "Up to date" };
}

const onOff = (on: boolean) => (on ? "On" : "Off");
const mono = (text: string) => <span className="font-mono text-xs">{text}</span>;

function Latest({ latest }: { latest: UpdateStatus["latest"] }) {
  if (latest === null) return <span className="text-muted-foreground">not checked yet</span>;
  const date = new Date(latest.releasedAt);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {mono(latest.version)}
      {!Number.isNaN(date.getTime()) && (
        <time dateTime={latest.releasedAt} className="text-muted-foreground">
          released {date.toLocaleDateString(undefined, { dateStyle: "medium" })}
        </time>
      )}
      <a
        href={latest.notesUrl}
        target="_blank"
        rel="noreferrer"
        className="text-xs font-medium text-link hover:underline"
      >
        Release notes
      </a>
    </span>
  );
}

function LastCheck({ status: s }: { status: UpdateStatus }) {
  if (s.checkedAtMs === null) return <span className="text-muted-foreground">never</span>;
  return (
    <span className="grid gap-0.5">
      <time dateTime={new Date(s.checkedAtMs).toISOString()} title={formatTime(s.checkedAtMs)}>
        {formatAgo(s.checkedAtMs)}
      </time>
      {s.error !== null && <span className="text-xs break-all text-bad">{s.error}</span>}
    </span>
  );
}

function Behind({ behind }: { behind: UpdateStatus["behind"] }) {
  if (behind.length === 0) return <span className="text-muted-foreground">none</span>;
  return (
    <ul className="grid gap-1">
      {behind.map((p) => (
        <li key={p.root} className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{p.name}</span>
          <span className="text-xs text-muted-foreground">hooks {mono(p.vendored)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The release check as the server last recorded it; it changes nothing, and names the commands that do. */
export function UpdatesSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  usePoll(async (isCurrent) => {
    const next = await fetchUpdates();
    if (isCurrent()) setStatus(next);
  }, []);
  if (status === null) return null;
  const state = stateOf(status);
  const pairs: [string, ReactNode][] = [
    ["Installed", mono(status.installed)],
    ["Latest", <Latest latest={status.latest} />],
    ["Last check", <LastCheck status={status} />],
    ["Daily check", onOff(status.checkDaily)],
    ["Auto update", onOff(status.auto)],
    ["Projects behind", <Behind behind={status.behind} />],
  ];

  return (
    <section
      aria-labelledby="updates-heading"
      className="grid content-start gap-3 rounded-lg border bg-card p-4"
    >
      <header className="flex items-start justify-between gap-4">
        <div className="grid gap-0.5">
          <h2 id="updates-heading" className="text-sm font-semibold">
            Updates
          </h2>
          <p className="text-xs text-muted-foreground">
            {!status.installedCopy
              ? CLONE_NOTE
              : status.checkDaily
                ? "Checked once a day against the latest release"
                : "Daily checks are off"}
          </p>
        </div>
        <Pill tone={state.tone}>{state.label}</Pill>
      </header>
      <Pairs bare pairs={pairs} />
      {(status.available || status.behind.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          {status.available && status.latest !== null && (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-warn">{status.latest.version} is available.</span>
              <Command command="crank-mem self-update" />
            </span>
          )}
          {status.behind.length > 0 && (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">
                {status.behind.length}{" "}
                {status.behind.length === 1 ? "project runs" : "projects run"} older hooks.
              </span>
              <Command command="crank-mem upgrade --all" />
            </span>
          )}
        </div>
      )}
    </section>
  );
}

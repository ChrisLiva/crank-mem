import type { Dot, HealthSummary, Project } from "./api";

export type Tone = "ok" | "warn" | "bad" | "off";

/** What a project's capture needs: a tone, a short label, and the fact and command that fix it when one exists. */
export type Status = { tone: Tone; label: string; fix: { text: string; command?: string } | null };

const STORE_FIX = {
  missing: { text: "No memory yet: the first digest creates it." },
  older: { text: "memory.db predates this version.", command: "crank-mem upgrade" },
  newer: { text: "memory.db is newer than this version.", command: "crank-mem upgrade" },
  unreadable: {
    text: "memory.db is not a readable database.",
    command: "crank-mem restore-memory",
  },
} as const;

/**
 * The first problem in order of how much capture it stops: digests off or stopped,
 * a store that does not open, a daemon that is down while entries wait, parked
 * entries, an embedder that is not ready.
 */
export function projectStatus(h: HealthSummary): Status {
  if (h.digest === "off")
    return {
      tone: "off",
      label: "Digests off",
      fix: { text: "Digests are off in this checkout.", command: "crank-mem digest on" },
    };
  if (h.digest === "stopped")
    return {
      tone: "bad",
      label: "Stopped",
      fix: {
        text:
          h.stopReason === "credential"
            ? "Digests stopped on a credential other than your Claude login."
            : "Digests stopped: claude is not logged in. Log in, then resume.",
        command: "crank-mem digest resume",
      },
    };
  if (h.store !== "open")
    return {
      tone: h.store === "missing" ? "off" : "bad",
      label: h.store === "missing" ? "No memory yet" : "Store needs a look",
      fix: STORE_FIX[h.store],
    };
  if (!h.daemonAlive && h.spool.waiting > 0)
    return {
      tone: "warn",
      label: "Daemon down",
      fix: {
        text: `${h.spool.waiting} waiting with no daemon to digest them.`,
        command: "crank-mem digest resume",
      },
    };
  if (h.spool.parked > 0)
    return {
      tone: "warn",
      label: "Parked entries",
      fix: {
        text: `${h.spool.parked} parked: no digest job could finish them. Each returns when its session writes again.`,
      },
    };
  if (!h.embedderReady)
    return {
      tone: "warn",
      label: "Keyword search only",
      fix: { text: "The local search model is not installed.", command: "crank-mem setup" },
    };
  return { tone: "ok", label: "Healthy", fix: null };
}

const DOT_TONE: Record<Dot, Tone> = { green: "ok", amber: "warn", grey: "off" };

/** A project's tone: its summary's once that arrives, the project list's dot before. */
export function projectTone(project: Project, health: HealthSummary | undefined): Tone {
  return health === undefined ? DOT_TONE[project.dot] : projectStatus(health).tone;
}

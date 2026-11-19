import { describe, expect, test } from "bun:test";
import { projectStatus, type HealthSummary, type Tone } from "../src/hooks/lib/wire.ts";

type Input = Omit<HealthSummary, "status">;
type Expected = { tone: Tone; label: string; command: string | null };

const base: Input = {
  digest: "on",
  stopReason: null,
  daemonAlive: true,
  spool: { waiting: 0, parked: 0 },
  store: "open",
  graph: { status: "open", files: 3, pending: 0 },
  memory: null,
  lastSnapshotMs: null,
  embedderReady: true,
};

const DIGESTS_OFF: Expected = { tone: "off", label: "Digests off", command: "crank-mem digest on" };
const STOPPED: Expected = { tone: "bad", label: "Stopped", command: "crank-mem digest resume" };
const DAEMON_DOWN: Expected = {
  tone: "warn",
  label: "Daemon down",
  command: "crank-mem digest resume",
};
const PARKED: Expected = { tone: "warn", label: "Parked entries", command: null };
const storeLook = (command: string): Expected => ({
  tone: "bad",
  label: "Store needs a look",
  command,
});
const GRAPH_LOOK: Expected = {
  tone: "bad",
  label: "Code graph needs a look",
  command: "crank-mem scan",
};
const HEALTHY: Expected = { tone: "ok", label: "Healthy", command: null };

describe("projectStatus", () => {
  const rows: [string, Partial<Input>, Expected][] = [
    [
      "digest off, even with no store and a waiting entry",
      { digest: "off", store: "missing", daemonAlive: false, spool: { waiting: 1, parked: 0 } },
      DIGESTS_OFF,
    ],
    [
      "stopped on login, even with no store",
      { digest: "stopped", stopReason: "login", store: "missing" },
      STOPPED,
    ],
    [
      "stopped on a credential beats a store that won't open",
      { digest: "stopped", stopReason: "credential", store: "unreadable", embedderReady: false },
      STOPPED,
    ],
    [
      "a missing store beats daemon down",
      { store: "missing", daemonAlive: false, spool: { waiting: 1, parked: 0 } },
      { tone: "off", label: "No memory yet", command: null },
    ],
    [
      "a newer store beats daemon down",
      { store: "newer", daemonAlive: false, spool: { waiting: 1, parked: 0 } },
      storeLook("crank-mem upgrade"),
    ],
    [
      "an older store needs a look, even with the daemon down",
      { store: "older", daemonAlive: false, spool: { waiting: 1, parked: 0 } },
      storeLook("crank-mem upgrade"),
    ],
    [
      "an unreadable store names restore-memory, even with the daemon down",
      { store: "unreadable", daemonAlive: false, spool: { waiting: 1, parked: 0 } },
      storeLook("crank-mem restore-memory"),
    ],
    [
      "daemon down beats parked",
      { daemonAlive: false, spool: { waiting: 1, parked: 1 } },
      DAEMON_DOWN,
    ],
    [
      "parked beats keyword search only, and a dead daemon with nothing waiting is not down",
      { daemonAlive: false, spool: { waiting: 0, parked: 1 }, embedderReady: false },
      PARKED,
    ],
    [
      "keyword search only",
      { embedderReady: false },
      { tone: "warn", label: "Keyword search only", command: "crank-mem setup" },
    ],
    [
      "a graph to rebuild beats digests off and a missing store",
      { digest: "off", store: "missing", graph: { status: "rebuild", files: 0, pending: 0 } },
      GRAPH_LOOK,
    ],
    [
      "an unreadable graph names crank-mem scan, even when digests are stopped",
      {
        digest: "stopped",
        stopReason: "login",
        graph: { status: "unreadable", files: 0, pending: 0 },
      },
      GRAPH_LOOK,
    ],
    [
      "a missing graph is not a problem",
      { graph: { status: "missing", files: 0, pending: 0 } },
      HEALTHY,
    ],
    [
      "a pending parse is not a problem",
      { graph: { status: "open", files: 3, pending: 2 } },
      HEALTHY,
    ],
    ["healthy", {}, HEALTHY],
    ["a dead daemon with nothing waiting is healthy", { daemonAlive: false }, HEALTHY],
  ];
  for (const [name, overrides, expected] of rows) {
    test(name, () => {
      const status = projectStatus({ ...base, ...overrides });
      expect({
        tone: status.tone,
        label: status.label,
        command: status.fix === null ? null : (status.fix.command ?? null),
      }).toEqual(expected);
    });
  }
});

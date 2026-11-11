import { describe, expect, test } from "bun:test";
import { projectStatus, type HealthSummary, type Status } from "../src/hooks/lib/wire.ts";

type Input = Omit<HealthSummary, "status">;

const base: Input = {
  digest: "on",
  stopReason: null,
  daemonAlive: true,
  spool: { waiting: 0, parked: 0 },
  store: "open",
  memory: null,
  lastSnapshotMs: null,
  embedderReady: true,
};

const DIGESTS_OFF: Status = {
  tone: "off",
  label: "Digests off",
  fix: { text: "Digests are off in this checkout.", command: "crank-mem digest on" },
};
const STOPPED_LOGIN: Status = {
  tone: "bad",
  label: "Stopped",
  fix: {
    text: "Digests stopped: claude is not logged in. Log in, then resume.",
    command: "crank-mem digest resume",
  },
};
const STOPPED_CREDENTIAL: Status = {
  tone: "bad",
  label: "Stopped",
  fix: {
    text: "Digests stopped on a credential other than your Claude login.",
    command: "crank-mem digest resume",
  },
};
const DAEMON_DOWN: Status = {
  tone: "warn",
  label: "Daemon down",
  fix: { text: "1 waiting with no daemon to digest them.", command: "crank-mem digest resume" },
};
const PARKED: Status = {
  tone: "warn",
  label: "Parked entries",
  fix: {
    text: "1 parked: no digest job could finish them. Each returns when its session writes again.",
  },
};
const HEALTHY: Status = { tone: "ok", label: "Healthy", fix: null };

describe("projectStatus", () => {
  const rows: [string, Partial<Input>, Status][] = [
    [
      "digest off, even with no store and a waiting entry",
      { digest: "off", store: "missing", daemonAlive: false, spool: { waiting: 1, parked: 0 } },
      DIGESTS_OFF,
    ],
    [
      "stopped on login, even with no store",
      { digest: "stopped", stopReason: "login", store: "missing" },
      STOPPED_LOGIN,
    ],
    [
      "stopped on a credential beats a store that won't open",
      { digest: "stopped", stopReason: "credential", store: "unreadable", embedderReady: false },
      STOPPED_CREDENTIAL,
    ],
    [
      "a missing store beats daemon down",
      { store: "missing", daemonAlive: false, spool: { waiting: 1, parked: 0 } },
      { tone: "off", label: "No memory yet", fix: { text: "The first digest creates it." } },
    ],
    [
      "a newer store beats daemon down",
      { store: "newer", daemonAlive: false, spool: { waiting: 1, parked: 0 } },
      {
        tone: "bad",
        label: "Store needs a look",
        fix: { text: "memory.db is newer than this version.", command: "crank-mem upgrade" },
      },
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
      {
        tone: "warn",
        label: "Keyword search only",
        fix: { text: "The local search model is not installed.", command: "crank-mem setup" },
      },
    ],
    ["healthy", {}, HEALTHY],
    ["a dead daemon with nothing waiting is healthy", { daemonAlive: false }, HEALTHY],
  ];
  for (const [name, overrides, expected] of rows) {
    test(name, () => {
      expect(projectStatus({ ...base, ...overrides })).toEqual(expected);
    });
  }

  for (const [store, command] of [
    ["older", "crank-mem upgrade"],
    ["unreadable", "crank-mem restore-memory"],
  ] as const) {
    test(`an ${store} store needs a look and names ${command}, even with the daemon down`, () => {
      const status = projectStatus({
        ...base,
        store,
        daemonAlive: false,
        spool: { waiting: 1, parked: 0 },
      });
      expect(status.tone).toBe("bad");
      expect(status.label).toBe("Store needs a look");
      expect(status.fix?.command).toBe(command);
    });
  }
});

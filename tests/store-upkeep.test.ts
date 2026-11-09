import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MEMORY_FILE, openMemory, type Memory } from "../src/hooks/lib/memory.ts";
import { cleanup, seedMemory, setMtime, tempDir } from "./helpers.ts";

const DAILY = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;
const DAY_MS = 24 * 3_600_000;

const open: { close(): void }[] = [];

afterEach(async () => {
  for (const memory of open.splice(0)) memory.close();
  await cleanup();
});

/** A project folder with no `.git`, so its store is `<root>/.crank/memory.db`. */
function store(): { root: string; file: string; dir: string } {
  const root = tempDir("crank-upkeep-");
  const crank = path.join(root, ".crank");
  return { root, file: path.join(crank, MEMORY_FILE), dir: path.join(crank, "backups", "memory") };
}

function writable(file: string): Memory {
  const opened = openMemory(file, "write");
  if (opened.status !== "open") throw new Error(`expected open, got ${opened.status}`);
  open.push(opened.memory);
  return opened.memory;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the daily pass snapshots when due, then deletes only rows stale more than 90 days, after the snapshot", async () => {
  const { root, file, dir } = store();
  const [a, b, c, d] = seedMemory(
    root,
    [
      { title: "Upkeep alpha", filesRead: ["src/a.ts"] },
      { title: "Upkeep bravo" },
      { title: "Upkeep charlie" },
      { title: "Upkeep delta" },
    ],
    { proposals: [{ kind: "memory", bullet: "**Keep**: proposals survive retention" }] },
  ) as [number, number, number, number];
  const m = writable(file);
  m.putVectors("m1", [{ id: a, vector: new Float32Array([1, 0]) }]);
  expect(m.hasVectors("m1")).toBe(true);

  // No snapshot yet: the pass writes one and deletes nothing.
  const first = m.maintain();
  expect(first).not.toBeNull();
  expect(first!.deleted).toBe(0);
  expect(path.dirname(first!.snapshot)).toBe(dir);
  expect(path.basename(first!.snapshot)).toMatch(DAILY);
  expect(fs.readdirSync(dir)).toEqual([path.basename(first!.snapshot)]);

  // An hour later the pass is not due.
  expect(m.maintain(Date.now() + 3_600_000)).toBeNull();
  expect(fs.readdirSync(dir)).toEqual([path.basename(first!.snapshot)]);
  expect(m.get([a, b, c, d])).toHaveLength(4);

  // Flag A, then B, then C, each at a later millisecond.
  let previous = 0;
  for (const id of [a, b, c]) {
    while (Date.now() <= previous) await sleep(1);
    seedMemory(root, [], { stale: [{ id, reason: "replaced" }] });
    previous = m.staleRows({ before: null, limit: 10 }).find((r) => r.id === id)!.staleAtMs;
  }
  const flagged = new Map(m.staleRows({ before: null, limit: 10 }).map((r) => [r.id, r.staleAtMs]));
  const [tA, tB, tC] = [flagged.get(a)!, flagged.get(b)!, flagged.get(c)!];
  expect(tA).toBeLessThan(tB);
  expect(tB).toBeLessThan(tC);

  // Exactly 90 days after B: A is past the cutoff, B sits on it, C is later, D was never flagged.
  const second = m.maintain(tB + 90 * DAY_MS);
  expect(second).not.toBeNull();
  const s2 = second!.snapshot;
  expect(second!.deleted).toBe(1);
  expect(path.basename(s2)).toMatch(DAILY);
  expect(path.basename(s2) < new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)).toBe(
    true,
  );
  expect(m.get([a])).toEqual([]);
  expect(m.get([b, c, d])).toHaveLength(3);
  expect(m.proposalRows({ state: null, beforeId: null, limit: 10 })).toHaveLength(1);
  expect(m.hasVectors("m1")).toBe(false);

  // The snapshot was written before the delete, so it still holds A.
  const snap = openMemory(s2, "read");
  expect(snap.status).toBe("open");
  if (snap.status === "open") {
    open.push(snap.memory);
    expect(snap.memory.get([a]).map((o) => o.id)).toEqual([a]);
  }
});

test("the due check counts a -v1.db snapshot and skips a .tmp file", () => {
  const planted = (name: string): { m: Memory; dir: string } => {
    const { root, file, dir } = store();
    seedMemory(root, [{ title: "x" }]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), "");
    return { m: writable(file), dir };
  };

  const v1 = planted("2026-01-01T00-00-00-000Z-v1.db");
  expect(v1.m.maintain()).toBeNull();
  expect(fs.readdirSync(v1.dir)).toEqual(["2026-01-01T00-00-00-000Z-v1.db"]);

  const tmp = planted("memory.db.1.1.tmp");
  expect(tmp.m.maintain()).not.toBeNull();
  const names = fs.readdirSync(tmp.dir);
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(DAILY);
});

test("the trim keeps the newest 7 daily snapshots and every other name, and removes temp files", () => {
  const { root, file, dir } = store();
  seedMemory(root, [{ title: "x" }]);
  fs.mkdirSync(dir, { recursive: true });
  const days = [1, 2, 3, 4, 5, 6, 7].map((d) => `2026-01-0${d}T00-00-00-000Z.db`);
  const kept = [
    "2026-01-01T00-00-00-000Z-v1.db",
    "2026-01-01T00-00-00-000Z.damaged",
    "2026-01-01T00-00-00-000Z.damaged-wal",
  ];
  for (const name of [...days, ...kept, "memory.db.123.1.tmp"]) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "");
    setMtime(p, Date.UTC(2026, 0, 1));
  }

  expect(writable(file).maintain()).not.toBeNull();
  const names = fs.readdirSync(dir).sort();
  expect(names).toHaveLength(10);
  expect(names.slice(0, -1)).toEqual([...kept, ...days.slice(1)]);
  expect(names.at(-1)).toMatch(DAILY);
  expect(names.at(-1)! > days.at(-1)!).toBe(true);
});

test("a snapshot that cannot be written throws and deletes nothing", () => {
  const { root, file } = store();
  const [id] = seedMemory(root, [{ title: "x" }]) as [number];
  seedMemory(root, [], { stale: [{ id, reason: "replaced" }] });
  const m = writable(file);
  const staleAtMs = m.staleRows({ before: null, limit: 10 })[0]!.staleAtMs;
  fs.mkdirSync(path.join(root, ".crank", "backups"));
  fs.writeFileSync(path.join(root, ".crank", "backups", "memory"), "x");

  expect(() => m.maintain(staleAtMs + 91 * DAY_MS)).toThrow();
  expect(m.get([id]).map((o) => o.id)).toEqual([id]);
  const entries = fs.readdirSync(path.join(root, ".crank"), { recursive: true }).map(String);
  expect(entries.filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MEMORY_FILE,
  memoryStatus,
  openMemory,
  type DigestInput,
  type Memory,
  type NewObservation,
  type Position,
} from "../src/hooks/lib/memory.ts";

const open: { close(): void }[] = [];

afterEach(() => {
  for (const memory of open.splice(0)) memory.close();
});

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crank-memory-")), ".crank", MEMORY_FILE);
}

function writable(file = tmpFile()): Memory {
  const result = openMemory(file, "write");
  if (result.status !== "open") throw new Error(`expected open, got ${result.status}`);
  open.push(result.memory);
  return result.memory;
}

function obs(over: Partial<NewObservation> & { title: string; narrative: string }): NewObservation {
  return { type: "discovery", facts: [], filesRead: [], filesModified: [], ...over };
}

function digest(sessionId: string, expected: Position | null, next: Position, over: Partial<DigestInput> = {}): DigestInput {
  return {
    session: { id: sessionId, agent: "claude", transcriptPath: `/t/${sessionId}.jsonl` },
    expected,
    next,
    model: "haiku",
    costUsd: 0.01,
    summary: { request: "r", investigated: "i", learned: "l", completed: "c", next_steps: "n" },
    observations: [],
    ...over,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("openMemory", () => {
  test("a fresh path opens for write, then for read", () => {
    const file = tmpFile();
    const w = openMemory(file, "write");
    expect(w.status).toBe("open");
    if (w.status === "open") w.memory.close();
    const r = openMemory(file, "read");
    expect(r.status).toBe("open");
    if (r.status === "open") r.memory.close();
    expect(memoryStatus(file)).toBe("open");
  });

  test("a missing path reads as missing and is not created", () => {
    const file = tmpFile();
    expect(openMemory(file, "read").status).toBe("missing");
    expect(memoryStatus(file)).toBe("missing");
    expect(fs.existsSync(file)).toBe(false);
  });

  test("a zero-byte file reads as missing", () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    expect(openMemory(file, "read").status).toBe("missing");
  });

  test("a text file is unreadable in both modes", () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "this is not a database, just some text bytes\n".repeat(50));
    expect(openMemory(file, "read").status).toBe("unreadable");
    expect(openMemory(file, "write").status).toBe("unreadable");
    expect(memoryStatus(file)).toBe("unreadable");
  });

  test("a database from a later schema version is newer in both modes", () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sqlite = process.getBuiltinModule("node:sqlite");
    const raw = new sqlite.DatabaseSync(file);
    raw.exec("PRAGMA user_version=2");
    raw.close();
    expect(openMemory(file, "read").status).toBe("newer");
    expect(openMemory(file, "write").status).toBe("newer");
  });

  test("a runtime without node:sqlite is unreadable", () => {
    const file = tmpFile();
    writable(file);
    const original = process.getBuiltinModule;
    process.getBuiltinModule = () => undefined;
    try {
      expect(openMemory(file, "write").status).toBe("unreadable");
      expect(openMemory(file, "read").status).toBe("unreadable");
    } finally {
      process.getBuiltinModule = original;
    }
  });

  test("search is a stub until it is built", () => {
    const memory = writable();
    expect(() => memory.search({ text: "x", vector: null, limit: 5, type: null, sinceMs: null, file: null }))
      .toThrow("search: not built");
  });
});

describe("appendDigest", () => {
  const P1 = { uuid: "u-1", timestamp: "2026-11-02T10:00:00.123Z" };
  const P2 = { uuid: "u-2", timestamp: "2026-11-02T10:05:00.456Z" };

  test("a stored digest reads back with the literal values it went in with", () => {
    const file = tmpFile();
    const memory = writable(file);
    const before = Date.now();
    const input = obs({
      type: "decision",
      title: "Lock → retry ünïcode \"quoted\"",
      narrative: "Line one\nline two 🙂",
      facts: ["fact, with comma", "[bracket]", ""],
      filesRead: ["src/ä b.ts"],
      filesModified: ["src/c.ts"],
    });
    expect(memory.appendDigest(digest("stem-1", null, P1, { observations: [input] }))).toBe("appended");
    const [line] = memory.recent(50);
    expect(line).toBeDefined();
    expect(line!.type).toBe("decision");
    expect(line!.title).toBe(input.title);
    expect(line!.createdAtMs).toBeGreaterThanOrEqual(before);
    expect(memory.get([line!.id])).toEqual([{
      ...line!,
      sessionId: "stem-1",
      narrative: input.narrative,
      facts: input.facts,
      filesRead: input.filesRead,
      filesModified: input.filesModified,
    }]);
    expect(memory.fileHistory("src/ä b.ts", 5)).toEqual([line!]);
    memory.close();
    open.length = 0;
    const r = openMemory(file, "read");
    if (r.status !== "open") throw new Error(r.status);
    expect(r.memory.get([line!.id])[0]!.facts).toEqual(input.facts);
    r.memory.close();
  });

  test("checks the expected position and writes nothing when stale", () => {
    const memory = writable();
    expect(memory.position("s")).toBeNull();
    expect(memory.appendDigest(digest("s", null, P1, { observations: [obs({ title: "a", narrative: "b" })] }))).toBe("appended");
    expect(memory.position("s")).toEqual(P1);
    const before = memory.recent(50);
    expect(memory.appendDigest(digest("s", null, P2, { observations: [obs({ title: "c", narrative: "d" })] }))).toBe("stale");
    expect(memory.recent(50)).toEqual(before);
    expect(memory.position("s")).toEqual(P1);
    expect(memory.appendDigest(digest("s", { uuid: "u-1", timestamp: "other" }, P2))).toBe("stale");
    expect(memory.appendDigest(digest("s", P1, P2))).toBe("appended");
    expect(memory.position("s")).toEqual(P2);
  });

  test("a throw mid-digest rolls back every row", () => {
    const memory = writable();
    memory.appendDigest(digest("s", null, P1, { observations: [obs({ title: "a", narrative: "b" })] }));
    const before = memory.recent(50);
    const bad = { ...obs({ title: "x", narrative: "y" }), type: "nope" } as unknown as NewObservation;
    expect(() => memory.appendDigest(digest("s", P1, P2, { observations: [obs({ title: "ok", narrative: "fine" }), bad] })))
      .toThrow();
    expect(memory.recent(50)).toEqual(before);
    expect(memory.position("s")).toEqual(P1);
    expect(memory.appendDigest(digest("s", P1, P2))).toBe("appended");
  });

  test("a path listed twice is stored once", () => {
    const memory = writable();
    const result = memory.appendDigest(digest("s", null, P1, {
      observations: [obs({ title: "t", narrative: "n", filesRead: ["src/a.ts", "src/a.ts"], filesModified: ["src/a.ts"] })],
    }));
    expect(result).toBe("appended");
    const [got] = memory.get([memory.recent(1)[0]!.id]);
    expect(got!.filesRead).toEqual(["src/a.ts"]);
    expect(got!.filesModified).toEqual(["src/a.ts"]);
  });

  test("an observation with the same normalized title and narrative adds no row", () => {
    const memory = writable();
    memory.appendDigest(digest("s", null, P1, {
      observations: [
        obs({ title: "Lock  Retry", narrative: "A", filesRead: ["src/a.ts"] }),
        obs({ title: "lock retry", narrative: "a", filesRead: ["src/dup.ts"] }),
        obs({ title: "Other", narrative: "B" }),
      ],
    }));
    expect(memory.recent(50).length).toBe(2);
    expect(memory.fileHistory("src/dup.ts", 5)).toEqual([]);
    expect(memory.appendDigest(digest("s", P1, P2, { observations: [obs({ title: " LOCK retry ", narrative: "a " })] }))).toBe("appended");
    expect(memory.recent(50).length).toBe(2);
  });
});

describe("recordRejection", () => {
  test("counts up from the first rejection and resets on a stored digest", () => {
    const memory = writable();
    const key = { id: "s", agent: "claude" as const, transcriptPath: "/t/s.jsonl" };
    expect(memory.recordRejection(key)).toBe(1);
    expect(memory.recordRejection(key)).toBe(2);
    expect(memory.recordRejection(key)).toBe(3);
    expect(memory.position("s")).toBeNull();
    expect(memory.appendDigest(digest("s", null, { uuid: "u", timestamp: "t" }))).toBe("appended");
    expect(memory.recordRejection(key)).toBe(1);
  });
});

describe("read methods", () => {
  test("match the table on a seeded store", async () => {
    const memory = writable();
    expect(memory.latestNextSteps()).toBeNull();
    expect(memory.stats("m1", 0)).toEqual({ observations: 0, unembedded: 0, lastDigestMs: null, costUsdSince: 0 });
    const n1 = { uuid: "a", timestamp: "2026-11-02T10:00:00.000Z" };
    const summary = (next_steps: string) => ({ request: "r", investigated: "i", learned: "l", completed: "c", next_steps });
    memory.appendDigest(digest("s1", null, n1, {
      costUsd: 0.01, summary: summary("None."),
      observations: [obs({ type: "bugfix", title: "T1", narrative: "N1", facts: ["f1"], filesRead: ["src/a.ts"] })],
    }));
    expect(memory.latestNextSteps()).toBeNull();
    await sleep(2);
    const t2 = Date.now();
    const d2 = { request: "R2", investigated: "I2", learned: "L2", completed: "C2", next_steps: " none " };
    memory.appendDigest(digest("s1", n1, { uuid: "b", timestamp: "2026-11-02T10:01:00.000Z" }, {
      costUsd: 0.02, summary: d2,
      observations: [obs({ type: "feature", title: "T2", narrative: "N2", filesRead: ["src/a.ts"], filesModified: ["src/a.ts"] })],
    }));
    expect(memory.latestNextSteps()).toBeNull();
    await sleep(2);
    const t3 = Date.now();
    memory.appendDigest(digest("s2", null, { uuid: "c", timestamp: "2026-11-02T10:02:00.000Z" }, {
      costUsd: 0.04, summary: summary("Ship it."),
      observations: [
        obs({ type: "change", title: "T3", narrative: "N3", filesModified: ["src/b.ts"] }),
        obs({ type: "decision", title: "T4", narrative: "N4" }),
      ],
    }));
    expect(memory.latestNextSteps()).toBe("Ship it.");

    const ids = (rows: { id: number }[] | null) => rows?.map((r) => r.id) ?? null;
    expect(ids(memory.recent(3))).toEqual([4, 3, 2]);
    expect(ids(memory.timeline(2, 1))).toEqual([1, 2, 3]);
    expect(ids(memory.timeline(4, 5))).toEqual([1, 2, 3, 4]);
    expect(memory.timeline(99, 1)).toBeNull();
    expect(ids(memory.get([3, 99, 1]))).toEqual([3, 1]);
    expect(memory.get([1])[0]).toMatchObject({ sessionId: "s1", facts: ["f1"], filesRead: ["src/a.ts"], filesModified: [] });
    expect(ids(memory.fileHistory("src/a.ts", 5))).toEqual([2, 1]);
    expect(ids(memory.fileHistory("src/a.ts", 1))).toEqual([2]);
    expect(memory.latestSummary("s1")).toEqual(d2);
    expect(memory.latestSummary("zz")).toBeNull();

    const stats = memory.stats("m1", t2);
    expect(stats.observations).toBe(4);
    expect(stats.unembedded).toBe(4);
    expect(stats.lastDigestMs!).toBeGreaterThanOrEqual(t3);
    expect(Math.abs(stats.costUsdSince - 0.06)).toBeLessThan(1e-9);

    const pending = memory.unembedded("m1", 10);
    expect(ids(pending)).toEqual([1, 2, 3, 4]);
    expect(pending[0]!.text).toBe("T1\nN1");
    const vector = new Float32Array([0.1, -2.5e-8, 3.4e38, Number.NaN]);
    memory.putVectors("m1", [{ id: 1, vector }]);
    expect(ids(memory.unembedded("m1", 10))).toEqual([2, 3, 4]);
    expect(memory.stats("m1", t2).unembedded).toBe(3);
    memory.putVectors("m2", [{ id: 1, vector }]);
    expect(ids(memory.unembedded("m1", 10))).toEqual([1, 2, 3, 4]);
    expect(ids(memory.unembedded("m2", 10))).toEqual([2, 3, 4]);
  });
});

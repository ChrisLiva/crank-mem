import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { EMBED_MODEL } from "../src/daemon/embedder.ts";
import { LOCAL_CONFIG_FILE } from "../src/hooks/lib/config.ts";
import { RECALL_BULLET } from "../src/hooks/lib/injection.ts";
import { MEMORY_OLDER_NOTE, memoryPath } from "../src/hooks/lib/memory.ts";
import {
  appendRecords, cleanup, digestProject, journey, laterRecords, makeCrankHome, makeCrankProject, plantMemory, rerun, runCli,
  runHook, seedMemory, stop, temps,
} from "./helpers.ts";
import { okStream, okStreamOf } from "./fixtures/claude-scenarios.ts";
import { SAMPLE_DIGEST } from "./fixtures/digest-output.ts";
import { claudePostRead, claudeSessionStart, claudeSubagentStart } from "./fixtures/payloads.ts";
import { V1_DDL } from "./fixtures/schema-v1.ts";

afterEach(cleanup);

const UTC = { TZ: "UTC" };
const MIGRATED_LINE = "  migrated memory.db v1 → v2";

/** A project with digests on in config.local.json and the files the version-1 rows cite. */
function project(): string {
  const root = makeCrankProject({ "src/lock.ts": "export const LOCK_RETRY_MS = 2000;\n", "src/scan.ts": "export {};\n" });
  temps.push(root);
  fs.writeFileSync(path.join(root, ".crank", LOCAL_CONFIG_FILE), JSON.stringify({ digest: true }));
  return root;
}

/** Writes .crank/memory.db from the frozen version-1 schema, in WAL mode, with two observations. */
function writeV1Store(root: string): void {
  const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite;
  const db = new mod.DatabaseSync(memoryPath(root));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(V1_DDL);
  db.exec("PRAGMA user_version = 1");
  db.prepare("INSERT INTO sessions (id, agent, transcript_path) VALUES (?, ?, ?)")
    .run("v1-session", "claude", "/t/v1-session.jsonl");
  db.prepare(
    `INSERT INTO digests (id, session_id, created_at, model, cost_usd, request, investigated, learned, completed, next_steps)
     VALUES (1, 'v1-session', 1767441600000, 'haiku', 0.01, 'r', 'i', 'l', 'c', 'n')`,
  ).run();
  const observation = db.prepare(
    `INSERT INTO observations (id, digest_id, type, title, narrative, facts, content_hash, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
  );
  observation.run(
    1, "discovery", "Lock retry is two seconds", "withLock retries EEXIST for two seconds.",
    JSON.stringify(["LOCK_RETRY_MS is 2000"]), "v1-hash-1", 1767355200000,
  );
  observation.run(
    2, "bugfix", "Scanner skips symlinks", "walkProject no longer follows symlinked directories.",
    JSON.stringify([]), "v1-hash-2", 1767441600000,
  );
  const file = db.prepare("INSERT INTO observation_files (path, observation_id, kind) VALUES (?, ?, ?)");
  file.run("src/lock.ts", 1, "read");
  file.run("src/scan.ts", 2, "modified");
  const unit = new Float32Array(384);
  unit[0] = 1;
  db.prepare("INSERT INTO observation_vectors (observation_id, model, vector) VALUES (1, ?, ?)")
    .run(EMBED_MODEL, new Uint8Array(unit.buffer));
  db.close();
}

function snapshots(root: string): string[] {
  return fs.readdirSync(path.join(root, ".crank/backups/memory"));
}

describe("migration", () => {
  test("upgrade migrates a version-1 store and keeps every row, field and vector", () => {
    const root = project();
    writeV1Store(root);

    const up = runCli(root, ["upgrade"]);
    expect(up.status).toBe(0);
    expect(up.stdout.split("\n")).toContain(MIGRATED_LINE);

    expect(runCli(root, ["get", "1", "2"], UTC).stdout).toBe(
      "#1 2026-01-02 discovery Lock retry is two seconds\n" +
      "session: v1-session\n" +
      "narrative: withLock retries EEXIST for two seconds.\n" +
      "facts:\n" +
      "- LOCK_RETRY_MS is 2000\n" +
      "files read: src/lock.ts\n" +
      "files modified: (none)\n" +
      "\n" +
      "#2 2026-01-03 bugfix Scanner skips symlinks\n" +
      "session: v1-session\n" +
      "narrative: walkProject no longer follows symlinked directories.\n" +
      "facts: (none)\n" +
      "files read: (none)\n" +
      "files modified: src/scan.ts\n",
    );
    expect(runCli(root, ["timeline", "1"], UTC).stdout).toBe(
      "#1 2026-01-02 discovery Lock retry is two seconds\n#2 2026-01-03 bugfix Scanner skips symlinks\n",
    );
    expect(runCli(root, ["search", "symlinks", "--type", "bugfix"], UTC).stdout).toBe(
      "#2 2026-01-03 bugfix Scanner skips symlinks\n",
    );
    const stats = runCli(root, ["stats"]).stdout.split("\n");
    expect(stats).toContain("  observations:     2");
    expect(stats).toContain("  unembedded:       1");
  });

  test("a failed pre-migration snapshot leaves the store at version 1", () => {
    const root = project();
    writeV1Store(root);
    const backups = path.join(root, ".crank/backups");
    fs.mkdirSync(backups);
    fs.chmodSync(backups, 0o555);
    try {
      const up = runCli(root, ["upgrade"]);
      expect(up.status).toBe(0);
      expect(up.stderr).toContain("crank-mem: could not migrate memory.db (");

      const search = runCli(root, ["search", "lock"]);
      expect(search.status).toBe(1);
      expect(search.stderr).toBe(MEMORY_OLDER_NOTE + "\n");

      const j = journey(root, [{ lines: okStream(SAMPLE_DIGEST) }]);
      expect(j.job.status).toBe(1);
      expect(j.fake.calls()).toEqual([]);
    } finally {
      fs.chmodSync(backups, 0o755);
    }
  });

  test("upgrade runs the store step at any version and never creates a store", () => {
    const root = project();
    writeV1Store(root);
    expect(runCli(root, ["upgrade"]).stdout).toContain(MIGRATED_LINE);
    const again = runCli(root, ["upgrade"]);
    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain("migrated memory.db");
    expect(snapshots(root)).toHaveLength(1);

    const empty = project();
    expect(runCli(empty, ["upgrade"]).status).toBe(0);
    expect(fs.existsSync(memoryPath(empty))).toBe(false);

    const broken = project();
    plantMemory(broken, "unreadable");
    const up = runCli(broken, ["upgrade"]);
    expect(up.status).toBe(0);
    expect(up.stderr).toContain("crank-mem: could not migrate memory.db (unreadable)");
  });
});

describe("older stores", () => {
  test("a version-1 store reads as older everywhere", () => {
    const root = project();
    writeV1Store(root);
    const home = makeCrankHome();
    temps.push(home);
    const env = { CRANK_HOME: home };

    const start = runHook("src/hooks/session-start.ts", JSON.stringify(claudeSessionStart(root)), root, env);
    expect(start.status).toBe(0);
    const ctx: string = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
    expect(ctx.split("\n")).toContain(`_Note: ${MEMORY_OLDER_NOTE}_`);
    expect(ctx).not.toContain("## Recent memory");
    expect(ctx).not.toContain(RECALL_BULLET);

    for (const args of [["search", "lock"], ["timeline", "1"], ["get", "1"]]) {
      const r = runCli(root, args);
      expect(r.status).toBe(1);
      expect(r.stderr).toBe(MEMORY_OLDER_NOTE + "\n");
    }

    const read = runHook(
      "src/hooks/post-read.ts", JSON.stringify(claudePostRead(root, path.join(root, "src/lock.ts"), "/t/s.jsonl")), root, env,
    );
    expect(read.status).toBe(0);
    expect(read.stdout).toBe("");

    expect(runCli(root, ["stats"]).stdout.split("\n"))
      .toContain("  memory:           older than this version; run crank-mem upgrade");

    const sub = runHook("src/hooks/subagent-start.ts", JSON.stringify(claudeSubagentStart(root)), root, env);
    expect(sub.status).toBe(0);
    expect(sub.stdout).not.toContain(RECALL_BULLET);
  });
});

describe("maintenance", () => {
  const DAILY = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;
  const records = (tag: string) => laterRecords(tag).records;
  const staleSearch = (root: string) => runCli(root, ["search", "Retention", "--stale"]).stdout;

  /** A digest project whose cerebrum.md is gone, so consolidation makes no model call. */
  function maintained(): string {
    const root = digestProject({}, temps);
    fs.rmSync(path.join(root, ".crank/cerebrum.md"));
    return root;
  }

  function backups(root: string): string {
    return path.join(root, ".crank/backups/memory");
  }

  /** Seeds rows A and B, then flags A stale and adds one pending proposal. */
  function seedRetention(root: string): { a: number; b: number } {
    const [a, b] = seedMemory(root, [{ title: "Retention canary alpha" }, { title: "Retention canary bravo" }]) as [number, number];
    seedMemory(root, [], {
      stale: [{ id: a, reason: "replaced" }],
      proposals: [{ kind: "memory", bullet: "**Keep**: proposals survive retention" }],
    });
    return { a, b };
  }

  test("the pass waits a day, snapshots before it deletes, and deletes only long-stale rows", () => {
    const root = maintained();
    const j = journey(root, [{ lines: okStream(SAMPLE_DIGEST) }]);
    expect(j.job.status).toBe(0);
    expect(snapshots(root)).toHaveLength(1);
    expect(snapshots(root)[0]).toMatch(DAILY);
    expect(runCli(root, ["stats"]).stdout).toMatch(/\n  last snapshot:    \d+s ago\n  embedder: /);

    const { a, b } = seedRetention(root);

    // Job 2: not due, so the flagged row survives a 1 ms keep window.
    appendRecords(j.transcript, records("r2"));
    stop(j);
    expect(rerun(j, 10_000, {}, ["--stale-keep-ms", "1"]).status).toBe(0);
    expect(snapshots(root)).toHaveLength(1);
    expect(staleSearch(root)).toContain(`#${a} `);

    // Job 3: due, so it snapshots, then deletes A and nothing else.
    appendRecords(j.transcript, records("r3"));
    stop(j);
    expect(rerun(j, 10_000, {}, ["--maintain-every-ms", "1", "--stale-keep-ms", "1"]).status).toBe(0);
    const names = snapshots(root);
    expect(names).toHaveLength(2);
    expect(names.every((n) => DAILY.test(n))).toBe(true);
    const after = staleSearch(root);
    expect(after).toContain(`#${b} `);
    expect(after).toContain("Retention canary bravo");
    expect(after).not.toContain(`#${a} `);
    expect(runCli(root, ["get", String(a)]).status).toBe(1);
    expect(runCli(root, ["stats"]).stdout.split("\n")).toContain("  proposals:        1");

    // Job 4: the session's digests and position survived, so the next digest continues from r3.
    appendRecords(j.transcript, records("r4"));
    stop(j);
    expect(rerun(j).status).toBe(0);
    const last = j.fake.calls().at(-1)!.stdin;
    expect(last.startsWith("[PRIOR SUMMARY]\n")).toBe(true);
    expect(last).toContain("r4 r4");
    expect(last).not.toContain("r3 r3");
  });

  test("the trim keeps the newest 7 daily snapshots and every -v1.db, and removes stray temp files", () => {
    const root = maintained();
    const dir = backups(root);
    fs.mkdirSync(dir, { recursive: true });
    const days = [1, 2, 3, 4, 5, 6, 7].map((d) => `2026-01-0${d}T00-00-00-000Z.db`);
    for (const name of [...days, "2026-01-01T00-00-00-000Z-v1.db", "memory.db.123.1.tmp"]) {
      fs.writeFileSync(path.join(dir, name), "");
    }

    expect(journey(root, [{ lines: okStream(SAMPLE_DIGEST) }], { args: ["--maintain-every-ms", "1"] }).job.status).toBe(0);
    const names = snapshots(root).sort();
    expect(names.slice(0, -1)).toEqual(["2026-01-01T00-00-00-000Z-v1.db", ...days.slice(1)]);
    expect(names).toHaveLength(8);
    expect(names.at(-1)).toMatch(DAILY);
    expect(names.at(-1)! > days.at(-1)!).toBe(true);
  });

  test("a failed snapshot deletes nothing, consolidation still runs, and the next job tries again", () => {
    const root = digestProject({}, temps);
    fs.mkdirSync(path.join(root, ".crank/backups"), { recursive: true });
    fs.writeFileSync(backups(root), "x");
    const { a } = seedRetention(root);

    const j = journey(
      root,
      [
        { lines: okStream(SAMPLE_DIGEST) },
        { lines: okStreamOf({ edits: [], proposals: [], stale: [] }) },
        { lines: okStream(SAMPLE_DIGEST) },
      ],
      { args: ["--stale-keep-ms", "1"] },
    );
    expect(j.job.status).toBe(0);
    expect(j.job.stderr.split("\n").filter((l) => l.startsWith("crank-mem: maintenance skipped ("))).toHaveLength(1);
    expect(staleSearch(root)).toContain(`#${a} `);
    expect(j.fake.calls().length).toBe(2);
    expect(runCli(root, ["stats"]).stdout).toMatch(/^  consolidation:    \d+s ago \(ok\)$/m);

    fs.rmSync(backups(root));
    appendRecords(j.transcript, records("r2"));
    stop(j);
    expect(rerun(j, 10_000, {}, ["--stale-keep-ms", "1"]).status).toBe(0);
    const names = snapshots(root);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(DAILY);
    expect(staleSearch(root)).not.toContain(`#${a} `);
  });

  test("the due check counts a -v1.db snapshot and skips a .tmp file", () => {
    const planted = (name: string): string => {
      const root = maintained();
      fs.mkdirSync(backups(root), { recursive: true });
      fs.writeFileSync(path.join(backups(root), name), "");
      expect(journey(root, [{ lines: okStream(SAMPLE_DIGEST) }]).job.status).toBe(0);
      return root;
    };

    expect(snapshots(planted("2026-01-01T00-00-00-000Z-v1.db"))).toEqual(["2026-01-01T00-00-00-000Z-v1.db"]);

    const names = snapshots(planted("memory.db.1.1.tmp"));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(DAILY);
  });
});

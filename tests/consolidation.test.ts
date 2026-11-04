import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { consolidationRequest } from "../src/daemon/consolidate.ts";
import { isSensitiveFile } from "../src/hooks/lib/config.ts";
import {
  TOKEN, appendRecords, cleanup, digestProject, git, gitCommit, journey, laterRecords, readRecord, rerun, runCli, search, seedMemory,
  setMtime, stop, temps, userRecord,
} from "./helpers.ts";
import { okStreamOf } from "./fixtures/claude-scenarios.ts";
import { SAMPLE_DIGEST } from "./fixtures/digest-output.ts";

afterEach(cleanup);

const CEREBRUM = "# Cerebrum\n\n## User Preferences\n\n## Memory\n\n" +
  "- **Lock retry**: `src/lock.ts` → `withLock` retries EEXIST for 2 seconds (2026-10-01)\n" +
  "- **Scanner**: `src/scan.ts` → `walk` skips symlinks (2026-10-01)\n";

/** The consolidation call's deny rules: the sensitive-file filter as `Read(<glob>)`, in the probed order (ADR 0011). */
const DENY_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  permissions: {
    deny: [
      "**/.npmrc", "**/.netrc", "**/.htpasswd", "**/.pgpass",
      "**/*.pem", "**/*.key", "**/*.p8", "**/*.p12", "**/*.pfx", "**/*.keystore", "**/*.jks", "**/*.ppk", "**/*.kdbx", "**/*.tfstate",
      "**/.env", "**/.env.*", "**/id_rsa*", "**/id_dsa*", "**/id_ecdsa*", "**/id_ed25519*", "**/*credential*",
      "**/secrets.json", "**/secrets.yaml", "**/secrets.yml", "**/secrets.toml",
    ].map((g) => `Read(${g})`),
  },
});

/** The names `tests/config.test.ts` → describe `isSensitiveFile` checks, plus two near misses. */
const FILTER_NAMES = [
  ".env", ".env.local", "server.pem", "id_rsa", "id_ed25519.pub", "aws-credentials.json", "secrets.yaml", ".npmrc", "app.key",
  "terraform.tfstate", "index.ts", "README.md", "environment.ts", "keyboard.ts", "id_token.ts", "secrets.txt",
];

const digestOf = (proposals: { kind: string; bullet: string }[], stale: { id: number; reason: string }[] = []) =>
  ({ observations: [], summary: SAMPLE_DIGEST.summary, proposals, stale });

/** The value after `flag` in a recorded argv. */
const flagValue = (argv: string[], flag: string): string => argv[argv.indexOf(flag) + 1]!;

describe("digest feeds consolidation", () => {
  test("the first job stores a proposal and a flag that its consolidation reviews, and later jobs consolidate only when due", () => {
    const root = digestProject({ git: "commit" }, temps);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/lock.ts"), "export const LOCK_RETRY_MS = 5000;\n");
    fs.writeFileSync(path.join(root, "src/scan.ts"), "export function walk() {}\n");
    fs.writeFileSync(path.join(root, ".crank/cerebrum.md"), CEREBRUM);
    git(root, "init", "-q");
    gitCommit(root, "init");
    const [a, b] = seedMemory(root, [
      { title: "Lock retry is two seconds", narrative: "withLock retries EEXIST for 2 seconds.", filesRead: ["src/lock.ts"] },
      { title: "Lock writes are atomic", narrative: "The index is written to a temp file and renamed.", filesRead: ["src/lock.ts"] },
    ]);
    const transcript = [
      userRecord("c-0", "2026-01-02T00:00:00.000Z", "change the lock retry window ".repeat(80)),
      readRecord("c-1", "2026-01-02T00:00:01.000Z", path.join(root, "src/lock.ts")),
    ].join("\n") + "\n";
    const output = digestOf(
      [
        { kind: "memory", bullet: "**Lock constant**: `src/lock.ts` → `LOCK_RETRY_MS` holds the retry window (2026-11-01)" },
        { kind: "memory", bullet: "   " },
      ],
      [{ id: a!, reason: "the session changed  the retry to 5 s; token " + TOKEN }, { id: 999, reason: "unlisted" }],
    );
    const consolidation1 = okStreamOf({
      edits: [
        { op: "add", heading: "Memory", bullet: "**Lock constant**: `src/lock.ts` → `LOCK_RETRY_MS` holds the retry window", proposal: 1 },
        { op: "replace", bullet_id: 2 },
        { op: "add", heading: "Memory", bullet: "**X**", proposal: 77 },
      ],
      proposals: [{ id: 1, verdict: "accepted", reason: "LOCK_RETRY_MS exists" }],
      stale: [{ id: a, verdict: "confirmed" }],
    });
    const scenarios = [
      { lines: okStreamOf(output) },
      { lines: consolidation1 },
      { lines: okStreamOf(digestOf([{ kind: "memory", bullet: "**Scan depth**: `src/scan.ts` → `walk` stops at 8 levels" }])) },
      { lines: okStreamOf(digestOf([])) },
      { lines: okStreamOf({ edits: [], proposals: [{ id: 2, verdict: "rejected", reason: "already said" }], stale: [] }) },
      { lines: okStreamOf(digestOf([])) },
      {
        lines: okStreamOf(digestOf(
          [
            { kind: "memory", bullet: "**Lock constant**: `src/lock.ts` → `LOCK_RETRY_MS` holds the retry window (2026-11-04)" },
            { kind: "memory", bullet: "**Token rule**: never log " + TOKEN },
          ],
          [{ id: b!, reason: "first reason" }, { id: b!, reason: "second reason" }, { id: 999, reason: "unlisted" }],
        )),
      },
      {
        lines: okStreamOf({
          edits: [
            { op: "replace", bullet_id: 1, bullet: "**Lock retry**: `src/lock.ts` → `withLock` retries EEXIST for 5 seconds", reason: "retry is 5 s now" },
            { op: "remove", bullet_id: 2, reason: "scanner rewritten" },
            { op: "remove", bullet_id: 42, reason: "unknown" },
          ],
          proposals: [],
          stale: [{ id: b, verdict: "cleared" }, { id: a, verdict: "cleared" }],
        }),
      },
    ];
    const j = journey(root, scenarios, { transcript, env: { TZ: "UTC" } });
    const { home, fake, job } = j;

    const stdin = fake.calls()[0]!.stdin;
    expect(stdin).toContain("[CEREBRUM]\n## User Preferences\n\n## Memory\n\n- **Lock retry**");
    const lineB = stdin.indexOf(`\n#${b} discovery Lock writes are atomic: The index is written to a temp file and renamed.\n`);
    const lineA = stdin.indexOf(`\n#${a} discovery Lock retry is two seconds: withLock retries EEXIST for 2 seconds.\n`);
    expect(lineB).toBeGreaterThan(-1);
    expect(lineA).toBeGreaterThan(lineB);
    expect(stdin).toContain("\n\n[TRANSCRIPT]\n");
    expect(job.status).toBe(0);

    expect(search(root, "Lock retry")).not.toContain(`#${a} `);
    const withStale = runCli(root, ["search", "Lock retry", "--stale"]);
    expect(withStale.status).toBe(0);
    expect(withStale.stdout).toMatch(new RegExp(`^#${a} \\S+ discovery \\[stale\\] Lock retry is two seconds$`, "m"));
    const got = runCli(root, ["get", String(a)]);
    expect(got.status).toBe(0);
    const staleLine = got.stdout.split("\n")[2]!;
    expect(staleLine.startsWith("stale: ")).toBe(true);
    expect(staleLine).toContain("[redacted]");
    expect(got.stdout).not.toContain(TOKEN);
    const stats = runCli(root, ["stats"], { CRANK_HOME: home }).stdout;
    expect(stats).toContain("\n  proposals:        0\n");
    expect(stats).toContain("\n  stale:            1\n");
    expect(stats).toMatch(/^  consolidation:    \d+s ago \(ok\)$/m);

    // Step 1's consolidation: the project's read-only tools, its deny rules and cwd, and the same env.
    const calls = fake.calls();
    expect(calls.length).toBe(2);
    const [digestCall, call] = [calls[0]!, calls[1]!];
    const req = consolidationRequest("", { proposals: [], stale: [] });
    const swapped: Record<string, string> = {
      "--tools": "Read,Grep,Glob", "--max-turns": "40", "--settings": DENY_SETTINGS,
      "--system-prompt": req.system, "--json-schema": JSON.stringify(req.schema),
    };
    expect(call.argv).toEqual(digestCall.argv.map((arg, i) => swapped[digestCall.argv[i - 1]!] ?? arg));
    expect(call.cwd).toBe(fs.realpathSync(root));
    expect(call.env).toEqual(digestCall.env);
    expect(call.stdin).toBe(
      "[CEREBRUM]\n## User Preferences\n## Memory\n" +
      "[B1] **Lock retry**: `src/lock.ts` → `withLock` retries EEXIST for 2 seconds (2026-10-01)\n" +
      "[B2] **Scanner**: `src/scan.ts` → `walk` skips symlinks (2026-10-01)\n\n" +
      "[PROPOSALS]\n[P1] (memory) **Lock constant**: `src/lock.ts` → `LOCK_RETRY_MS` holds the retry window (2026-11-01)\n\n" +
      `[STALE]\n[O${a}] Lock retry is two seconds: withLock retries EEXIST for 2 seconds. | flagged: the session changed the retry to 5 s; token [redacted]\n`,
    );
    const today = new Date().toISOString().slice(0, 10);
    const cerebrum = path.join(root, ".crank/cerebrum.md");
    const scanner = "- **Scanner**: `src/scan.ts` → `walk` skips symlinks (2026-10-01)\n";
    const afterStep1 = CEREBRUM.replace(
      scanner, `${scanner}- **Lock constant**: \`src/lock.ts\` → \`LOCK_RETRY_MS\` holds the retry window (${today})\n`,
    );
    expect(fs.readFileSync(cerebrum, "utf8")).toBe(afterStep1);
    const backups = path.join(root, ".crank/backups/cerebrum");
    const backupFiles = () => fs.readdirSync(backups);
    expect(backupFiles().length).toBe(1);
    expect(fs.readFileSync(path.join(backups, backupFiles()[0]!), "utf8")).toBe(CEREBRUM);
    expect(fs.existsSync(path.join(root, ".crank/cerebrum-archive.md"))).toBe(false);

    // The deny rules match the sensitive-file filter.
    const deny: string[] = JSON.parse(flagValue(call.argv, "--settings")).permissions.deny;
    const globs = deny.map((rule) => /^Read\((?<glob>.+)\)$/.exec(rule)!.groups!.glob!);
    for (const name of FILTER_NAMES) {
      expect([name, globs.some((g) => path.matchesGlob("src/" + name, g))]).toEqual([name, isSensitiveFile(name)]);
    }

    // Step 2: inside the 2-hour window, only the digest runs.
    const statsOf = () => runCli(root, ["stats"], { CRANK_HOME: home }).stdout;
    appendRecords(j.transcript, laterRecords("s2").records);
    stop(j);
    expect(rerun(j).status).toBe(0);
    expect(fake.calls().length).toBe(3);
    expect(statsOf()).toContain("\n  proposals:        1\n");

    // Step 3: a 1 ms window runs both calls, and a consolidation that applies no edit writes nothing.
    appendRecords(j.transcript, laterRecords("s3").records);
    stop(j);
    expect(rerun(j, 10_000, {}, ["--consolidate-every-ms", "1"]).status).toBe(0);
    expect(fake.calls().length).toBe(5);
    expect(statsOf()).toContain("\n  proposals:        0\n");
    expect(fs.readFileSync(cerebrum, "utf8")).toBe(afterStep1);
    expect(backupFiles().length).toBe(1);

    // Step 3b: nothing waits, so only the digest runs.
    appendRecords(j.transcript, laterRecords("s3b").records);
    stop(j);
    expect(rerun(j, 10_000, {}, ["--consolidate-every-ms", "1"]).status).toBe(0);
    expect(fake.calls().length).toBe(6);

    // Step 4: a scan sees src/lock.ts changed after the last ok run, so the bullets citing it are re-checked.
    setMtime(path.join(root, "src/lock.ts"), Date.now());
    setMtime(path.join(root, "src/scan.ts"), Date.parse("2026-01-01"));
    expect(runCli(root, ["scan"]).status).toBe(0);
    appendRecords(j.transcript, [
      ...laterRecords("s4").records, readRecord("s4-read", "2026-01-03T00:00:03.000Z", path.join(root, "src/lock.ts")),
    ]);
    stop(j);
    expect(rerun(j, 10_000, { TZ: "UTC" }, ["--consolidate-every-ms", "1"]).status).toBe(0);
    expect(fake.calls().length).toBe(8);
    const step4 = fake.calls()[7]!.stdin;
    expect(step4.split("\n").filter((l) => l.startsWith("[B"))).toEqual([
      "[B1] RECHECK **Lock retry**: `src/lock.ts` → `withLock` retries EEXIST for 2 seconds (2026-10-01)",
      "[B2] **Scanner**: `src/scan.ts` → `walk` skips symlinks (2026-10-01)",
      `[B3] RECHECK **Lock constant**: \`src/lock.ts\` → \`LOCK_RETRY_MS\` holds the retry window (${today})`,
    ]);
    expect(step4).toContain("\n\n[PROPOSALS]\n[P3] (memory) **Token rule**: never log [redacted]\n\n[STALE]\n");
    const staleLines = step4.slice(step4.indexOf("[STALE]\n")).split("\n").filter((l) => l.startsWith("[O"));
    expect(staleLines.length).toBe(1);
    expect(staleLines[0]!.startsWith(`[O${b}] `)).toBe(true);
    expect(staleLines[0]!.endsWith("| flagged: first reason")).toBe(true);

    const step4Stats = statsOf();
    expect(step4Stats).toContain("\n  proposals:        1\n");
    expect(step4Stats).toContain("\n  stale:            1\n");
    expect(search(root, "Lock writes")).toContain(`#${b} `);
    expect(search(root, "Lock retry")).not.toContain(`#${a} `);
    expect(fs.readFileSync(path.join(root, ".crank/cerebrum-archive.md"), "utf8")).toBe(
      "# Cerebrum archive\n\n" +
      "- **Lock retry**: `src/lock.ts` → `withLock` retries EEXIST for 2 seconds (2026-10-01)\n" +
      `  - archived ${today}: retry is 5 s now\n` +
      "- **Scanner**: `src/scan.ts` → `walk` skips symlinks (2026-10-01)\n" +
      `  - archived ${today}: scanner rewritten\n`,
    );
    const memoryBullets = fs.readFileSync(cerebrum, "utf8").split("## Memory\n")[1]!.split("\n").filter((l) => l.startsWith("- "));
    expect(memoryBullets).toEqual([
      `- **Lock retry**: \`src/lock.ts\` → \`withLock\` retries EEXIST for 5 seconds (${today})`,
      `- **Lock constant**: \`src/lock.ts\` → \`LOCK_RETRY_MS\` holds the retry window (${today})`,
    ]);
    expect(git(root, "status", "--short", "--", ".crank/cerebrum.md")).toBe(" M .crank/cerebrum.md\n");
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");
    expect(git(root, "rev-list", "--count", "HEAD")).toBe("1\n");
  }, 90_000);
});

describe("bullets whose cited files changed", () => {
  test("before any ok run, the bullet's own date decides, and a due bullet alone triggers the run", () => {
    const root = digestProject({}, temps);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
    expect(runCli(root, ["scan"]).status).toBe(0);
    fs.writeFileSync(path.join(root, ".crank/cerebrum.md"), "# Cerebrum\n\n## User Preferences\n\n## Memory\n\n" +
      "- **A**: `src/a.ts` → `a` holds one (2026-01-01)\n" +
      "- **Gone**: `src/gone.ts` → `g` was removed (2026-11-04)\n");
    const transcript = userRecord("c-0", "2026-01-02T00:00:00.000Z", "check the a module ".repeat(120)) + "\n";
    const scenarios = [
      { lines: okStreamOf(digestOf([])) },
      { lines: okStreamOf({ edits: [], proposals: [], stale: [] }) },
    ];
    const { fake, job } = journey(root, scenarios, { transcript });
    expect(job.status).toBe(0);
    const calls = fake.calls();
    expect(calls.length).toBe(2);
    expect(calls[1]!.stdin).toBe(
      "[CEREBRUM]\n## User Preferences\n## Memory\n" +
      "[B1] RECHECK **A**: `src/a.ts` → `a` holds one (2026-01-01)\n" +
      "[B2] RECHECK **Gone**: `src/gone.ts` → `g` was removed (2026-11-04)\n",
    );
  }, 30_000);
});

describe("an accepted verdict with no edit", () => {
  test("is recorded decided and leaves cerebrum.md untouched", () => {
    const root = digestProject({}, temps);
    const cerebrum = path.join(root, ".crank/cerebrum.md");
    fs.writeFileSync(cerebrum, CEREBRUM);
    const transcript = userRecord("c-0", "2026-01-02T00:00:00.000Z", "change the lock retry window ".repeat(80)) + "\n";
    const scenarios = [
      { lines: okStreamOf(digestOf([{ kind: "memory", bullet: "**Lock retry**: `src/lock.ts` → `withLock` retries EEXIST" }])) },
      { lines: okStreamOf({ edits: [], proposals: [{ id: 1, verdict: "accepted", reason: "already covered" }], stale: [] }) },
    ];
    const { home, fake, job } = journey(root, scenarios, { transcript });
    expect(job.status).toBe(0);
    expect(fake.calls().length).toBe(2);
    expect(runCli(root, ["stats"], { CRANK_HOME: home }).stdout).toContain("\n  proposals:        0\n");
    expect(fs.readFileSync(cerebrum, "utf8")).toBe(CEREBRUM);
    expect(fs.existsSync(path.join(root, ".crank/backups/cerebrum"))
      ? fs.readdirSync(path.join(root, ".crank/backups/cerebrum")) : []).toEqual([]);
  }, 30_000);
});

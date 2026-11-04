import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TOKEN, cleanup, digestProject, journey, readRecord, runCli, search, seedMemory, temps, userRecord } from "./helpers.ts";
import { okStreamOf } from "./fixtures/claude-scenarios.ts";
import { SAMPLE_DIGEST } from "./fixtures/digest-output.ts";

afterEach(cleanup);

const CEREBRUM = "# Cerebrum\n\n## User Preferences\n\n## Memory\n\n" +
  "- **Lock retry**: `src/lock.ts` → `withLock` retries EEXIST for 2 seconds (2026-10-01)\n" +
  "- **Scanner**: `src/scan.ts` → `walk` skips symlinks (2026-10-01)\n";

describe("digest feeds consolidation", () => {
  test("the first job sees cerebrum and the file's history, and stores its proposal and its flag on a shown row", () => {
    const root = digestProject({}, temps);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/lock.ts"), "export const LOCK_RETRY_MS = 5000;\n");
    fs.writeFileSync(path.join(root, ".crank/cerebrum.md"), CEREBRUM);
    const [a, b] = seedMemory(root, [
      { title: "Lock retry is two seconds", narrative: "withLock retries EEXIST for 2 seconds.", filesRead: ["src/lock.ts"] },
      { title: "Lock writes are atomic", narrative: "The index is written to a temp file and renamed.", filesRead: ["src/lock.ts"] },
    ]);
    const transcript = [
      userRecord("c-0", "2026-01-02T00:00:00.000Z", "change the lock retry window ".repeat(80)),
      readRecord("c-1", "2026-01-02T00:00:01.000Z", path.join(root, "src/lock.ts")),
    ].join("\n") + "\n";
    const output = {
      observations: [],
      summary: SAMPLE_DIGEST.summary,
      proposals: [
        { kind: "memory", bullet: "**Lock constant**: `src/lock.ts` → `LOCK_RETRY_MS` holds the retry window (2026-11-01)" },
        { kind: "memory", bullet: "   " },
      ],
      stale: [{ id: a, reason: "the session changed the retry to 5 s; token " + TOKEN }, { id: 999, reason: "unlisted" }],
    };
    const { home, fake, job } = journey(root, [{ lines: okStreamOf(output) }], { transcript });

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
    expect(stats).toContain("\n  proposals:        1\n");
    expect(stats).toContain("\n  stale:            1\n");
  }, 30_000);
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readUntouched, recordUntouched } from "../src/hooks/lib/untouched.ts";
import { childEnv, makeCrankHome, REPO_ROOT, tempDir, withEnv } from "./helpers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("untouched repos", () => {
  test("untouched.json keeps 50 repos and 20 sessions each", () => {
    withEnv({ CRANK_HOME: makeCrankHome() }, () => {
      const repos = Array.from({ length: 51 }, (_, i) => `/work/répo 空 ${i}`);
      for (const repo of repos) {
        recordUntouched([repo], null);
        Bun.sleepSync(1);
      }
      const kept = readUntouched().map((r) => r.root);
      expect(kept).toHaveLength(50);
      expect(kept).not.toContain(repos[0]);
      expect(kept).toContain(repos[50]!);

      const repo = repos[50]!;
      const sessionsOf = () => readUntouched().find((r) => r.root === repo)!;
      for (let i = 0; i <= 20; i++) recordUntouched([repo], `s${i}`);
      expect(sessionsOf().sessions).toEqual(Array.from({ length: 20 }, (_, i) => `s${i + 1}`));

      recordUntouched([repo], "s5");
      const moved = sessionsOf();
      expect(moved.sessions).toHaveLength(20);
      expect(moved.sessions.at(-1)).toBe("s5");
      expect(moved.sessions.filter((s) => s === "s5")).toHaveLength(1);

      Bun.sleepSync(1);
      recordUntouched([repo], null);
      const touched = sessionsOf();
      expect(touched.sessions).toEqual(moved.sessions);
      expect(touched.lastSeenMs).toBeGreaterThan(moved.lastSeenMs);
    });
  });

  test("reading drops old and since-installed repos", () => {
    const home = makeCrankHome();
    withEnv({ CRANK_HOME: home }, () => {
      expect(readUntouched()).toEqual([]);
      const now = Date.now();
      const installed = tempDir("crank-untouched-");
      fs.mkdirSync(path.join(installed, ".crank"));
      fs.writeFileSync(path.join(installed, ".crank/config.json"), "{}");
      const repo = (root: string, lastSeenMs: number) => ({ root, lastSeenMs, sessions: [] });
      fs.writeFileSync(
        path.join(home, "untouched.json"),
        JSON.stringify({
          repos: [
            repo("/work/old", now - 31 * DAY_MS),
            repo("/work/yesterday", now - DAY_MS),
            repo(installed, now),
            repo("/work/today", now),
          ],
        }),
      );
      expect(readUntouched().map((r) => r.root)).toEqual(["/work/today", "/work/yesterday"]);
    });
  });

  test("concurrent sightings of unowned repos keep every repo", async () => {
    const home = makeCrankHome();
    const at = String(Date.now() + 1000);
    const repos = Array.from({ length: 8 }, (_, n) => path.join(os.tmpdir(), `unowned-${n}`));
    const writer = path.join(REPO_ROOT, "tests/fixtures/untouched-writer.ts");
    const children = repos.map((repo) =>
      Bun.spawn(["bun", writer, repo, at], {
        env: childEnv({ CRANK_HOME: home }),
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    expect(await Promise.all(children.map((c) => c.exited))).toEqual(Array(8).fill(0));
    const seen = withEnv({ CRANK_HOME: home }, () => readUntouched().map((r) => r.root));
    expect(seen.sort()).toEqual([...repos].sort());
  });
});

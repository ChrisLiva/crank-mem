import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, childEnv, tempDir } from "./helpers.ts";

test("the test helpers keep a run without the preload out of the user's crank home", () => {
  const userHome = tempDir("crank-userhome-");
  const env = childEnv({ HOME: userHome });
  delete env.CRANK_HOME;
  const run = spawnSync("bun", [path.join(REPO_ROOT, "tests/fixtures/no-preload.ts")], {
    cwd: userHome, // no bunfig.toml above it, as when `bun test` starts outside the repo root
    encoding: "utf-8",
    env,
  });
  expect(run.status).toBe(0);
  expect(fs.existsSync(path.join(userHome, ".crank"))).toBe(false);
});

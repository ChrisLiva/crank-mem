import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { locked } from "../src/cli/tool-install.ts";
import { REPO_ROOT, childEnv, makeCrankHome, withEnv } from "./helpers.ts";

describe("tool lock", () => {
  test("releasing does not remove a lock another live process took", async () => {
    const home = makeCrankHome();
    const lock = path.join(home, "tool.lock");
    try {
      const code = await withEnv({ CRANK_HOME: home }, () =>
        locked("test", async () => {
          fs.writeFileSync(lock, String(process.ppid));
          return 0;
        }),
      );
      expect(code).toBe(0);
      expect(fs.readFileSync(lock, "utf-8")).toBe(String(process.ppid));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("takers racing to steal a dead-pid lock never hold it together", async () => {
    const home = makeCrankHome();
    const log = path.join(home, "takers.log");
    try {
      fs.writeFileSync(path.join(home, "tool.lock"), "999999");
      const at = String(Date.now() + 1000);
      const children = Array.from({ length: 8 }, () =>
        Bun.spawn(["bun", path.join(REPO_ROOT, "tests/fixtures/tool-lock-taker.ts"), log, at], {
          env: childEnv({ CRANK_HOME: home }),
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      await Promise.all(children.map((c) => c.exited));
      const lines = fs.readFileSync(log, "utf-8").split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      let inside = 0;
      for (const line of lines) {
        inside += line.startsWith("enter ") ? 1 : -1;
        expect(inside).toBeLessThanOrEqual(1);
      }
      expect(inside).toBe(0);
      expect(fs.existsSync(path.join(home, "tool.lock.steal"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("an abandoned steal marker does not keep a dead-pid lock stuck", async () => {
    const home = makeCrankHome();
    const lock = path.join(home, "tool.lock");
    const marker = path.join(home, "tool.lock.steal");
    try {
      fs.writeFileSync(lock, "999999");
      fs.writeFileSync(marker, "999998");
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(marker, old, old);
      const code = await withEnv({ CRANK_HOME: home }, () => locked("test", async () => 0));
      expect(code).toBe(0);
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

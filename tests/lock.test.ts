import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withLock } from "../src/hooks/lib/lock.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crank-lock-"));
}

const LOCK = "anatomy-index.lock";

describe("withLock", () => {
  test("runs fn and releases", () => {
    const dir = tmpDir();
    const result = withLock(dir, 1000, () => 42);
    expect(result).toBe(42);
    expect(fs.existsSync(path.join(dir, LOCK))).toBe(false);
  });

  test("releases on throw", () => {
    const dir = tmpDir();
    expect(() => withLock(dir, 1000, () => { throw new Error("boom"); })).toThrow("boom");
    expect(fs.existsSync(path.join(dir, LOCK))).toBe(false);
  });

  test("contention: returns null when a live process holds the lock", () => {
    const dir = tmpDir();
    // A live pid (this process) with a fresh timestamp — not stealable.
    fs.writeFileSync(
      path.join(dir, LOCK),
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() })
    );
    const start = Date.now();
    const result = withLock(dir, 200, () => 42);
    expect(result).toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  });

  test("steals a stale lock (old timestamp)", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, LOCK),
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() - 60_000 })
    );
    expect(withLock(dir, 2000, () => "stolen")).toBe("stolen");
  });

  test("steals a dead-pid lock", () => {
    const dir = tmpDir();
    // pid 1 exists but we can't signal it... use an unlikely-live pid instead.
    fs.writeFileSync(
      path.join(dir, LOCK),
      JSON.stringify({ pid: 99999999, hostname: os.hostname(), acquiredAt: Date.now() })
    );
    expect(withLock(dir, 2000, () => "stolen")).toBe("stolen");
  });

  test("steals a corrupt old lock file", () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, LOCK);
    fs.writeFileSync(lockPath, "garbage{{{");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    expect(withLock(dir, 2000, () => "stolen")).toBe("stolen");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { cliVersion } from "../src/cli/version.ts";
import { REPO_ROOT, childEnv, cleanup, dashboardFixture, tempDir } from "./helpers.ts";

afterEach(cleanup);

type Pack = { status: number; stderr: string; out: string };

/** Run `scripts/pack-release.ts` from a temp cwd into a fresh out dir. */
function pack(dist: string, extra: string[] = []): Pack {
  const out = tempDir("crank-release-out-");
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/pack-release.ts"), "--out", out, "--dist", dist, ...extra],
    { cwd: tempDir("crank-release-cwd-"), encoding: "utf-8", timeout: 60_000, env: childEnv() },
  );
  return { status: result.status ?? -1, stderr: result.stderr, out };
}

function entries(tarball: string): string[] {
  const listed = spawnSync("tar", ["-tzf", tarball], { encoding: "utf-8" });
  expect(listed.status).toBe(0);
  return listed.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(/^\.\//, ""));
}

describe("pack-release", () => {
  test("the tarball carries the runtime files and nothing from tests, docs, dashboard sources or node_modules", () => {
    const run = pack(path.join(dashboardFixture(cliVersion()), "dist"));
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const listed = entries(path.join(run.out, "crank-mem.tar.gz"));
    for (const file of [
      "bin/crank-mem",
      "src/cli/main.ts",
      "src/hooks/session-start.ts",
      "src/templates/cerebrum.md",
      "package.json",
      "bun.lock",
      "dashboard/dist/index.html",
      "dashboard/dist/.crank-version",
    ]) {
      expect(listed).toContain(file);
    }
    const excluded = listed.filter(
      (entry) =>
        ["tests/", "docs/", "node_modules/", "dashboard/src/"].some((prefix) =>
          entry.startsWith(prefix),
        ) || path.basename(entry).startsWith("._"),
    );
    expect(excluded).toEqual([]);
  });

  test("the checksum file matches the tarball", () => {
    const run = pack(path.join(dashboardFixture(cliVersion()), "dist"));
    expect(run.status).toBe(0);
    const summed = spawnSync("shasum", ["-a", "256", "crank-mem.tar.gz"], {
      cwd: run.out,
      encoding: "utf-8",
    });
    expect(summed.status).toBe(0);
    const recorded = fs.readFileSync(path.join(run.out, "crank-mem.tar.gz.sha256"), "utf-8");
    expect(recorded.split(/\s+/)[0]).toBe(summed.stdout.split(/\s+/)[0]!);
  });

  test("release.json names the packed version", () => {
    const run = pack(path.join(dashboardFixture("9.9.9"), "dist"), [
      "--version",
      "9.9.9",
      "--released-at",
      "2026-11-10T00:00:00Z",
    ]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(run.out, "release.json"), "utf-8"))).toEqual({
      version: "9.9.9",
      tag: "v9.9.9",
      releasedAt: "2026-11-10T00:00:00Z",
    });
    const extracted = tempDir("crank-release-x-");
    const untar = spawnSync("tar", [
      "-xzf",
      path.join(run.out, "crank-mem.tar.gz"),
      "-C",
      extracted,
    ]);
    expect(untar.status).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(extracted, "package.json"), "utf-8"));
    expect(pkg.version).toBe("9.9.9");
  });

  test("a dist without index.html, without a stamp, or stamped with another version, is refused", () => {
    const missingIndex = path.join(dashboardFixture(cliVersion()), "dist");
    fs.rmSync(path.join(missingIndex, "index.html"));
    const dists = [
      path.join(dashboardFixture(null), "dist"),
      path.join(dashboardFixture("0.0.1"), "dist"),
      missingIndex,
    ];
    for (const dist of dists) {
      const run = pack(dist);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("dashboard build");
      expect(fs.existsSync(path.join(run.out, "crank-mem.tar.gz"))).toBe(false);
    }
  });
});

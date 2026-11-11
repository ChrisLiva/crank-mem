import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  cleanup,
  fakeBun,
  makeInstalledCopy,
  makeModelHome,
  releaseDir,
  runCli,
  runInstalled,
  startReleaseServer,
  tempDir,
} from "./helpers.ts";

const servers: Array<{ stop(): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  await cleanup();
});

const TARBALL = "crank-mem.tar.gz";

type Setup = {
  H: string;
  P: string;
  R: string;
  log: string;
  env: Record<string, string>;
};

/** A crank home running installed 1.0.0 with one inited project, and releases 1.0.0–1.2.0 served with 1.1.0 latest. */
async function setup(): Promise<Setup> {
  const H = makeModelHome();
  makeInstalledCopy(H, "1.0.0");
  const P = tempDir("crank-selfupdate-proj-");
  fs.writeFileSync(path.join(P, "a.ts"), "export const a = 1;\n");
  expect(runInstalled(H, P, ["init", "--yes"]).status).toBe(0);
  const R = releaseDir(["1.0.0", "1.1.0", "1.2.0"], "1.1.0");
  const server = await startReleaseServer(R);
  servers.push(server);
  const log = path.join(tempDir("crank-bunlog-"), "bun.log");
  const env = {
    CRANK_RELEASE_URL: server.url,
    PATH: `${fakeBun(log)}:${process.env.PATH}`,
  };
  return { H, P, R, log, env };
}

function versions(H: string): string[] {
  return fs.readdirSync(path.join(H, "versions")).sort();
}

function current(H: string): string {
  return fs.readlinkSync(path.join(H, "current"));
}

describe("self-update", () => {
  test("installs the latest release, flips current, and repairs projects with the new version", async () => {
    const { H, P, env } = await setup();
    const result = runInstalled(H, tempDir("crank-cwd-"), ["self-update"], env);
    expect(result.stderr).not.toContain("could not");
    expect(result.status).toBe(0);
    expect(current(H)).toBe("versions/1.1.0");
    const config = JSON.parse(fs.readFileSync(path.join(P, ".crank/config.json"), "utf-8"));
    expect(config.vendored_version).toBe("1.1.0");
    expect(config.clone_root).toBe(path.join(H, "current"));
    expect(versions(H)).toEqual(["1.0.0", "1.1.0"]);
  }, 30_000);

  test("a third version prunes the oldest", async () => {
    const { H, env } = await setup();
    expect(runInstalled(H, tempDir("crank-cwd-"), ["self-update"], env).status).toBe(0);
    const result = runInstalled(H, tempDir("crank-cwd-"), ["self-update", "--to", "v1.2.0"], env);
    expect(result.status).toBe(0);
    expect(current(H)).toBe("versions/1.2.0");
    expect(versions(H)).toEqual(["1.1.0", "1.2.0"]);
  }, 30_000);

  test("pruning keeps the version a live daemon runs", async () => {
    const { H: H3, env } = await setup();
    expect(runInstalled(H3, tempDir("crank-cwd-"), ["self-update"], env).status).toBe(0);
    fs.writeFileSync(
      path.join(H3, "daemon.json"),
      JSON.stringify({ pid: process.pid, version: "1.0.0", heartbeatMs: Date.now() }),
    );
    const result = runInstalled(H3, tempDir("crank-cwd-"), ["self-update", "--to", "v1.2.0"], env);
    expect(result.status).toBe(0);
    expect(versions(H3)).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
  }, 30_000);

  test("a checksum mismatch changes nothing", async () => {
    const { H, R, env } = await setup();
    fs.writeFileSync(
      path.join(R, `latest/download/${TARBALL}.sha256`),
      `${"0".repeat(64)}  ${TARBALL}\n`,
    );
    const result = runInstalled(H, tempDir("crank-cwd-"), ["self-update"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum");
    expect(current(H)).toBe("versions/1.0.0");
    expect(versions(H)).toEqual(["1.0.0"]);
  }, 30_000);

  test("already at the latest is a no-op", async () => {
    const { H, R, log, env } = await setup();
    fs.cpSync(path.join(R, "download/v1.0.0"), path.join(R, "latest/download"), {
      recursive: true,
    });
    const result = runInstalled(H, tempDir("crank-cwd-"), ["self-update"], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already at 1.0.0");
    const lines = fs.readFileSync(log, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => line.startsWith("install"))).toEqual([]);
    expect(current(H)).toBe("versions/1.0.0");
  }, 30_000);

  test("refuses from a clone", () => {
    const result = runCli(tempDir("crank-selfupdate-"), ["self-update"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("self-update runs from an installed copy");
    expect(result.stderr).toContain("git pull");
  }, 30_000);

  test("a live tool lock refuses", async () => {
    const { H, env } = await setup();
    fs.writeFileSync(path.join(H, "tool.lock"), String(process.pid));
    const result = runInstalled(H, tempDir("crank-cwd-"), ["self-update"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("crank-mem: another install or update is running");
    expect(current(H)).toBe("versions/1.0.0");
  }, 30_000);
});

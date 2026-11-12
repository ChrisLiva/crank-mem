import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Call,
  cleanup,
  fakeTool,
  makeInstalledCopy,
  makeModelHome,
  plantMemory,
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
  bun: { calls(): Call[] };
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
  const bun = fakeTool("bun", "runtime");
  const env = {
    CRANK_RELEASE_URL: server.url,
    PATH: `${bun.dir}:${process.env.PATH}`,
  };
  return { H, P, R, bun, env };
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
    const { H, R, bun, env } = await setup();
    fs.cpSync(path.join(R, "download/v1.0.0"), path.join(R, "latest/download"), {
      recursive: true,
    });
    const result = runInstalled(H, tempDir("crank-cwd-"), ["self-update"], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already at 1.0.0");
    const calls = bun.calls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.argv.startsWith("install"))).toEqual([]);
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

/** Task 9's setup, then `self-update` to 1.1.0, so `H/versions` holds 1.0.0 and 1.1.0. */
async function updated(): Promise<Setup> {
  const s = await setup();
  expect(runInstalled(s.H, tempDir("crank-cwd-"), ["self-update"], s.env).status).toBe(0);
  expect(current(s.H)).toBe("versions/1.1.0");
  return s;
}

describe("rollback", () => {
  test("flips back and repairs projects with the previous version", async () => {
    const { H, P, env } = await updated();
    const result = runInstalled(H, tempDir("crank-cwd-"), ["rollback"], env);
    expect(result.stderr).not.toContain("could not");
    expect(result.status).toBe(0);
    expect(current(H)).toBe("versions/1.0.0");
    const config = JSON.parse(fs.readFileSync(path.join(P, ".crank/config.json"), "utf-8"));
    expect(config.vendored_version).toBe("1.0.0");

    const again = runInstalled(H, tempDir("crank-cwd-"), ["rollback"], env);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("no previous version");
    expect(current(H)).toBe("versions/1.0.0");
  }, 60_000);

  test("a store newer than the previous version's schema refuses and names the project", async () => {
    const { H, P, env } = await updated();
    plantMemory(P, "newer");
    const result = runInstalled(H, tempDir("crank-cwd-"), ["rollback"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(fs.realpathSync(P));
    expect(result.stderr).toContain("newer");
    expect(result.stderr).toContain("crank-mem restore-memory");
    expect(current(H)).toBe("versions/1.1.0");
  }, 60_000);

  test("a previous version that does not prepare refuses and keeps current", async () => {
    const { H, env } = await updated();
    fs.rmSync(path.join(H, "versions/1.0.0/dashboard/dist/.crank-version"));
    const result = runInstalled(H, tempDir("crank-cwd-"), ["rollback"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not install 1.0.0");
    expect(current(H)).toBe("versions/1.1.0");
  }, 60_000);

  test("a store that does not open does not block", async () => {
    const { H, P, env } = await updated();
    plantMemory(P, "unreadable");
    const result = runInstalled(H, tempDir("crank-cwd-"), ["rollback"], env);
    expect(result.status).toBe(0);
    expect(current(H)).toBe("versions/1.0.0");
  }, 60_000);

  test("an unreadable schema line refuses", async () => {
    const { H, env } = await updated();
    const schema = path.join(H, "versions/1.0.0/src/hooks/lib/memory-schema.ts");
    fs.writeFileSync(
      schema,
      fs
        .readFileSync(schema, "utf-8")
        .split("\n")
        .filter((line) => !line.startsWith("export const SCHEMA_VERSION"))
        .join("\n"),
    );
    const result = runInstalled(H, tempDir("crank-cwd-"), ["rollback"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read the schema version");
    expect(current(H)).toBe("versions/1.1.0");
  }, 60_000);

  test("no previous version refuses", () => {
    const H2 = makeModelHome();
    makeInstalledCopy(H2, "1.0.0");
    const result = runInstalled(H2, tempDir("crank-cwd-"), ["rollback"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no previous version");
    expect(current(H2)).toBe("versions/1.0.0");
  }, 30_000);

  test("self-update --to an older tag goes through the same guard", async () => {
    const { H, P, env } = await updated();
    plantMemory(P, "newer");
    const result = runInstalled(H, tempDir("crank-cwd-"), ["self-update", "--to", "v1.0.0"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("crank-mem restore-memory");
    expect(current(H)).toBe("versions/1.1.0");
  }, 60_000);

  test("refuses from a clone", () => {
    const result = runCli(tempDir("crank-rollback-"), ["rollback"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rollback runs from an installed copy");
  }, 30_000);
});

function updateState(H: string): Record<string, unknown> & {
  latest?: { version: string } | null;
} {
  return JSON.parse(fs.readFileSync(path.join(H, "update.json"), "utf-8"));
}

function releaseRequests(server: { requests(): string[] }): string[] {
  return server.requests().filter((line) => line === "/latest/download/release.json");
}

/** A crank home running installed 1.0.0, and a release server whose latest is 1.1.0. */
async function checkSetup() {
  const H = makeModelHome();
  makeInstalledCopy(H, "1.0.0");
  const server = await startReleaseServer(releaseDir(["1.1.0"]));
  servers.push(server);
  // The trailing slash pins releaseBase's trim, which a failed check's message shows.
  return { H, server, env: { CRANK_RELEASE_URL: `${server.url}/` } };
}

describe("self-update --check", () => {
  test("always fetches, records, and reports", async () => {
    const { H, server, env } = await checkSetup();
    const result = runInstalled(H, tempDir("crank-cwd-"), ["self-update", "--check"], env);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("installed 1.0.0, latest 1.1.0");
    const state = updateState(H);
    expect(state.latest?.version).toBe("1.1.0");
    expect(Math.abs((state.checkedAtMs as number) - Date.now())).toBeLessThan(60_000);
    expect(releaseRequests(server)).toHaveLength(1);
    expect(runInstalled(H, tempDir("crank-cwd-"), ["self-update", "--check"], env).status).toBe(0);
    expect(releaseRequests(server)).toHaveLength(2);
  }, 30_000);

  test("a failed check keeps the last known release and records the error", async () => {
    const { H, server, env } = await checkSetup();
    expect(runInstalled(H, tempDir("crank-cwd-"), ["self-update", "--check"], env).status).toBe(0);
    server.stop();
    const result = runInstalled(H, tempDir("crank-cwd-"), ["self-update", "--check"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not check");
    expect(result.stderr).toContain(`${server.url}/latest/download/release.json`);
    const state = updateState(H);
    expect(state.latest?.version).toBe("1.1.0");
    expect(typeof state.error).toBe("string");
    expect((state.error as string).length).toBeGreaterThan(0);
  }, 30_000);

  test("with CRANK_RELEASE_URL unset, checks the GitHub releases URL", () => {
    const H = makeModelHome();
    makeInstalledCopy(H, "1.0.0");
    // A closed-port proxy keeps the check off the network.
    const proxy = "http://127.0.0.1:9";
    const result = runInstalled(H, tempDir("crank-cwd-"), ["self-update", "--check"], {
      CRANK_RELEASE_URL: "",
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      NO_PROXY: "",
      no_proxy: "",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "https://github.com/ChrisLiva/crank-mem/releases/latest/download/release.json",
    );
  }, 30_000);

  test("--auto and --check-daily write settings and change nothing else", async () => {
    const { H, server, env } = await checkSetup();
    const cwd = tempDir("crank-cwd-");
    const usage =
      "Usage: crank-mem self-update [--to vX.Y.Z] [--check] [--auto on|off] [--check-daily on|off]";
    const on = runInstalled(H, cwd, ["self-update", "--auto", "on"], env);
    expect(on.stderr).toBe("");
    expect(on.status).toBe(0);
    expect(updateState(H).auto).toBe(true);
    expect(updateState(H).checkDaily).toBe(true);
    expect(runInstalled(H, cwd, ["self-update", "--check-daily", "off"], env).status).toBe(0);
    expect(updateState(H).checkDaily).toBe(false);
    expect(updateState(H).auto).toBe(true);
    const both = runInstalled(H, cwd, ["self-update", "--auto", "off", "--check-daily", "on"], env);
    expect(both.status).toBe(0);
    expect(updateState(H)).toMatchObject({ auto: false, checkDaily: true });

    for (const args of [
      ["--auto", "maybe"],
      ["--check-daily"],
      ["--check", "--to", "v1.1.0"],
      ["--auto", "on", "--check"],
      ["--to", "v1.1.0", "--check-daily", "off"],
    ]) {
      const result = runInstalled(H, cwd, ["self-update", ...args], env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(usage);
    }
    expect(updateState(H)).toMatchObject({ auto: false, checkDaily: true });
    expect(server.requests()).toEqual([]);
    expect(current(H)).toBe("versions/1.0.0");
  }, 30_000);

  test("refuses from a clone", () => {
    const result = runCli(tempDir("crank-selfupdate-"), ["self-update", "--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("self-update runs from an installed copy");
  }, 30_000);
});

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  REPO_ROOT,
  childEnv,
  cleanup,
  fakeBun,
  fakeTool,
  git,
  makeCrankHome,
  makeInstalledCopy,
  makeModelHome,
  runCli,
  runHook,
  runInstalled,
  startReleaseServer,
  temps,
  tempDir,
} from "./helpers.ts";
import { claudeSessionStart } from "./fixtures/payloads.ts";

afterEach(cleanup);

/** A crank home that cleanup removes, holding an installed copy at 1.0.0. */
function installedHome(): string {
  const home = makeCrankHome();
  temps.push(home);
  makeInstalledCopy(home, "1.0.0");
  return home;
}

/** A temp git project with one source file. */
function gitProject(): string {
  const root = tempDir("crank-installed-proj-");
  fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
  git(root, "init", "-q");
  return root;
}

function configFile(root: string): string {
  return path.join(root, ".crank/config.json");
}

function cloneRoot(root: string): unknown {
  return JSON.parse(fs.readFileSync(configFile(root), "utf8")).clone_root;
}

describe("clone_root", () => {
  test("init run through an installed copy records the stable current link", () => {
    const home = installedHome();
    const root = gitProject();
    const run = runInstalled(home, root, ["init", "--yes"]);
    expect(run.status).toBe(0);
    expect(cloneRoot(root)).toBe(path.join(home, "current"));
  });

  test("upgrade run through an installed copy rewrites a clone path to the stable current link", () => {
    const home = installedHome();
    const root = gitProject();
    expect(runInstalled(home, root, ["init", "--yes"]).status).toBe(0);
    const config = JSON.parse(fs.readFileSync(configFile(root), "utf8"));
    fs.writeFileSync(configFile(root), JSON.stringify({ ...config, clone_root: "/old/clone" }));
    const run = runInstalled(home, root, ["upgrade"]);
    expect(run.status).toBe(0);
    expect(cloneRoot(root)).toBe(path.join(home, "current"));
  });

  test("init run in a clone records the clone", () => {
    const root = gitProject();
    expect(runCli(root, ["init", "--yes"]).status).toBe(0);
    expect(cloneRoot(root)).toBe(REPO_ROOT);
  });
});

describe("an installed copy's tool step", () => {
  /** An installed copy at 1.0.0 in `home` whose dashboard stamp is for 0.9.0; returns its realpath. */
  function staleStampCopy(home: string): string {
    const dir = makeInstalledCopy(home, "1.0.0");
    fs.writeFileSync(path.join(dir, "dashboard/dist/.crank-version"), "0.9.0");
    return fs.realpathSync(dir);
  }

  /** The log lines whose first word is `install`. */
  function installLines(log: string, from = 0): string[] {
    return fs
      .readFileSync(log, "utf8")
      .split("\n")
      .slice(from)
      .filter((l) => l.split(" ")[0] === "install");
  }

  test("upgrade and setup install production packages and never build the dashboard", () => {
    const home = makeCrankHome();
    temps.push(home);
    const copy = staleStampCopy(home);
    const log = path.join(tempDir("crank-installed-log-"), "bun.log");
    const PATH = `${fakeBun(log)}:${process.env.PATH}`;
    const root = gitProject();
    expect(runInstalled(home, root, ["init", "--yes"]).status).toBe(0);
    expect(runInstalled(home, root, ["upgrade"], { PATH }).status).toBe(0);
    const upgradeInstalls = installLines(log);
    expect(upgradeInstalls.length).toBeGreaterThanOrEqual(1);
    for (const line of upgradeInstalls)
      expect(line).toBe(`install --production --frozen-lockfile @ ${copy}`);

    const modelHome = makeModelHome();
    temps.push(modelHome);
    const modelCopy = staleStampCopy(modelHome);
    const seen = fs.readFileSync(log, "utf8").split("\n").length - 1;
    expect(
      runInstalled(modelHome, tempDir("crank-installed-setup-"), ["setup"], { PATH }).status,
    ).toBe(0);
    const setupInstalls = installLines(log, seen);
    expect(setupInstalls.length).toBeGreaterThanOrEqual(1);
    for (const line of setupInstalls)
      expect(line).toBe(`install --production --frozen-lockfile @ ${modelCopy}`);

    expect(fs.readFileSync(log, "utf8")).not.toContain("run build");
  }, 30_000);

  test("setup without bun installs production packages with npm", () => {
    const home = makeModelHome();
    temps.push(home);
    const copy = staleStampCopy(home);
    const npm = fakeTool("npm", 0);
    const run = spawnSync(process.execPath, [path.join(copy, "src/cli/main.ts"), "setup"], {
      cwd: tempDir("crank-installed-npm-"),
      encoding: "utf-8",
      timeout: 30_000,
      env: childEnv({ CRANK_HOME: home, PATH: npm.dir }),
    });
    expect(run.status).toBe(0);
    expect(npm.calls()).toEqual([
      { argv: "install --omit=dev --ignore-scripts --no-package-lock", cwd: copy },
    ]);
  });
});

describe("the update notice", () => {
  const NOTICE = "crank-mem 1.1.0 is available (installed 1.0.0) — run `crank-mem self-update`.";
  const DUE = {
    latest: { version: "1.1.0", tag: "v1.1.0", releasedAt: "2026-11-09T00:00:00Z" },
    checkedAtMs: Date.now() - 2 * 86_400_000,
  };
  const owned: string[] = [];
  let H: string;
  let P: string;
  let S: Awaited<ReturnType<typeof startReleaseServer>>;
  let env: Record<string, string>;

  /** A git project that outlives `cleanup`, removed in `afterAll`. */
  function ownedProject(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-notice-proj-"));
    owned.push(root);
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    git(root, "init", "-q");
    return root;
  }

  function writeUpdate(state: object | null): void {
    const file = path.join(H, "update.json");
    if (state === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify(state));
  }

  beforeAll(async () => {
    H = makeModelHome();
    owned.push(H);
    makeInstalledCopy(H, "1.0.0");
    const R = fs.mkdtempSync(path.join(os.tmpdir(), "crank-notice-r-"));
    owned.push(R);
    fs.mkdirSync(path.join(R, "latest/download"), { recursive: true });
    fs.writeFileSync(path.join(R, "latest/download/release.json"), JSON.stringify(DUE.latest));
    S = await startReleaseServer(R);
    env = { CRANK_RELEASE_URL: S.url };
    writeUpdate(DUE);
    P = ownedProject();
    fs.writeFileSync(path.join(P, "package.json"), '{\n  "name": "p"\n}\n');
    expect(runInstalled(H, P, ["init", "--yes"], env).status).toBe(0);
  }, 30_000);

  afterAll(() => {
    S?.stop();
    for (const dir of owned) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("stats prints an update: row for an available release, an up-to-date check and no check", () => {
    const available = runInstalled(H, P, ["stats"], env);
    expect(available.status).toBe(0);
    expect(available.stdout).toMatch(
      /^  update: {11}1\.1\.0 available — run `crank-mem self-update`$/m,
    );
    try {
      writeUpdate({ ...DUE, latest: { ...DUE.latest, version: "1.0.0", tag: "v1.0.0" } });
      expect(runInstalled(H, P, ["stats"], env).stdout).toMatch(
        /^  update: {11}up to date \(checked \d{4}-\d{2}-\d{2}\)$/m,
      );
      writeUpdate(null);
      expect(runInstalled(H, P, ["stats"], env).stdout).toMatch(/^  update: {11}not checked yet$/m);
    } finally {
      writeUpdate(DUE);
    }
  });

  test("each human-run command prints the notice on stderr once", () => {
    const runs: Array<[string[], string]> = [
      [["init", "--yes"], ownedProject()],
      [["upgrade"], P],
      [["setup"], P],
      [["digest", "off"], P],
    ];
    for (const [args, cwd] of runs) {
      const run = runInstalled(H, cwd, args, env);
      expect({ args, status: run.status }).toEqual({ args, status: 0 });
      expect({ args, count: run.stderr.split(NOTICE).length - 1 }).toEqual({ args, count: 1 });
    }
  }, 60_000);

  test("agent-facing commands never print it", () => {
    const runs = [
      ["search", "anything"],
      ["timeline", "1"],
      ["get", "1"],
      ["outline", "package.json"],
      ["unfold", "package.json", "1"],
    ];
    for (const args of runs) {
      const run = runInstalled(H, P, args, env);
      expect({ args, stderr: run.stderr }).not.toEqual({
        args,
        stderr: expect.stringContaining("is available"),
      });
    }
  }, 60_000);

  test("a clone prints no notice", () => {
    const run = runCli(P, ["stats"], { ...env, CRANK_HOME: H });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toMatch(/^  update:/m);
    expect(run.stderr).not.toContain("is available");
  });

  test("the session-start hook never carries it", () => {
    const run = runHook("src/hooks/session-start.ts", JSON.stringify(claudeSessionStart(P)), P, {
      ...env,
      CRANK_HOME: H,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("additionalContext");
    expect(run.stdout).not.toContain("is available");
  });

  test("no command above fetches, though a check is due", () => {
    expect(S.requests()).toEqual([]);
  });
});

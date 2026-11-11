import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
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
  runInstalled,
  temps,
  tempDir,
} from "./helpers.ts";

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

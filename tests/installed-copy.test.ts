import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  REPO_ROOT,
  cleanup,
  git,
  makeCrankHome,
  makeInstalledCopy,
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

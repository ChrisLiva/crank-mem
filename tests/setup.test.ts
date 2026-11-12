import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cliVersion } from "../src/cli/version.ts";
import {
  REPO_ROOT,
  dashboardFixture,
  fakeTool,
  initedCopy,
  makeCrankHome,
  makeModelHome,
  realModelsDir,
  runCli,
  startModelServer,
} from "./helpers.ts";

const MODEL_FILE = "Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A temp `CRANK_DASHBOARD_DIR` with no build, and its realpath. */
function emptyDashboard(): { dir: string; real: string; stamp(): string | null } {
  const dir = tempDir("crank-dash-");
  const stampFile = path.join(dir, "dist/.crank-version");
  return {
    dir,
    real: fs.realpathSync(dir),
    stamp: () => (fs.existsSync(stampFile) ? fs.readFileSync(stampFile, "utf-8") : null),
  };
}

const ROOT_REAL = fs.realpathSync(REPO_ROOT);

const servers: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

describe("setup", () => {
  test("installs with bun, builds the dashboard, downloads the model, and a second run downloads nothing", async () => {
    const bun = fakeTool("bun", 0);
    const dash = emptyDashboard();
    const home = makeCrankHome();
    const server = await startModelServer(realModelsDir(), "ok");
    servers.push(server);
    const env = {
      CRANK_HOME: home,
      CRANK_DASHBOARD_DIR: dash.dir,
      PATH: `${bun.dir}:${process.env.PATH}`,
    };
    const modelsDir = path.join(home, "models");
    const steps =
      "crank-mem: installed packages with bun\ncrank-mem: installed dashboard packages with bun\ncrank-mem: built the dashboard\n";

    const first = runCli(REPO_ROOT, ["setup", "--model-host", server.url], env);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(bun.calls()).toEqual([
      { argv: "install --frozen-lockfile", cwd: ROOT_REAL },
      { argv: "install --frozen-lockfile", cwd: dash.real },
      { argv: "run build", cwd: dash.real },
    ]);
    expect(dash.stamp()).toBe(cliVersion());
    expect(fs.statSync(path.join(modelsDir, MODEL_FILE)).size).toBe(
      fs.statSync(path.join(realModelsDir(), MODEL_FILE)).size,
    );
    expect(first.stdout).toBe(
      `${steps}crank-mem: downloaded Xenova/all-MiniLM-L6-v2 to ${modelsDir}\n`,
    );

    const served = server.requests().length;
    expect(served).toBeGreaterThan(0);
    const second = runCli(REPO_ROOT, ["setup", "--model-host", server.url], env);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(`${steps}crank-mem: model already in ${modelsDir}\n`);
    expect(server.requests().length).toBe(served);
  });

  test("falls back to npm without a lockfile when bun is not on PATH", () => {
    const npm = fakeTool("npm", 0);
    const dash = emptyDashboard();
    const run = runCli(REPO_ROOT, ["setup"], {
      CRANK_HOME: makeModelHome(),
      CRANK_DASHBOARD_DIR: dash.dir,
      PATH: npm.dir,
    });
    expect(run.status).toBe(0);
    expect(npm.calls()).toEqual([
      { argv: "install --ignore-scripts --no-package-lock", cwd: ROOT_REAL },
      { argv: "install --ignore-scripts --no-package-lock", cwd: dash.real },
      { argv: "run build", cwd: dash.real },
    ]);
    expect(run.stdout).toContain(
      "crank-mem: installed packages with npm\ncrank-mem: installed dashboard packages with npm\ncrank-mem: built the dashboard\ncrank-mem: model already in ",
    );
  });

  test("an install failure exits 1 with the tool's last stderr line", () => {
    const bun = fakeTool("bun", 1);
    const run = runCli(REPO_ROOT, ["setup"], {
      CRANK_HOME: makeModelHome(),
      CRANK_DASHBOARD_DIR: emptyDashboard().dir,
      PATH: `${bun.dir}:${process.env.PATH}`,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toBe("crank-mem: could not install packages (bun failed on purpose)\n");
    expect(run.stdout).toBe("");
    expect(bun.calls()).toHaveLength(1);
  });

  test("a dashboard install failure exits 1 before the build", () => {
    const dash = emptyDashboard();
    const bun = fakeTool("bun", 0, { argv: "install --frozen-lockfile", cwd: dash.real });
    const run = runCli(REPO_ROOT, ["setup"], {
      CRANK_HOME: makeModelHome(),
      CRANK_DASHBOARD_DIR: dash.dir,
      PATH: `${bun.dir}:${process.env.PATH}`,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      "crank-mem: could not install dashboard packages (bun failed on purpose)\n",
    );
    expect(run.stdout).toBe("crank-mem: installed packages with bun\n");
    expect(bun.calls().map((c) => c.argv)).not.toContain("run build");
    expect(dash.stamp()).toBeNull();
  });

  test("a build failure exits 1, writes no stamp and skips the model", () => {
    const dash = emptyDashboard();
    const bun = fakeTool("bun", 0, { argv: "run build" });
    const run = runCli(REPO_ROOT, ["setup"], {
      CRANK_HOME: makeModelHome(),
      CRANK_DASHBOARD_DIR: dash.dir,
      PATH: `${bun.dir}:${process.env.PATH}`,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toBe("crank-mem: could not build the dashboard (bun failed on purpose)\n");
    expect(run.stdout).toBe(
      "crank-mem: installed packages with bun\ncrank-mem: installed dashboard packages with bun\n",
    );
    expect(dash.stamp()).toBeNull();
  });

  test("a failed stamp write exits 1 with the write error and skips the model", () => {
    const dash = emptyDashboard();
    fs.writeFileSync(path.join(dash.dir, "dist"), "not a directory");
    const bun = fakeTool("bun", 0);
    const run = runCli(REPO_ROOT, ["setup"], {
      CRANK_HOME: makeModelHome(),
      CRANK_DASHBOARD_DIR: dash.dir,
      PATH: `${bun.dir}:${process.env.PATH}`,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toStartWith("crank-mem: could not build the dashboard (EEXIST");
    expect(run.stdout).not.toContain("model");
  });

  test("with neither bun nor npm on PATH, the spawn error is the detail", () => {
    const run = runCli(REPO_ROOT, ["setup"], {
      CRANK_HOME: makeModelHome(),
      CRANK_DASHBOARD_DIR: emptyDashboard().dir,
      PATH: tempDir("crank-emptypath-"),
    });
    expect(run.status).toBe(1);
    // The message is the runtime's own: node says `spawnSync npm ENOENT`, bun `Executable not found in $PATH: "npm"`.
    expect(run.stderr).toMatch(/^crank-mem: could not install packages \(.*npm.*\)\n$/);
  });

  for (const mode of ["stall", "slow"] as const) {
    test(`a ${mode} model host fails the download past the fetch timeout`, async () => {
      const bun = fakeTool("bun", 0);
      const server = await startModelServer(realModelsDir(), mode);
      servers.push(server);
      const run = runCli(
        REPO_ROOT,
        ["setup", "--model-host", server.url, "--fetch-timeout-ms", "500"],
        {
          CRANK_HOME: makeCrankHome(),
          PATH: `${bun.dir}:${process.env.PATH}`,
        },
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("crank-mem: could not download the model (");
      expect(server.requests().length).toBeGreaterThan(0);
    }, 20_000);
  }
});

describe("upgrade installs packages", () => {
  test("at the current version with a current dashboard it runs only the root install", () => {
    const root = initedCopy();
    const bun = fakeTool("bun", 0);
    const run = runCli(root, ["upgrade"], {
      CRANK_DASHBOARD_DIR: dashboardFixture(cliVersion()),
      PATH: `${bun.dir}:${process.env.PATH}`,
    });
    expect(run.status).toBe(0);
    expect(bun.calls().map((c) => c.argv)).toEqual(["install --frozen-lockfile"]);
    expect(run.stdout).toContain("already at");
    expect(run.stdout).not.toContain("installed packages");
    expect(run.stderr).toBe("");
  });

  test("a dashboard without a current stamp is installed, built and stamped", () => {
    const root = initedCopy();
    const dash = dashboardFixture(null);
    const dashReal = fs.realpathSync(dash);
    const bun = fakeTool("bun", 0);
    const run = runCli(root, ["upgrade"], {
      CRANK_DASHBOARD_DIR: dash,
      PATH: `${bun.dir}:${process.env.PATH}`,
    });
    expect(run.status).toBe(0);
    expect(bun.calls()).toEqual([
      { argv: "install --frozen-lockfile", cwd: ROOT_REAL },
      { argv: "install --frozen-lockfile", cwd: dashReal },
      { argv: "run build", cwd: dashReal },
    ]);
    expect(fs.readFileSync(path.join(dash, "dist/.crank-version"), "utf-8")).toBe(cliVersion());
    expect(run.stdout).toContain("already at");
    expect(run.stdout).not.toContain("dashboard");
    expect(run.stderr).toBe("");
  });

  test("a dashboard build failure warns, writes no stamp and still exits 0", () => {
    const root = initedCopy();
    const dash = dashboardFixture(null);
    const bun = fakeTool("bun", 0, { argv: "run build" });
    const run = runCli(root, ["upgrade"], {
      CRANK_DASHBOARD_DIR: dash,
      PATH: `${bun.dir}:${process.env.PATH}`,
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("crank-mem: could not build the dashboard (bun failed on purpose)\n");
    expect(fs.existsSync(path.join(dash, "dist/.crank-version"))).toBe(false);
    expect(run.stdout).toContain("already at");
  });

  test("a dashboard install failure warns, skips the build, writes no stamp and still exits 0", () => {
    const root = initedCopy();
    const dash = dashboardFixture(null);
    const dashReal = fs.realpathSync(dash);
    const bun = fakeTool("bun", 0, { argv: "install --frozen-lockfile", cwd: dashReal });
    const run = runCli(root, ["upgrade"], {
      CRANK_DASHBOARD_DIR: dash,
      PATH: `${bun.dir}:${process.env.PATH}`,
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe(
      "crank-mem: could not install dashboard packages (bun failed on purpose)\n",
    );
    expect(bun.calls()).toEqual([
      { argv: "install --frozen-lockfile", cwd: ROOT_REAL },
      { argv: "install --frozen-lockfile", cwd: dashReal },
    ]);
    expect(fs.existsSync(path.join(dash, "dist/.crank-version"))).toBe(false);
    expect(run.stdout).toContain("already at");
  });

  test("an install failure warns and still exits 0", () => {
    const root = initedCopy();
    const bun = fakeTool("bun", 1);
    const run = runCli(root, ["upgrade"], { PATH: `${bun.dir}:${process.env.PATH}` });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("crank-mem: could not install packages (bun failed on purpose)\n");
    expect(run.stdout).toContain("already at");
  });
});

describe("upgrade --all", () => {
  /** A crank home with two projects inited from it, each stamped as vendored at 0.0.1. */
  function twoProjects(): { home: string; a: string; b: string } {
    const home = makeCrankHome();
    const [a, b] = ["a", "b"].map((name) => {
      const root = fs.realpathSync(tempDir(`crank-all-${name}-`));
      fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
      expect(runCli(root, ["init", "--yes", "--codex", "skip"], { CRANK_HOME: home }).status).toBe(
        0,
      );
      const file = path.join(root, ".crank/config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf-8"));
      fs.writeFileSync(file, JSON.stringify({ ...config, vendored_version: "0.0.1" }, null, 2));
      return root;
    });
    return { home, a: a!, b: b! };
  }

  function vendored(root: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(root, ".crank/config.json"), "utf-8"))
      .vendored_version;
  }

  function upgradeAll(home: string, bun: { dir: string }) {
    return runCli(os.tmpdir(), ["upgrade", "--all"], {
      CRANK_HOME: home,
      PATH: `${bun.dir}:${process.env.PATH}`,
    });
  }

  test("installs packages once and repairs every registered project", () => {
    const { home, a, b } = twoProjects();
    const bun = fakeTool("bun", 0);
    const run = upgradeAll(home, bun);
    expect(run.status).toBe(0);
    expect(bun.calls().filter((c) => c.argv.startsWith("install --frozen-lockfile"))).toEqual([
      { argv: "install --frozen-lockfile", cwd: ROOT_REAL },
    ]);
    expect(vendored(a)).toBe(cliVersion());
    expect(vendored(b)).toBe(cliVersion());
    expect(run.stdout).toContain(`crank-mem: repairing ${a}`);
    expect(run.stdout).toContain(`crank-mem: repairing ${b}`);
  });

  test("a registered root without a config is reported and skipped", () => {
    const { home } = twoProjects();
    const c = tempDir("crank-all-c-");
    const file = path.join(home, "projects.json");
    const registry = JSON.parse(fs.readFileSync(file, "utf-8"));
    registry.projects.push({ root: c, addedAtMs: Date.now() });
    fs.writeFileSync(file, JSON.stringify(registry));
    const run = upgradeAll(home, fakeTool("bun", 0));
    expect(run.stdout).toContain(`${c}: missing, skipped`);
    expect(run.status).toBe(0);
  });

  test("a project whose anatomy lock is held is reported busy and left unchanged", () => {
    const { home, b } = twoProjects();
    const config = path.join(b, ".crank/config.json");
    const before = fs.readFileSync(config);
    fs.writeFileSync(
      path.join(b, ".crank/anatomy-index.lock"),
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() }),
    );
    const run = upgradeAll(home, fakeTool("bun", 0));
    expect(run.stdout).toContain(`${b}: busy, skipped`);
    expect(fs.readFileSync(config)).toEqual(before);
    expect(run.status).toBe(0);
  }, 20_000);

  test("a failed repair in one project still repairs the others and exits 1", () => {
    const { home, a, b } = twoProjects();
    fs.writeFileSync(path.join(a, ".claude/settings.local.json"), "{not json");
    const run = upgradeAll(home, fakeTool("bun", 0));
    expect(run.stderr).toContain("crank-mem: could not re-wire Claude Code hooks");
    expect(vendored(b)).toBe(cliVersion());
    expect(run.status).toBe(1);
  });

  const V1_INDEX = '{"version":1,"meta":{"lastScanned":null,"fileCount":0},"files":{}}';
  const indexOf = (root: string) => path.join(root, ".crank/anatomy-index.json");

  test("a project whose index predates version 2 is scanned; a current one is not", () => {
    const { home, a, b } = twoProjects();
    fs.writeFileSync(indexOf(b), V1_INDEX);
    const aBefore = fs.readFileSync(indexOf(a));
    const run = upgradeAll(home, fakeTool("bun", 0));
    expect(run.status).toBe(0);
    expect(run.stdout.split("full scan complete")).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(indexOf(b), "utf-8")).version).toBe(2);
    expect(fs.readFileSync(indexOf(a))).toEqual(aBefore);
  });

  test("a project whose scan throws does not stop the next one", () => {
    const { home, a, b } = twoProjects();
    fs.rmSync(indexOf(a));
    fs.mkdirSync(indexOf(a));
    fs.writeFileSync(indexOf(b), V1_INDEX);
    const run = upgradeAll(home, fakeTool("bun", 0));
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("crank-mem: could not scan (");
    expect(JSON.parse(fs.readFileSync(indexOf(b), "utf-8")).version).toBe(2);
  });
});

describe("digest on and the embedder", () => {
  test("says nothing when the model is in place", () => {
    const root = initedCopy();
    const run = runCli(root, ["digest", "on"], { CRANK_HOME: makeModelHome() });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
  });
});

describe("help", () => {
  test("lists setup and none of the hidden commands or flags", () => {
    const out = runCli(tempDir("crank-setup-help-"), ["--help"]).stdout;
    expect(out).toContain("Repair this project's install, or every registered project with --all");
    expect(out).toContain(
      "  setup           Install packages, build the dashboard and download the local search model\n",
    );
    for (const flag of [
      "--model-host",
      "--fetch-timeout-ms",
      "--sweep-ms",
      "--idle-ms",
      "--retry-ms",
      "--retry-cap-ms",
      "--run-timeout-ms",
      "--once",
    ]) {
      expect(out).not.toContain(flag);
    }
    expect(
      out.split("\n").filter((l) => l.startsWith("  daemon") || l.startsWith("  job")),
    ).toEqual([]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cliVersion } from "../src/cli/version.ts";
import {
  REPO_ROOT,
  dashboardFixture,
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

type Call = { argv: string; cwd: string };

/**
 * A fake package manager named `name` that appends each call's argv and cwd,
 * then exits `exit`, or 1 on the call `failOn` names.
 */
function fakeTool(
  name: "bun" | "npm",
  exit: number,
  failOn?: { argv: string; cwd?: string },
): { dir: string; calls(): Call[] } {
  const dir = tempDir(`crank-fake${name}-`);
  const log = path.join(dir, "calls");
  const match = failOn
    ? `[ "$*" = "${failOn.argv}" ]${failOn.cwd ? ` && [ "$(pwd -P)" = "${failOn.cwd}" ]` : ""}`
    : "false";
  fs.writeFileSync(
    path.join(dir, name),
    `#!/bin/sh\nprintf '%s\\t%s\\n' "$*" "$(pwd -P)" >> "${log}"\necho "${name} failed on purpose" >&2\nif ${match}; then exit 1; fi\nexit ${exit}\n`,
    { mode: 0o755 },
  );
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [argv, cwd] = l.split("\t");
            return { argv: argv!, cwd: cwd! };
          })
      : [];
  return { dir, calls };
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

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { cliVersion } from "../src/cli/version.ts";
import * as os from "node:os";
import {
  REPO_ROOT,
  type Call,
  childEnv,
  cleanup,
  dashboardFixture,
  fakeTool,
  makeCrankHome,
  makeInstalledCopy,
  makeModelHome,
  pack,
  releaseDir,
  runCli,
  runInstalled,
  startModelServer,
  startReleaseServer,
  tempDir,
} from "./helpers.ts";

const servers: Array<{ stop(): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  await cleanup();
});

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

const V = "1.0.0";
const TARBALL = "crank-mem.tar.gz";
type Installer = {
  R: string;
  H: string;
  HOME: string;
  bin: string;
  bun: { calls(): Call[] };
  server: { url: string; requests(): string[] };
  env: Record<string, string>;
};

/** A release dir served locally, a crank home with the model linked in, a temp HOME, and a runtime `fakeTool` bun on a bare PATH. */
async function installer(): Promise<Installer> {
  const R = releaseDir();
  const server = await startReleaseServer(R);
  servers.push(server);
  const H = makeModelHome();
  const HOME = tempDir("crank-home-dir-");
  const bun = fakeTool("bun", "runtime");
  const env = {
    CRANK_RELEASE_URL: server.url,
    CRANK_HOME: H,
    HOME,
    PATH: `${bun.dir}:/usr/bin:/bin`,
    SHELL: "/bin/zsh",
  };
  return { R, H, HOME, bin: path.join(HOME, "bin"), bun, server, env };
}

function run(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  cwd = os.tmpdir(),
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: childEnv(env),
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function installSh(args: string[], env: Record<string, string>) {
  return run("sh", [path.join(REPO_ROOT, "install.sh"), ...args], env);
}

function incoming(H: string): string[] {
  const dir = path.join(H, "versions");
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.startsWith(".incoming-"))
    : [];
}

describe("install.sh", () => {
  test("a fresh install of the latest release lays out the version, the link and the bin", async () => {
    const t = await installer();
    const result = installSh(["--yes", "--bin-dir", t.bin], t.env);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(fs.readlinkSync(path.join(t.H, "current"))).toBe(`versions/${V}`);
    expect(fs.readlinkSync(path.join(t.bin, "crank-mem"))).toBe(
      path.join(t.H, "current/bin/crank-mem"),
    );
    expect(t.bun.calls()).toContainEqual({
      argv: "install --production --frozen-lockfile",
      cwd: fs.realpathSync(path.join(t.H, "versions", V)),
    });
    expect(t.server.requests()).toContain(`/latest/download/${TARBALL}`);
    expect(t.server.requests()).toContain(`/latest/download/${TARBALL}.sha256`);
    expect(incoming(t.H)).toEqual([]);
  }, 60_000);

  test("the linked command works and inits projects against the stable link", async () => {
    const t = await installer();
    expect(installSh(["--yes", "--bin-dir", t.bin], t.env).status).toBe(0);
    const linked = path.join(t.bin, "crank-mem");
    expect(run(linked, ["--help"], t.env).status).toBe(0);
    const P = tempDir("crank-release-proj-");
    fs.writeFileSync(path.join(P, "a.ts"), "export const a = 1;\n");
    expect(spawnSync("git", ["init", "-q"], { cwd: P }).status).toBe(0);
    const init = run(linked, ["init", "--yes"], t.env, P);
    expect(init.stderr).not.toContain("error");
    expect(init.status).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(P, ".crank/config.json"), "utf-8"));
    expect(config.clone_root).toBe(path.join(t.H, "current"));
  }, 60_000);

  test("--to fetches the tagged release", async () => {
    const t = await installer();
    const result = installSh(["--to", `v${V}`, "--yes", "--bin-dir", t.bin], t.env);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(t.server.requests()).toContain(`/download/v${V}/${TARBALL}`);
  }, 60_000);

  test("a checksum mismatch installs nothing", async () => {
    const t = await installer();
    fs.writeFileSync(
      path.join(t.R, `latest/download/${TARBALL}.sha256`),
      `${"0".repeat(64)}  ${TARBALL}\n`,
    );
    const result = installSh(["--yes", "--bin-dir", t.bin], t.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum");
    expect(fs.existsSync(path.join(t.H, "versions", V))).toBe(false);
    expect(incoming(t.H)).toEqual([]);
    expect(fs.existsSync(path.join(t.H, "current"))).toBe(false);
  }, 60_000);

  test("no runtime stops before any download", async () => {
    const t = await installer();
    const result = installSh(["--yes", "--bin-dir", t.bin], { ...t.env, PATH: "/usr/bin:/bin" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("curl -fsSL https://bun.sh/install | bash");
    expect(t.server.requests()).toEqual([]);
  }, 60_000);

  test("a node older than 23.6 counts as no runtime", async () => {
    const t = await installer();
    const dir = tempDir("crank-oldnode-");
    fs.writeFileSync(path.join(dir, "node"), "#!/bin/sh\necho v22.11.0\n", { mode: 0o755 });
    const result = installSh(["--yes", "--bin-dir", t.bin], {
      ...t.env,
      PATH: `${dir}:/usr/bin:/bin`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("curl -fsSL https://bun.sh/install | bash");
    expect(t.server.requests()).toEqual([]);
  }, 60_000);

  test("reinstalling the same version keeps the existing version dir", async () => {
    const t = await installer();
    expect(installSh(["--yes", "--bin-dir", t.bin], t.env).status).toBe(0);
    const marker = path.join(t.H, "versions", V, "marker");
    fs.writeFileSync(marker, "kept");
    const again = installSh(["--yes", "--bin-dir", t.bin], t.env);
    expect(again.stderr).toBe("");
    expect(again.status).toBe(0);
    expect(fs.readdirSync(path.join(t.H, "versions"))).toEqual([V]);
    expect(fs.existsSync(marker)).toBe(true);
  }, 60_000);

  test("without --bin-dir the link lands in ~/.local/bin", async () => {
    const t = await installer();
    const result = installSh(["--yes"], t.env);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(fs.readlinkSync(path.join(t.HOME, ".local/bin/crank-mem"))).toBe(
      path.join(t.H, "current/bin/crank-mem"),
    );
  }, 60_000);
});

describe("self-install", () => {
  test("refuses to run from a clone", () => {
    // A temp HOME and a fake bun keep a regression from installing into the clone or ~/.local/bin.
    const bun = fakeTool("bun", 0);
    const result = runCli(tempDir("crank-selfinstall-"), ["self-install", "--yes"], {
      HOME: tempDir("crank-home-dir-"),
      PATH: `${bun.dir}:${process.env.PATH}`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("self-install runs from an installed copy");
    expect(bun.calls()).toEqual([]);
  });

  test("a release whose dashboard build is stamped for another version is refused before current moves", async () => {
    const t = await installer();
    const H2 = makeCrankHome();
    const copy = makeInstalledCopy(H2, V);
    fs.rmSync(path.join(H2, "current"));
    fs.writeFileSync(path.join(copy, "dashboard/dist/.crank-version"), "0.9.0");
    const result = run(path.join(copy, "bin/crank-mem"), ["self-install", "--yes"], {
      ...t.env,
      CRANK_HOME: H2,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dashboard build");
    expect(fs.existsSync(path.join(H2, "current"))).toBe(false);
  }, 60_000);

  test("a live tool lock refuses a second install, and a dead one is replaced", async () => {
    const t = await installer();
    expect(installSh(["--yes", "--bin-dir", t.bin], t.env).status).toBe(0);
    const launcher = path.join(t.H, "versions", V, "bin/crank-mem");
    const lock = path.join(t.H, "tool.lock");
    const args = ["self-install", "--yes", "--bin-dir", t.bin];
    fs.writeFileSync(lock, String(process.pid));
    const live = run(launcher, args, t.env);
    expect(live.stderr.trim()).toBe("crank-mem: another install or update is running");
    expect(live.status).toBe(1);
    expect(() => process.kill(999999, 0)).toThrow();
    fs.writeFileSync(lock, "999999");
    const dead = run(launcher, args, t.env);
    expect(dead.stderr).toBe("");
    expect(dead.status).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
  }, 60_000);

  test("an existing non-link crank-mem in the bin dir is left alone", async () => {
    const t = await installer();
    expect(installSh(["--yes", "--bin-dir", t.bin], t.env).status).toBe(0);
    const mine = path.join(t.bin, "crank-mem");
    fs.rmSync(mine);
    fs.writeFileSync(mine, "mine");
    const result = run(
      path.join(t.H, "versions", V, "bin/crank-mem"),
      ["self-install", "--yes", "--bin-dir", t.bin],
      t.env,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(mine);
    expect(fs.readFileSync(mine, "utf-8")).toBe("mine");
    expect(fs.readlinkSync(path.join(t.H, "current"))).toBe(`versions/${V}`);
  }, 60_000);

  test("a failed model download warns and still finishes the install", async () => {
    const H3 = makeCrankHome();
    const copy = makeInstalledCopy(H3, V);
    fs.rmSync(path.join(H3, "current"));
    const M = await startModelServer(tempDir("crank-nomodels-"), "stall");
    servers.push(M);
    const HOME = tempDir("crank-home-dir-");
    // `2>&1` puts the model warning (stderr) and the PATH offer (stdout) in one ordered stream.
    const result = run(
      "sh",
      [
        "-c",
        'exec "$0" "$@" 2>&1',
        path.join(copy, "bin/crank-mem"),
        "self-install",
        "--yes",
        "--bin-dir",
        path.join(HOME, "bin"),
        "--model-host",
        M.url,
        "--fetch-timeout-ms",
        "200",
      ],
      {
        CRANK_HOME: H3,
        HOME,
        PATH: `${fakeTool("bun", "runtime").dir}:${process.env.PATH}`,
        SHELL: "/bin/zsh",
      },
    );
    expect(result.status).toBe(0);
    const warning = result.stdout.indexOf("could not download the search model");
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(result.stdout).toContain("crank-mem setup");
    const offer = result.stdout.indexOf(`to PATH in ${path.join(HOME, ".zshrc")}`);
    expect(offer).toBeGreaterThan(warning);
    expect(fs.readlinkSync(path.join(H3, "current"))).toBe(`versions/${V}`);
    expect(fs.existsSync(path.join(HOME, "bin/crank-mem"))).toBe(true);
  }, 60_000);
});

describe("self-install PATH offer", () => {
  const exportLine = (bin: string) => `export PATH="${bin}:$PATH"`;
  const markers = (text: string) => text.split("# >>> crank-mem >>>").length - 1;

  test("with --yes the zsh rc file gains one block, and a second install leaves one", async () => {
    const t = await installer();
    expect(installSh(["--yes", "--bin-dir", t.bin], t.env).status).toBe(0);
    expect(installSh(["--yes", "--bin-dir", t.bin], t.env).status).toBe(0);
    const rc = fs.readFileSync(path.join(t.HOME, ".zshrc"), "utf-8");
    expect(markers(rc)).toBe(1);
    expect(rc).toContain(`\n${exportLine(t.bin)}\n`);
  }, 60_000);

  test("an existing rc file keeps its own lines", async () => {
    const t = await installer();
    fs.writeFileSync(path.join(t.HOME, ".zshrc"), "alias x=y\n");
    expect(installSh(["--yes", "--bin-dir", t.bin], t.env).status).toBe(0);
    expect(fs.readFileSync(path.join(t.HOME, ".zshrc"), "utf-8")).toBe(
      `alias x=y\n\n# >>> crank-mem >>>\n${exportLine(t.bin)}\n# <<< crank-mem <<<\n`,
    );
  }, 60_000);

  test("fish gets fish_add_path", async () => {
    const t = await installer();
    const result = installSh(["--yes", "--bin-dir", t.bin], { ...t.env, SHELL: "/usr/bin/fish" });
    expect(result.status).toBe(0);
    const rc = fs.readFileSync(path.join(t.HOME, ".config/fish/config.fish"), "utf-8");
    expect(rc).toContain(`# >>> crank-mem >>>\nfish_add_path ${t.bin}\n# <<< crank-mem <<<`);
  }, 60_000);

  test("bash picks the platform's file", async () => {
    const t = await installer();
    const result = installSh(["--yes", "--bin-dir", t.bin], { ...t.env, SHELL: "/bin/bash" });
    expect(result.status).toBe(0);
    const [used, unused] =
      process.platform === "darwin" ? [".bash_profile", ".bashrc"] : [".bashrc", ".bash_profile"];
    expect(fs.readFileSync(path.join(t.HOME, used), "utf-8")).toContain(exportLine(t.bin));
    expect(fs.existsSync(path.join(t.HOME, unused))).toBe(false);
  }, 60_000);

  test("without a tty and without --yes, no rc file changes and the line is printed", async () => {
    const t = await installer();
    const result = installSh(["--bin-dir", t.bin], t.env);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(t.HOME, ".zshrc"))).toBe(false);
    expect(result.stdout).toContain(exportLine(t.bin));
  }, 60_000);

  test("a bin dir already on PATH gets no offer", async () => {
    const t = await installer();
    const result = installSh(["--yes", "--bin-dir", t.bin], {
      ...t.env,
      PATH: `${t.bin}:${t.env.PATH}`,
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(t.HOME, ".zshrc"))).toBe(false);
    expect(result.stdout).not.toContain("export PATH=");
  }, 60_000);
});

describe("self-install from a clone install", () => {
  /** Behavior 6's setup: a fake clone K linked into the bin dir, and a project P whose config points at K. */
  async function cloneInstall() {
    const t = await installer();
    const K = tempDir("crank-fakeclone-");
    fs.mkdirSync(path.join(K, ".git"));
    fs.mkdirSync(path.join(K, "bin"));
    fs.symlinkSync(path.join(REPO_ROOT, "bin/crank-mem"), path.join(K, "bin/crank-mem"));
    fs.mkdirSync(t.bin, { recursive: true });
    fs.symlinkSync(path.join(K, "bin/crank-mem"), path.join(t.bin, "crank-mem"));
    const P = tempDir("crank-release-proj-");
    fs.writeFileSync(path.join(P, "a.ts"), "export const a = 1;\n");
    expect(spawnSync("git", ["init", "-q"], { cwd: P }).status).toBe(0);
    expect(runCli(P, ["init", "--yes"], { CRANK_HOME: t.H, HOME: t.HOME }).status).toBe(0);
    const configFile = path.join(P, ".crank/config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    fs.writeFileSync(configFile, JSON.stringify({ ...config, clone_root: K }, null, 2));
    const read = () => JSON.parse(fs.readFileSync(configFile, "utf-8"));
    return { ...t, K, P, config: read };
  }

  test("with --yes the clone link is replaced and every registered project is repointed", async () => {
    const t = await cloneInstall();
    const result = installSh(["--yes", "--bin-dir", t.bin], t.env);
    expect(result.status).toBe(0);
    expect(fs.readlinkSync(path.join(t.bin, "crank-mem"))).toBe(
      path.join(t.H, "current/bin/crank-mem"),
    );
    expect(result.stdout).toContain(path.join(t.K, "bin/crank-mem"));
    expect(t.config().clone_root).toBe(path.join(t.H, "current"));
    expect(t.config().vendored_version).toBe(V);
  }, 60_000);

  test("without --yes and a tty the link is replaced, projects stay, and the re-run is printed", async () => {
    const t = await cloneInstall();
    const result = installSh(["--bin-dir", t.bin], t.env);
    expect(result.status).toBe(0);
    expect(fs.readlinkSync(path.join(t.bin, "crank-mem"))).toBe(
      path.join(t.H, "current/bin/crank-mem"),
    );
    expect(t.config().clone_root).toBe(t.K);
    expect(result.stdout).toContain("crank-mem self-install --yes");
  }, 60_000);

  test("the printed re-run repoints the projects although the link is already in place", async () => {
    const t = await cloneInstall();
    expect(installSh(["--bin-dir", t.bin], t.env).status).toBe(0);
    const rerun = run(
      path.join(t.H, "versions", V, "bin/crank-mem"),
      ["self-install", "--yes", "--bin-dir", t.bin],
      t.env,
    );
    expect(rerun.status).toBe(0);
    expect(t.config().clone_root).toBe(path.join(t.H, "current"));
  }, 60_000);
});

describe("self-uninstall", () => {
  const rcWithBlock = (bin: string) =>
    `alias x=y\n\n# >>> crank-mem >>>\nexport PATH="${bin}:$PATH"\n# <<< crank-mem <<<\n`;

  /** An installed copy in H linked into HOME/bin, a zsh rc carrying the PATH block, and a project P inited through it. */
  function installedSetup() {
    const H = makeCrankHome();
    makeInstalledCopy(H, V);
    fs.mkdirSync(path.join(H, "models"));
    const HOME = tempDir("crank-home-dir-");
    const bin = path.join(HOME, "bin");
    fs.mkdirSync(bin);
    fs.symlinkSync(path.join(H, "current/bin/crank-mem"), path.join(bin, "crank-mem"));
    fs.writeFileSync(path.join(HOME, ".zshrc"), rcWithBlock(bin));
    const P = tempDir("crank-release-proj-");
    fs.writeFileSync(path.join(P, "a.ts"), "export const a = 1;\n");
    expect(spawnSync("git", ["init", "-q"], { cwd: P }).status).toBe(0);
    expect(runInstalled(H, P, ["init", "--yes"], { HOME }).status).toBe(0);
    const uninstall = (extra: string[] = []) =>
      runInstalled(
        H,
        tempDir("crank-selfuninstall-"),
        ["self-uninstall", ...extra, "--bin-dir", bin],
        {
          HOME,
        },
      );
    // Uninstall deletes the settings file once it holds nothing else; absent reads as empty.
    const settings = () => {
      const file = path.join(P, ".claude/settings.local.json");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    };
    return { H, HOME, bin, P, uninstall, settings };
  }

  test("with --yes every registered project is uninstalled, then the tool's files go", () => {
    const t = installedSetup();
    expect(t.settings()).toContain(".crank/hooks");
    const result = t.uninstall(["--yes"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(t.settings()).not.toContain(".crank/hooks");
    expect(fs.existsSync(path.join(t.P, ".crank/config.json"))).toBe(true);
    for (const gone of [path.join(t.H, "versions"), path.join(t.H, "current")]) {
      expect(fs.existsSync(gone)).toBe(false);
    }
    expect(() => fs.lstatSync(path.join(t.bin, "crank-mem"))).toThrow();
    expect(fs.readFileSync(path.join(t.HOME, ".zshrc"), "utf-8")).toBe("alias x=y\n");
    expect(fs.existsSync(path.join(t.H, "models"))).toBe(true);
  }, 60_000);

  test("without --yes and without a tty, projects stay wired and are listed", () => {
    const t = installedSetup();
    const result = t.uninstall();
    expect(result.status).toBe(0);
    expect(t.settings()).toContain(".crank/hooks");
    expect(result.stdout).toContain(fs.realpathSync(t.P));
    expect(fs.existsSync(path.join(t.H, "versions"))).toBe(false);
    expect(fs.existsSync(path.join(t.H, "current"))).toBe(false);
    expect(() => fs.lstatSync(path.join(t.bin, "crank-mem"))).toThrow();
  }, 60_000);

  test("--purge removes crank-mem's entries and nothing else", () => {
    const t = installedSetup();
    fs.writeFileSync(path.join(t.H, "config.toml"), "x");
    fs.mkdirSync(path.join(t.H, "bin"));
    fs.writeFileSync(path.join(t.H, "bin/askpass"), "");
    fs.writeFileSync(path.join(t.H, "crank.db"), "");
    for (const dir of ["spool", "seen"]) fs.mkdirSync(path.join(t.H, dir), { recursive: true });
    for (const file of ["projects.json", "dashboard.json", "update.json"]) {
      if (!fs.existsSync(path.join(t.H, file))) fs.writeFileSync(path.join(t.H, file), "{}");
    }
    const result = t.uninstall(["--yes", "--purge"]);
    expect(result.status).toBe(0);
    expect(fs.readdirSync(t.H).sort()).toEqual(["bin", "config.toml", "crank.db"]);
    expect(fs.readFileSync(path.join(t.H, "config.toml"), "utf-8")).toBe("x");
  }, 60_000);

  test("a PATH link that points somewhere other than <crank home>/current is left alone", () => {
    const t = installedSetup();
    const link = path.join(t.bin, "crank-mem");
    fs.rmSync(link);
    fs.symlinkSync("/elsewhere/crank-mem", link);
    const result = t.uninstall(["--yes"]);
    expect(result.status).toBe(0);
    expect(fs.readlinkSync(link)).toBe("/elsewhere/crank-mem");
    expect(result.stdout).toContain(link);
  }, 60_000);

  test("a live daemon is stopped", async () => {
    const t = installedSetup();
    const daemon = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const pid = daemon.pid!;
    try {
      fs.writeFileSync(
        path.join(t.H, "daemon.json"),
        JSON.stringify({ pid, version: V, heartbeatMs: Date.now() }),
      );
      expect(t.uninstall(["--yes"]).status).toBe(0);
      const deadline = Date.now() + 2_000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      daemon.kill("SIGKILL");
    }
  }, 60_000);

  test("refuses to run from a clone", () => {
    const result = runCli(tempDir("crank-selfuninstall-"), ["self-uninstall", "--yes"], {
      HOME: tempDir("crank-home-dir-"),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("self-uninstall runs from an installed copy");
  });

  test("a live tool lock refuses self-uninstall and leaves the install", () => {
    const t = installedSetup();
    fs.writeFileSync(path.join(t.H, "tool.lock"), String(process.pid));
    const result = t.uninstall(["--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("crank-mem: another install or update is running");
    expect(fs.existsSync(path.join(t.H, "versions", V))).toBe(true);
    expect(fs.existsSync(path.join(t.H, "current"))).toBe(true);
  }, 60_000);
});

describe("release script", () => {
  const SCRIPT = path.join(REPO_ROOT, "scripts/release.ts");
  const PKG =
    '{\n  "name": "fixture",\n  "version": "1.0.0",\n  "scripts": {\n    "typecheck": "true",\n    "format:check": "true",\n    "test": "TEST"\n  }\n}\n';

  /** A git env with a fixed identity and no user or system config, so no signing or hooks apply. */
  function gitEnv(): Record<string, string> {
    const config = path.join(tempDir("crank-gitcfg-"), "config");
    fs.writeFileSync(config, "");
    return {
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    };
  }

  /** A clone of a fresh bare `origin` holding one commit on main whose package.json is `pkg`. */
  function repo(testScript = "true"): {
    work: string;
    remote: string;
    env: Record<string, string>;
    git(cwd: string, ...args: string[]): string;
  } {
    const env = gitEnv();
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync("git", args, { cwd, env: childEnv(env), encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const remote = tempDir("crank-origin-");
    git(remote, "init", "--quiet", "--bare", "-b", "main");
    const work = tempDir("crank-work-");
    git(work, "init", "--quiet", "-b", "main");
    fs.writeFileSync(path.join(work, "package.json"), PKG.replace("TEST", testScript));
    git(work, "add", "package.json");
    git(work, "commit", "--quiet", "-m", "init");
    git(work, "remote", "add", "origin", remote);
    git(work, "push", "--quiet", "origin", "main");
    return { work, remote, env, git };
  }

  function release(work: string, env: Record<string, string>, ...args: string[]) {
    return spawnSync("bun", [SCRIPT, ...args], {
      cwd: work,
      env: childEnv(env),
      encoding: "utf-8",
    });
  }

  test("patch --yes bumps, commits, tags and pushes main and the tag together", () => {
    const r = repo();
    const run = release(r.work, r.env, "patch", "--yes");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("pushed v1.0.1");
    expect(r.git(r.remote, "rev-parse", "v1.0.1^{commit}")).toBe(
      r.git(r.remote, "rev-parse", "main"),
    );
    expect(r.git(r.remote, "log", "-1", "--format=%s", "main")).toBe("chore(release): v1.0.1");
    expect(r.git(r.remote, "show", "main:package.json") + "\n").toBe(
      PKG.replace("TEST", "true").replace('"1.0.0"', '"1.0.1"'),
    );
    expect(release(r.work, r.env, "minor", "--yes").status).toBe(0);
    expect(release(r.work, r.env, "v2.3.4", "--yes").status).toBe(0);
    expect(r.git(r.remote, "tag", "--list").split("\n")).toEqual(["v1.0.1", "v1.1.0", "v2.3.4"]);
  }, 30_000);

  test("each refusal leaves the repo and origin as they were", () => {
    const cases: Array<{
      name: string;
      args: string[];
      testScript?: string;
      prepare?(r: ReturnType<typeof repo>): void;
      stderr: string;
    }> = [
      { name: "no --yes and no tty", args: ["patch"], stderr: "not confirmed" },
      {
        name: "a failing gate",
        args: ["patch", "--yes"],
        testScript: "exit 1",
        stderr: "bun run test failed",
      },
      { name: "not newer", args: ["1.0.0", "--yes"], stderr: "is not newer than 1.0.0" },
      { name: "not a version", args: ["next", "--yes"], stderr: "usage:" },
      {
        name: "a dirty tracked file",
        args: ["patch", "--yes"],
        prepare: (r) => fs.appendFileSync(path.join(r.work, "package.json"), " "),
        stderr: "commit or stash",
      },
      {
        name: "off main",
        args: ["patch", "--yes"],
        prepare: (r) => r.git(r.work, "checkout", "--quiet", "-b", "side"),
        stderr: "check out main first",
      },
      {
        name: "the tag already on origin",
        args: ["patch", "--yes"],
        prepare: (r) => {
          r.git(r.work, "tag", "v1.0.1");
          r.git(r.work, "push", "--quiet", "origin", "v1.0.1");
          r.git(r.work, "tag", "-d", "v1.0.1");
        },
        stderr: "already exists on origin",
      },
      {
        name: "main behind origin",
        args: ["patch", "--yes"],
        prepare: (r) => {
          const other = tempDir("crank-other-");
          r.git(other, "clone", "--quiet", r.remote, ".");
          fs.writeFileSync(path.join(other, "x"), "x");
          r.git(other, "add", "x");
          r.git(other, "commit", "--quiet", "-m", "x");
          r.git(other, "push", "--quiet", "origin", "main");
        },
        stderr: "behind origin/main",
      },
    ];
    for (const c of cases) {
      const r = repo(c.testScript);
      c.prepare?.(r);
      const head = r.git(r.work, "rev-parse", "HEAD");
      const pkg = fs.readFileSync(path.join(r.work, "package.json"), "utf-8");
      const remoteMain = r.git(r.remote, "rev-parse", "main");
      const run = release(r.work, r.env, ...c.args);
      expect({ name: c.name, status: run.status }).toEqual({ name: c.name, status: 1 });
      expect(run.stderr).toContain(c.stderr);
      expect(r.git(r.work, "rev-parse", "HEAD")).toBe(head);
      expect(fs.readFileSync(path.join(r.work, "package.json"), "utf-8")).toBe(pkg);
      expect(r.git(r.work, "tag", "--list", "v1.0.1")).toBe("");
      expect(r.git(r.remote, "rev-parse", "main")).toBe(remoteMain);
      expect(r.git(r.remote, "tag", "--list", "v1.0.1")).toBe(
        c.name === "the tag already on origin" ? "v1.0.1" : "",
      );
    }
  }, 60_000);
});

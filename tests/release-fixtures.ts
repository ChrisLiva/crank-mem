import { expect } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { EMBED_MODEL, MODEL_FILES } from "../src/daemon/embedder.ts";
import { cliVersion } from "../src/cli/version.ts";
import { registerProject } from "../src/hooks/lib/registry.ts";
import { STOP_FILE } from "../src/hooks/lib/user-state.ts";
import {
  REPO_ROOT,
  children,
  childEnv,
  dashboardFixture,
  makeCrankHome,
  runCli,
  stopDigests,
  tempDir,
  withEnv,
  writeFiles,
  type CliRun,
} from "./helpers.ts";

export type Call = { argv: string; cwd: string };

/**
 * A fake package manager named `name` that appends each call's argv and cwd,
 * then exits `exit`, or 1 on the call `failOn` names. With `exit` "runtime" it
 * exits 0 for `install` and otherwise runs the test's own runtime with its
 * arguments, so the launcher's `exec bun` still runs the CLI.
 */
export function fakeTool(
  name: "bun" | "npm",
  exit: number | "runtime",
  failOn?: { argv: string; cwd?: string },
): { dir: string; calls(): Call[] } {
  const dir = tempDir(`crank-fake${name}-`);
  const log = path.join(dir, "calls");
  const match = failOn
    ? `[ "$*" = "${failOn.argv}" ]${failOn.cwd ? ` && [ "$(pwd -P)" = "${failOn.cwd}" ]` : ""}`
    : "false";
  const record = `printf '%s\\t%s\\n' "$*" "$(pwd -P)" >> "${log}"`;
  const body =
    exit === "runtime"
      ? `[ "$1" = install ] && exit 0\nexec '${process.execPath}' "$@"`
      : `echo "${name} failed on purpose" >&2\nif ${match}; then exit 1; fi\nexit ${exit}`;
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${record}\n${body}\n`, { mode: 0o755 });
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

/**
 * An installed copy of this repo at `<home>/versions/<version>`: `src/`, `bin/`, `bun.lock` and
 * `package.json` (its version set to `version`), the repo's `node_modules` linked in, and a
 * dashboard build stamped `version`. Points `<home>/current` at it and returns the version dir.
 */
export function makeInstalledCopy(home: string, version: string): string {
  const dir = path.join(home, "versions", version);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["src", "bin", "bun.lock"])
    fs.cpSync(path.join(REPO_ROOT, name), path.join(dir, name), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ ...pkg, version }, null, 2));
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"));
  fs.cpSync(path.join(dashboardFixture(version), "dist"), path.join(dir, "dashboard/dist"), {
    recursive: true,
  });
  // A rename replaces an existing link in one step, so a reader never finds `current` missing.
  const link = path.join(home, "current");
  const tmp = `${link}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(path.join("versions", version), tmp);
  fs.renameSync(tmp, link);
  return dir;
}

/**
 * Run `<home>/current/bin/crank-mem` in `cwd` with `home` as its crank home, a fresh CODEX_HOME,
 * and a runtime `fakeTool` bun first on PATH so no real `bun install` writes through the copy's linked node_modules.
 */
export function runInstalled(
  home: string,
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): CliRun {
  // `init` and `upgrade` start a daemon on files that await a parse; a stop state for the run keeps
  // that daemon out of tests that assert on release checks, pruning and daemon files.
  const quiet =
    (args[0] === "init" || args[0] === "upgrade") && !fs.existsSync(path.join(home, STOP_FILE));
  if (quiet) stopDigests(home);
  try {
    return spawnInstalled(home, cwd, args, env);
  } finally {
    if (quiet) fs.rmSync(path.join(home, STOP_FILE), { force: true });
  }
}

function spawnInstalled(
  home: string,
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): CliRun {
  const result = spawnSync(path.join(home, "current/bin/crank-mem"), args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: childEnv({
      CRANK_HOME: home,
      CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "crank-codexhome-")),
      PATH: `${fakeTool("bun", "runtime").dir}:${process.env.PATH}`,
      ...env,
    }),
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const initedTemplates = new Map<string, string>();

/**
 * A copy of a project inited once per process with `files`, timestamps kept. Only for tests that assert
 * nothing about the registry or Codex trust and run no `uninstall` and no `--restore`: init's backup
 * manifest names the template's path. The template lives outside `tempDir`, which `cleanup` empties.
 */
export function initedCopy(
  files: Record<string, string> = { "a.ts": "export const a = 1;\n" },
): string {
  const key = JSON.stringify(files);
  let template = initedTemplates.get(key);
  if (template === undefined) {
    template = fs.mkdtempSync(path.join(os.tmpdir(), "crank-template-"));
    writeFiles(template, files);
    // A home under a stop state: the template's daemon would parse it while it is copied.
    const home = makeCrankHome();
    stopDigests(home);
    expect(
      runCli(template, ["init", "--yes", "--codex", "skip"], { CRANK_HOME: home }).status,
    ).toBe(0);
    initedTemplates.set(key, template);
  }
  const copy = tempDir("crank-copy-");
  fs.cpSync(template, copy, { recursive: true, preserveTimestamps: true });
  return copy;
}

/** An `initedCopy` listed in `home`'s registry, as a realpath, since the dashboard hashes the root as listed. */
export function registeredCopy(home: string, files?: Record<string, string>): string {
  const root = fs.realpathSync(initedCopy(files));
  withEnv({ CRANK_HOME: home }, () => registerProject(root));
  return root;
}

/** The model `crank-mem setup` put in the real ~/.crank/models; read only, and it throws when the model is absent. */
export function realModelsDir(): string {
  const dir = path.join(os.homedir(), ".crank", "models");
  const missing = MODEL_FILES.filter((f) => !fs.existsSync(path.join(dir, EMBED_MODEL, f)));
  if (missing.length > 0) {
    throw new Error(
      `the local search model is missing ${missing.join(", ")} under ${dir}; run \`crank-mem setup\` once`,
    );
  }
  return dir;
}

/** A temp CRANK_HOME whose models entry is a symlink to realModelsDir(). */
export function makeModelHome(): string {
  const home = makeCrankHome();
  fs.symlinkSync(realModelsDir(), path.join(home, "models"));
  return home;
}

/**
 * Start `script` under this runtime with `args` plus `--log <file>`; it prints `PORT <n>` once
 * listening on 127.0.0.1 and appends each requested path to the log, which `requests()` lists.
 */
async function startFixtureServer(
  script: string,
  args: string[],
): Promise<{ url: string; requests(): string[]; stop(): void }> {
  const log = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "crank-fixturesrv-")),
    "requests.log",
  );
  fs.writeFileSync(log, "");
  const proc = spawn(process.execPath, [script, ...args, "--log", log], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stop = () => {
    proc.kill("SIGKILL");
  };
  const name = path.basename(script);
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`${name} did not print its port`)), 10_000);
    proc.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = /^PORT (\d+)\n/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`${name} exited before printing its port`));
    });
  }).catch((err) => {
    stop();
    throw err;
  });
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => fs.readFileSync(log, "utf-8").split("\n").filter(Boolean),
    stop,
  };
}

/** Start tests/fixtures/model-server.ts as a child serving `dir`; `requests()` lists the paths it was asked for. */
export function startModelServer(
  dir: string,
  mode: "ok" | "stall" | "slow",
): Promise<{ url: string; requests(): string[]; stop(): void }> {
  return startFixtureServer(path.join(REPO_ROOT, "tests/fixtures/model-server.ts"), [
    "--dir",
    dir,
    "--mode",
    mode,
  ]);
}

/** Start tests/fixtures/release-server.ts as a child answering `GET /<path>` with `<dir>/<path>`. */
export function startReleaseServer(
  dir: string,
  opts: { delayMs?: number } = {},
): Promise<{ url: string; requests(): string[]; stop(): void }> {
  return startFixtureServer(path.join(REPO_ROOT, "tests/fixtures/release-server.ts"), [
    "--dir",
    dir,
    ...(opts.delayMs === undefined ? [] : ["--delay-ms", String(opts.delayMs)]),
  ]);
}

type Pack = { status: number; stderr: string; out: string };

export function pack(dist: string, extra: string[] = []): Pack {
  const out = tempDir("crank-release-out-");
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/pack-release.ts"), "--out", out, "--dist", dist, ...extra],
    { cwd: tempDir("crank-release-cwd-"), encoding: "utf-8", timeout: 60_000, env: childEnv() },
  );
  return { status: result.status ?? -1, stderr: result.stderr, out };
}

const RELEASE_FILES = ["crank-mem.tar.gz", "crank-mem.tar.gz.sha256", "release.json"];
const packedReleases = new Map<string, string>();

/** The release files of `version`, packed once per process outside `tempDir`, which `cleanup` empties. */
function packedRelease(version: string): string {
  let dir = packedReleases.get(version);
  if (dir === undefined) {
    const run = pack(path.join(dashboardFixture(version), "dist"), ["--version", version]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crank-release-dir-"));
    for (const file of RELEASE_FILES) {
      fs.copyFileSync(path.join(run.out, file), path.join(dir, file));
    }
    packedReleases.set(version, dir);
  }
  return dir;
}

/**
 * A fresh release dir laid out like the release host: `download/v<V>/` for each of `versions`
 * and `latest/download/` holding `latest`. Each call returns its own copy, so a test may edit it.
 */
export function releaseDir(versions: string[] = ["1.0.0"], latest = versions[0]!): string {
  const copy = tempDir("crank-release-r-");
  const subs: Array<[string, string]> = [
    ...versions.map((v): [string, string] => [`download/v${v}`, v]),
    ["latest/download", latest],
  ];
  for (const [sub, version] of subs) {
    fs.cpSync(packedRelease(version), path.join(copy, sub), { recursive: true });
  }
  return copy;
}

/** `root` (a fresh temp dir by default) inited with `home` as its crank home, as a realpath. */
export function registeredProject(home: string, root = tempDir("crank-dash-proj-")): string {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
  expect(runCli(root, ["init", "--yes", "--codex", "skip"], { CRANK_HOME: home }).status).toBe(0);
  return fs.realpathSync(root);
}

/** The id the dashboard gives a project whose store sits in `<root>/.crank`. */
export function projectId(root: string): string {
  return crypto
    .createHash("sha256")
    .update(path.join(fs.realpathSync(root), ".crank"))
    .digest("hex")
    .slice(0, 12);
}

const STARTUP_LINE = /^crank-mem dashboard: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+))\n/;

/**
 * Start `crank-mem dashboard` as a child on `home` and wait for its startup line; with `bin`, the
 * child is that launcher (an installed copy's), which needs its own `dashboardDir`. `get` sends a
 * request with the session cookie and the Host the URL names unless `init` overrides them.
 */
export async function startDashboard(
  home: string,
  args: string[],
  opts: {
    open?: boolean;
    cwd?: string;
    env?: Record<string, string>;
    dashboardDir?: string;
    keep?: true;
    bin?: string;
  } = {},
): Promise<{
  url: string;
  token: string;
  get(path: string, init?: RequestInit): Promise<Response>;
  stop(signal?: "SIGTERM" | "SIGINT"): Promise<number>;
  output(): { stdout: string; stderr: string };
}> {
  const dashArgs = ["dashboard", ...(opts.open ? [] : ["--no-open"]), ...args];
  const child = spawn(
    opts.bin ?? process.execPath,
    opts.bin ? dashArgs : [path.join(REPO_ROOT, "src/cli/main.ts"), ...dashArgs],
    {
      cwd: opts.cwd ?? tempDir("crank-dash-cwd-"),
      env: childEnv({
        CRANK_HOME: home,
        CRANK_DASHBOARD_DIR: opts.dashboardDir ?? dashboardFixture(cliVersion()),
        ...opts.env,
      }),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!opts.keep) children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const closed = new Promise<number>((resolve) =>
    child.once("close", (code) => resolve(code ?? -1)),
  );
  const [url, port, token] = await new Promise<[string, number, string]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`dashboard did not print its startup line: ${stderr}`)),
      10_000,
    );
    const check = () => {
      const m = STARTUP_LINE.exec(stdout);
      if (!m) return;
      clearTimeout(timer);
      resolve([m[1]!, Number(m[2]), m[3]!]);
    };
    child.stdout!.on("data", check);
    void closed.then((code) => {
      clearTimeout(timer);
      reject(new Error(`dashboard exited ${code} before its startup line: ${stderr}`));
    });
  });
  return {
    url,
    token,
    get(p, init = {}) {
      const headers = new Headers({
        Host: `127.0.0.1:${port}`,
        Cookie: `crank_dashboard=${token}`,
      });
      new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      return fetch(`http://127.0.0.1:${port}${p}`, { redirect: "manual", ...init, headers });
    },
    stop(signal = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return closed;
    },
    output: () => ({ stdout, stderr }),
  };
}

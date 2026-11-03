import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  REPO_ROOT, makeCrankHome, makeModelHome, realModelsDir, runCli, startModelServer,
} from "./helpers.ts";

const MODEL_FILE = "Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A fake package manager named `name` that records its argv and cwd, then exits `exit`. */
function fakeTool(name: "bun" | "npm", exit: number): { dir: string; argv(): string | null; cwd(): string | null } {
  const dir = tempDir(`crank-fake${name}-`);
  fs.writeFileSync(
    path.join(dir, name),
    `#!/bin/sh\nprintf '%s' "$*" > "${dir}/argv"\npwd -P > "${dir}/cwd"\necho "${name} failed on purpose" >&2\nexit ${exit}\n`,
    { mode: 0o755 },
  );
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf-8").trim() : null);
  return { dir, argv: () => read("argv"), cwd: () => read("cwd") };
}

const servers: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

describe("setup", () => {
  test("installs with bun, downloads the model, and a second run downloads nothing", async () => {
    const bun = fakeTool("bun", 0);
    const home = makeCrankHome();
    const server = await startModelServer(realModelsDir(), "ok");
    servers.push(server);
    const env = { CRANK_HOME: home, PATH: `${bun.dir}:${process.env.PATH}` };
    const modelsDir = path.join(home, "models");

    const first = runCli(REPO_ROOT, ["setup", "--model-host", server.url], env);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(bun.argv()).toBe("install --frozen-lockfile");
    expect(bun.cwd()).toBe(fs.realpathSync(REPO_ROOT));
    expect(fs.statSync(path.join(modelsDir, MODEL_FILE)).size).toBe(fs.statSync(path.join(realModelsDir(), MODEL_FILE)).size);
    expect(first.stdout).toBe(
      `crank-mem: installed packages with bun\ncrank-mem: downloaded Xenova/all-MiniLM-L6-v2 to ${modelsDir}\n`,
    );

    const served = server.requests().length;
    expect(served).toBeGreaterThan(0);
    const second = runCli(REPO_ROOT, ["setup", "--model-host", server.url], env);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(`crank-mem: installed packages with bun\ncrank-mem: model already in ${modelsDir}\n`);
    expect(server.requests().length).toBe(served);
  });

  test("falls back to npm without a lockfile when bun is not on PATH", () => {
    const npm = fakeTool("npm", 0);
    const run = runCli(REPO_ROOT, ["setup"], { CRANK_HOME: makeModelHome(), PATH: npm.dir });
    expect(run.status).toBe(0);
    expect(npm.argv()).toBe("install --ignore-scripts --no-package-lock");
    expect(npm.cwd()).toBe(fs.realpathSync(REPO_ROOT));
    expect(run.stdout).toContain("crank-mem: installed packages with npm\ncrank-mem: model already in ");
  });

  test("an install failure exits 1 with the tool's last stderr line", () => {
    const bun = fakeTool("bun", 1);
    const run = runCli(REPO_ROOT, ["setup"], { CRANK_HOME: makeModelHome(), PATH: `${bun.dir}:${process.env.PATH}` });
    expect(run.status).toBe(1);
    expect(run.stderr).toBe("crank-mem: could not install packages (bun failed on purpose)\n");
    expect(run.stdout).toBe("");
  });

  test("with neither bun nor npm on PATH, the spawn error is the detail", () => {
    const run = runCli(REPO_ROOT, ["setup"], { CRANK_HOME: makeModelHome(), PATH: tempDir("crank-emptypath-") });
    expect(run.status).toBe(1);
    // The message is the runtime's own: node says `spawnSync npm ENOENT`, bun `Executable not found in $PATH: "npm"`.
    expect(run.stderr).toMatch(/^crank-mem: could not install packages \(.*npm.*\)\n$/);
  });

  for (const mode of ["stall", "slow"] as const) {
    test(`a ${mode} model host fails the download past the fetch timeout`, async () => {
      const bun = fakeTool("bun", 0);
      const server = await startModelServer(realModelsDir(), mode);
      servers.push(server);
      const started = Date.now();
      const run = runCli(REPO_ROOT, ["setup", "--model-host", server.url, "--fetch-timeout-ms", "500"], {
        CRANK_HOME: makeCrankHome(), PATH: `${bun.dir}:${process.env.PATH}`,
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("crank-mem: could not download the model (");
      expect(server.requests().length).toBeGreaterThan(0);
    });
  }
});

function initedProject(): string {
  const root = tempDir("crank-setup-");
  fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
  expect(runCli(root, ["init", "--yes", "--codex", "skip"]).status).toBe(0);
  return root;
}

describe("upgrade installs packages", () => {
  test("at the current version it runs the install and stays a no-op", () => {
    const root = initedProject();
    const bun = fakeTool("bun", 0);
    const run = runCli(root, ["upgrade"], { PATH: `${bun.dir}:${process.env.PATH}` });
    expect(run.status).toBe(0);
    expect(bun.argv()).toBe("install --frozen-lockfile");
    expect(run.stdout).toContain("already at");
    expect(run.stdout).not.toContain("installed packages");
    expect(run.stderr).toBe("");
  });

  test("an install failure warns and still exits 0", () => {
    const root = initedProject();
    const bun = fakeTool("bun", 1);
    const run = runCli(root, ["upgrade"], { PATH: `${bun.dir}:${process.env.PATH}` });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("crank-mem: could not install packages (bun failed on purpose)\n");
    expect(run.stdout).toContain("already at");
  });
});

const NOT_READY = "crank-mem: warning: search by meaning is not ready; run `crank-mem setup`.\n";

describe("digest on and the embedder", () => {
  test("warns when the model is absent and still turns digests on", () => {
    const root = initedProject();
    const run = runCli(root, ["digest", "on"], { CRANK_HOME: makeCrankHome() });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe(NOT_READY);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".crank/config.json"), "utf-8")).digest).toBe(true);
  });

  test("says nothing when the model is in place", () => {
    const root = initedProject();
    const run = runCli(root, ["digest", "on"], { CRANK_HOME: makeModelHome() });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
  });
});

describe("help", () => {
  test("lists setup and none of the hidden commands or flags", () => {
    const out = runCli(tempDir("crank-setup-help-"), ["--help"]).stdout;
    expect(out).toContain("  setup      Install packages and download the local search model\n");
    for (const flag of [
      "--model-host", "--fetch-timeout-ms", "--sweep-ms", "--idle-ms", "--retry-ms", "--retry-cap-ms", "--run-timeout-ms", "--once",
    ]) {
      expect(out).not.toContain(flag);
    }
    expect(out.split("\n").filter((l) => l.startsWith("  daemon") || l.startsWith("  job"))).toEqual([]);
  });
});

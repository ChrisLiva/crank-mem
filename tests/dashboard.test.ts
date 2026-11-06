import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type * as sqlite from "node:sqlite";
import { NO_MEMORY_NOTE } from "../src/cli/recall.ts";
import { cliVersion } from "../src/cli/version.ts";
import { loadConfig, saveConfig } from "../src/hooks/lib/config.ts";
import {
  MEMORY_NEWER_NOTE,
  MEMORY_UNREADABLE_NOTE,
  memoryPath,
  openMemory,
  type Memory,
} from "../src/hooks/lib/memory.ts";
import {
  cleanup,
  dashboardFixture,
  git,
  gitCommit,
  makeCrankHome,
  makeCrankProject,
  makeModelHome,
  plantMemory,
  plantVector,
  projectId,
  REPO_ROOT,
  registeredProject,
  runCli,
  seedMemory,
  startDashboard,
  stopDigests,
  tempDir,
  waitFor,
} from "./helpers.ts";

afterEach(cleanup);

const USAGE = "Usage: crank-mem dashboard [--port <n>] [--no-open]";
const NOT_BUILT = "crank-mem: the dashboard is not built — run `crank-mem setup`.\n";
const UNAUTHORIZED_BODY = "crank-mem dashboard: open the URL that `crank-mem dashboard` printed.\n";
const FORBIDDEN_HOST_BODY = "crank-mem dashboard: forbidden host.\n";
const STARTUP_URL = /^http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]{64})$/;
const FIXTURE_INDEX = path.join(REPO_ROOT, "tests/fixtures/dashboard-dist/index.html");
const FIXTURE_APP_JS = path.join(REPO_ROOT, "tests/fixtures/dashboard-dist/assets/app.js");

function registryFile(home: string): string {
  return path.join(home, "projects.json");
}

function registry(home: string): {
  version: number;
  projects: { root: string; addedAtMs: number }[];
} {
  return JSON.parse(fs.readFileSync(registryFile(home), "utf-8"));
}

async function projects(dash: Awaited<ReturnType<typeof startDashboard>>): Promise<unknown> {
  const res = await dash.get("/api/projects");
  expect([res.status, res.headers.get("content-type")]).toEqual([
    200,
    "application/json; charset=utf-8",
  ]);
  return res.json();
}

function portOf(url: string): number {
  return Number(STARTUP_URL.exec(url)![1]);
}

function tokenFile(home: string): string {
  return path.join(home, "dashboard.json");
}

/** Resolve once a server can listen on 127.0.0.1:`port`, then close it. */
function listenOn(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });
}

describe("dashboard command", () => {
  test("--help lists dashboard, and dashboard --help prints its usage and summary", () => {
    const dir = tempDir("crank-dash-help-");
    const list = runCli(dir, ["--help"]);
    expect(list.stdout).toContain("  dashboard       Serve the memory dashboard on localhost\n");
    const help = runCli(dir, ["dashboard", "--help"]);
    expect(help).toEqual({
      status: 0,
      stdout: `${USAGE}\n\nServe the memory dashboard on localhost.\n`,
      stderr: "",
    });
  });

  test("a bad --port prints the usage line before any build check, and writes nothing", () => {
    const dir = tempDir("crank-dash-port-");
    for (const value of [["abc"], ["-1"], ["65536"], ["1.5"], []]) {
      const home = makeCrankHome();
      const run = runCli(dir, ["dashboard", "--no-open", "--port", ...value], { CRANK_HOME: home });
      expect([value, run.status, run.stderr]).toEqual([value, 1, USAGE + "\n"]);
      expect(fs.readdirSync(home)).toEqual([]);
    }
    const home = makeCrankHome();
    const stale = runCli(dir, ["dashboard", "--no-open", "--port", "abc"], {
      CRANK_HOME: home,
      CRANK_DASHBOARD_DIR: dashboardFixture("0.0.1"),
    });
    expect([stale.status, stale.stderr]).toEqual([1, USAGE + "\n"]);
  });

  test("a stale or missing build refuses before writing the token file", () => {
    const dir = tempDir("crank-dash-build-");
    const missing = dashboardFixture(null);
    fs.rmSync(path.join(missing, "dist/index.html"));
    for (const dashboardDir of [dashboardFixture("0.0.1"), missing]) {
      const home = makeCrankHome();
      const run = runCli(dir, ["dashboard", "--no-open", "--port", "0"], {
        CRANK_HOME: home,
        CRANK_DASHBOARD_DIR: dashboardDir,
      });
      expect([run.status, run.stderr, run.stdout]).toEqual([1, NOT_BUILT, ""]);
      expect(fs.readdirSync(home)).toEqual([]);
    }
  });
});

describe("dashboard server", () => {
  test("--port 0 listens on 127.0.0.1 only and prints one startup line", async () => {
    const dash = await startDashboard(makeCrankHome(), ["--port", "0"]);
    expect(dash.url).toMatch(STARTUP_URL);
    const port = portOf(dash.url);
    expect(port).toBeGreaterThan(0);
    expect(dash.output().stdout).toBe(`crank-mem dashboard: ${dash.url}\n`);
    const v6 = await fetch(`http://[::1]:${port}/`).then(
      () => null,
      (err: { code?: string }) => err.code,
    );
    expect(v6).toBe("ECONNREFUSED");
  }, 20_000);

  test("with no --port it listens on 38700 plus the uid's last two digits", async () => {
    const expected = 38700 + (process.getuid!() % 100);
    try {
      const dash = await startDashboard(makeCrankHome(), []);
      expect(portOf(dash.url)).toBe(expected);
    } catch (err) {
      expect(String(err)).toMatch(
        new RegExp(
          `a dashboard already runs at http://127\\.0\\.0\\.1:${expected}/|port ${expected} is in use`,
        ),
      );
    }
  }, 20_000);

  test("the first run writes a 0600 token file, and later runs reuse it from any directory", async () => {
    const home = makeCrankHome();
    const first = await startDashboard(home, ["--port", "0"], {
      cwd: tempDir("crank-dash-plain-"),
    });
    const file = tokenFile(home);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ token: first.token });
    expect(await first.stop()).toBe(0);

    const second = await startDashboard(home, ["--port", "0"], { cwd: makeCrankProject() });
    expect(second.token).toBe(first.token);
    expect((await second.get(`/?token=${first.token}`, { headers: { Cookie: "" } })).status).toBe(
      303,
    );
    expect(await second.stop()).toBe(0);

    const seen = [first.token];
    for (const bad of ["not json", "{}", '{"token":"abc"}']) {
      fs.writeFileSync(file, bad);
      const dash = await startDashboard(home, ["--port", "0"]);
      expect(dash.token).toMatch(/^[0-9a-f]{64}$/);
      expect(seen).not.toContain(dash.token);
      seen.push(dash.token);
      expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ token: dash.token });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      await dash.stop();
    }
  }, 30_000);

  test("the URL's token trades for an HttpOnly cookie, and a wrong token is refused", async () => {
    const dash = await startDashboard(makeCrankHome(), ["--port", "0"]);
    const good = await dash.get(`/?token=${dash.token}`, { headers: { Cookie: "" } });
    expect(good.status).toBe(303);
    expect(good.headers.get("location")).toBe("/");
    expect(good.headers.get("set-cookie")).toBe(
      `crank_dashboard=${dash.token}; HttpOnly; SameSite=Strict; Path=/`,
    );
    const bad = await dash.get(`/?token=${"0".repeat(64)}`, { headers: { Cookie: "" } });
    expect(bad.status).toBe(401);
  }, 20_000);

  test("a request without the cookie is refused, and the cookie serves index.html", async () => {
    const dash = await startDashboard(makeCrankHome(), ["--port", "0"]);
    for (const p of ["/", "/api/projects", "/assets/app.js"]) {
      for (const cookie of ["", "crank_dashboard=abc", `crank_dashboard=${"0".repeat(64)}`]) {
        const res = await dash.get(p, { headers: { Cookie: cookie } });
        expect([p, cookie, res.status, res.headers.get("content-type"), await res.text()]).toEqual([
          p,
          cookie,
          401,
          "text/plain; charset=utf-8",
          UNAUTHORIZED_BODY,
        ]);
      }
    }
    const index = fs.readFileSync(FIXTURE_INDEX);
    for (const cookie of [
      `crank_dashboard=${dash.token}`,
      `other=1; crank_dashboard=${dash.token}`,
    ]) {
      const res = await dash.get("/", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(index)).toBe(true);
    }
  }, 20_000);

  test("a Host other than 127.0.0.1 or localhost on the port is refused before the cookie check", async () => {
    const dash = await startDashboard(makeCrankHome(), ["--port", "0"]);
    const port = portOf(dash.url);
    for (const host of ["evil.example:80", "127.0.0.1", "localhost:1"]) {
      const res = await dash.get("/", { headers: { Host: host } });
      expect([host, res.status, await res.text()]).toEqual([host, 403, FORBIDDEN_HOST_BODY]);
    }
    const local = await dash.get("/", { headers: { Host: `localhost:${port}` } });
    expect(local.status).toBe(200);
  }, 20_000);

  test("a method other than GET or HEAD gets 405, checked after Host and before the cookie", async () => {
    const dash = await startDashboard(makeCrankHome(), ["--port", "0"]);
    const post = await dash.get("/", { method: "POST", headers: { Cookie: "" } });
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET, HEAD"]);
    const health = await dash.get("/api/projects/zzzzzzzzzzzz/health", { headers: { Cookie: "" } });
    expect(health.status).toBe(401);
    const put = await dash.get("/", { method: "PUT", headers: { Host: "evil.example:80" } });
    expect(put.status).toBe(403);
  }, 20_000);

  test("every response carries the security headers, and index.html and /api/ carry no-store", async () => {
    const dash = await startDashboard(makeCrankHome(), ["--port", "0"]);
    const samples: Array<[number, string, RequestInit]> = [
      [200, "/", {}],
      [303, `/?token=${dash.token}`, { headers: { Cookie: "" } }],
      [401, "/", { headers: { Cookie: "" } }],
      [403, "/", { headers: { Host: "evil.example:80" } }],
      [404, "/nope.js", {}],
      [405, "/", { method: "POST" }],
    ];
    for (const [status, p, init] of samples) {
      const res = await dash.get(p, init);
      expect([
        res.status,
        res.headers.get("x-frame-options"),
        res.headers.get("x-content-type-options"),
        res.headers.get("content-security-policy"),
      ]).toEqual([status, "DENY", "nosniff", "default-src 'self'; frame-ancestors 'none'"]);
    }
    for (const p of ["/", "/api/projects"]) {
      expect([p, (await dash.get(p)).headers.get("cache-control")]).toEqual([p, "no-store"]);
    }
  }, 20_000);

  test("the static handler serves files under dist only, typed by extension", async () => {
    const dashboardDir = dashboardFixture(cliVersion());
    fs.writeFileSync(path.join(dashboardDir, "package.json"), "{}");
    fs.writeFileSync(path.join(dashboardDir, "dist/assets/app.css"), "body{}");
    const dash = await startDashboard(makeCrankHome(), ["--port", "0"], { dashboardDir });
    for (const p of [
      "/..%2fpackage.json",
      "/assets/..%2f..%2fpackage.json",
      "/%E0%A4%A",
      "/assets",
      "/nope.js",
    ]) {
      expect([p, (await dash.get(p)).status]).toEqual([p, 404]);
    }
    const js = await dash.get("/assets/app.js");
    expect([js.status, js.headers.get("content-type")]).toEqual([
      200,
      "text/javascript; charset=utf-8",
    ]);
    expect(Buffer.from(await js.arrayBuffer()).equals(fs.readFileSync(FIXTURE_APP_JS))).toBe(true);
    for (const [p, type] of [
      ["/", "text/html; charset=utf-8"],
      ["/assets/app.css", "text/css; charset=utf-8"],
    ]) {
      const res = await dash.get(p!);
      expect([p, res.status, res.headers.get("content-type")]).toEqual([p, 200, type]);
    }
  }, 20_000);

  test("HEAD answers GET's status and headers with an empty body", async () => {
    const dash = await startDashboard(makeCrankHome(), ["--port", "0"]);
    const get = await dash.get("/assets/app.js");
    const head = await dash.get("/assets/app.js", { method: "HEAD" });
    expect([head.status, head.headers.get("content-type"), await head.text()]).toEqual([
      get.status,
      get.headers.get("content-type"),
      "",
    ]);
    expect(get.status).toBe(200);
  }, 20_000);

  test("SIGTERM and SIGINT each exit 0, free the port and leave the token file alone", async () => {
    const home = makeCrankHome();
    await (await startDashboard(home, ["--port", "0"])).stop();
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const before = fs.readFileSync(tokenFile(home));
      const dash = await startDashboard(home, ["--port", "0"]);
      expect((await dash.get("/")).status).toBe(200);
      expect([signal, await dash.stop(signal)]).toEqual([signal, 0]);
      await listenOn(portOf(dash.url));
      expect(fs.readFileSync(tokenFile(home)).equals(before)).toBe(true);
    }
  }, 30_000);

  test("a second run on a dashboard's port says the dashboard already runs", async () => {
    const home = makeCrankHome();
    const dash = await startDashboard(home, ["--port", "0"]);
    const port = portOf(dash.url);
    const run = runCli(
      tempDir("crank-dash-second-"),
      ["dashboard", "--no-open", "--port", String(port)],
      {
        CRANK_HOME: home,
      },
    );
    expect([run.status, run.stderr, run.stdout]).toEqual([
      1,
      `crank-mem: a dashboard already runs at http://127.0.0.1:${port}/\n`,
      "",
    ]);
    expect((await dash.get("/")).status).toBe(200);
  }, 20_000);

  test("a run on a port something else holds says the port is in use", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const run = runCli(
        tempDir("crank-dash-held-"),
        ["dashboard", "--no-open", "--port", String(port)],
        {
          CRANK_HOME: makeCrankHome(),
        },
      );
      expect([run.status, run.stderr, run.stdout]).toEqual([
        1,
        `crank-mem: port ${port} is in use; pass --port <n>.\n`,
        "",
      ]);
    } finally {
      server.close();
    }
  }, 20_000);

  test("without --no-open it opens the URL, and a failed launch prints nothing extra", async () => {
    const bin = tempDir("crank-dash-bin-");
    const opened = path.join(bin, "opened");
    for (const name of ["open", "xdg-open"]) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s' "$*" > "${opened}"\n`, {
        mode: 0o755,
      });
    }
    const dash = await startDashboard(makeCrankHome(), ["--port", "0"], {
      open: true,
      env: { PATH: bin },
    });
    await waitFor(() => fs.existsSync(opened) && fs.readFileSync(opened, "utf-8") !== "");
    expect(fs.readFileSync(opened, "utf-8")).toBe(dash.url);
    await dash.stop();

    const bare = await startDashboard(makeCrankHome(), ["--port", "0"], {
      open: true,
      env: { PATH: tempDir("crank-dash-nobin-") },
    });
    expect((await bare.get("/")).status).toBe(200);
    expect(await bare.stop()).toBe(0);
    expect(bare.output()).toEqual({ stdout: `crank-mem dashboard: ${bare.url}\n`, stderr: "" });
  }, 20_000);
});

describe("project registry", () => {
  test("init registers the root, and each upgrade keeps exactly one entry for it", () => {
    const home = makeCrankHome();
    const root = registeredProject(home);
    for (let i = 0; i < 2; i++) {
      expect(runCli(root, ["upgrade"], { CRANK_HOME: home }).status).toBe(0);
    }
    const file = registry(home);
    expect(file.version).toBe(1);
    expect(file.projects.map((p) => p.root)).toEqual([root]);
    expect(typeof file.projects[0]!.addedAtMs).toBe("number");
  });

  test("uninstall with --keep-crank or --delete-crank removes only its own root", () => {
    for (const flag of ["--keep-crank", "--delete-crank"]) {
      const home = makeCrankHome();
      const gone = registeredProject(home);
      const kept = registeredProject(home);
      const run = runCli(gone, ["uninstall", "--yes", flag], { CRANK_HOME: home });
      expect([flag, run.status]).toEqual([flag, 0]);
      expect([flag, registry(home).projects.map((p) => p.root)]).toEqual([flag, [kept]]);
    }
  });

  test("a registry write that fails leaves init's status and output as they are", () => {
    const fileHome = path.join(tempDir("crank-dash-filehome-"), "home");
    fs.writeFileSync(fileHome, "");
    const runs = [makeCrankHome(), fileHome].map((home) => {
      const root = tempDir("crank-dash-proj-");
      fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
      return runCli(root, ["init", "--yes", "--codex", "skip"], { CRANK_HOME: home });
    });
    expect(runs[1]).toEqual(runs[0]!);
    expect(runs[1]!.status).toBe(0);
  });

  test("GET /api/projects lists inited roots by name, then root, with id, store status and dot", async () => {
    const home = makeCrankHome();
    const b = registeredProject(home, tempDir("crank-b-"));
    const a = registeredProject(home, tempDir("crank-a-"));
    seedMemory(a, [{ title: "seeded" }]);
    const tieParent = tempDir("crank-dash-tie-");
    const ties = ["p2", "p1"]
      .map((p) => registeredProject(home, path.join(tieParent, p, "same")))
      .reverse();
    const dash = await startDashboard(home, ["--port", "0"]);
    const entry = (root: string, memory: string, dot: string) => ({
      id: projectId(root),
      name: path.basename(root),
      root,
      memory,
      dot,
    });
    expect(await projects(dash)).toEqual({
      projects: [
        entry(a, "open", "grey"),
        entry(b, "missing", "amber"),
        ...ties.map((root) => entry(root, "missing", "amber")),
      ],
    });
  }, 20_000);

  test("roots sharing a store list once under the main checkout, and a root without config drops", async () => {
    const home = makeCrankHome();
    const tmp = tempDir("crank-dash-git-");
    const main = path.join(tmp, "main");
    fs.mkdirSync(main);
    fs.writeFileSync(path.join(main, "a.ts"), "export const a = 1;\n");
    git(main, "init", "-q");
    const init = runCli(main, ["init", "--git", "commit", "--yes", "--codex", "skip"], {
      CRANK_HOME: home,
    });
    expect(init.status).toBe(0);
    gitCommit(main, "init");
    const worktree = path.join(tmp, "wt");
    git(main, "worktree", "add", "-q", worktree);
    expect(runCli(worktree, ["upgrade"], { CRANK_HOME: home }).status).toBe(0);
    const standalone = registeredProject(home);
    expect(registry(home).projects.map((p) => p.root)).toEqual([
      fs.realpathSync(main),
      fs.realpathSync(worktree),
      standalone,
    ]);

    const dash = await startDashboard(home, ["--port", "0"]);
    const roots = async () =>
      ((await projects(dash)) as { projects: { root: string }[] }).projects.map((p) => p.root);
    expect(await roots()).toEqual([standalone, fs.realpathSync(main)]);
    const before = fs.readFileSync(registryFile(home));
    fs.rmSync(path.join(standalone, ".crank/config.json"));
    expect(await roots()).toEqual([fs.realpathSync(main)]);
    expect(fs.readFileSync(registryFile(home)).equals(before)).toBe(true);
  }, 20_000);

  test("the dot follows the store, the project's digest setting and the recorded stop", async () => {
    const home = makeCrankHome();
    const root = registeredProject(home, tempDir("crank-a-"));
    const newer = registeredProject(home, tempDir("crank-b-"));
    seedMemory(root, [{ title: "seeded" }]);
    plantMemory(newer, "newer");
    const crankDir = path.join(root, ".crank");
    const dash = await startDashboard(home, ["--port", "0"]);
    const states = async () =>
      ((await projects(dash)) as { projects: { memory: string; dot: string }[] }).projects.map(
        (p) => [p.memory, p.dot],
      );
    saveConfig(crankDir, { ...loadConfig(crankDir), digest: true });
    expect(await states()).toEqual([
      ["open", "green"],
      ["newer", "amber"],
    ]);
    stopDigests(home);
    expect((await states())[0]).toEqual(["open", "amber"]);
    saveConfig(crankDir, { ...loadConfig(crankDir), digest: false });
    expect((await states())[0]).toEqual(["open", "grey"]);
  }, 20_000);

  test("a missing, unparsable or all-dropped registry answers an empty list", async () => {
    const home = makeCrankHome();
    const dash = await startDashboard(home, ["--port", "0"]);
    const body = async () => (await dash.get("/api/projects")).text();
    expect(await body()).toBe('{"projects":[]}');
    fs.writeFileSync(registryFile(home), "not json");
    expect(await body()).toBe('{"projects":[]}');
    const gone = tempDir("crank-dash-gone-");
    fs.writeFileSync(
      registryFile(home),
      JSON.stringify({ version: 1, projects: [{ root: gone, addedAtMs: 1 }] }),
    );
    expect(await body()).toBe('{"projects":[]}');
  }, 20_000);

  test("a project-scoped route for an id no listed project has answers 404", async () => {
    const home = makeCrankHome();
    registeredProject(home);
    const dash = await startDashboard(home, ["--port", "0"]);
    expect((await dash.get("/api/projects/000000000000/health")).status).toBe(404);
  }, 20_000);
});

type Line = { id: number; createdAtMs: number; type: string; title: string; stale: boolean };

/** GET a project's Memory route and parse its 200 JSON body. */
async function memoryJson(
  dash: Awaited<ReturnType<typeof startDashboard>>,
  root: string,
  route: string,
): Promise<any> {
  const res = await dash.get(`/api/projects/${projectId(root)}/${route}`);
  expect([route, res.status, res.headers.get("content-type")]).toEqual([
    route,
    200,
    "application/json; charset=utf-8",
  ]);
  return res.json();
}

describe("memory view", () => {
  test("observations page 50 lines newest first, and next pages strictly older lines", async () => {
    const home = makeCrankHome();
    const root = registeredProject(home);
    const ids = seedMemory(
      root,
      Array.from({ length: 60 }, (_, i) => ({ title: `Line ${i}` })),
    );
    const dash = await startDashboard(home, ["--port", "0"]);
    const page1 = await memoryJson(dash, root, "observations");
    const created = page1.rows[0].createdAtMs;
    expect(typeof created).toBe("number");
    expect(page1).toEqual({
      rows: ids
        .slice(10)
        .reverse()
        .map((id) => ({
          id,
          createdAtMs: created,
          type: "discovery",
          title: `Line ${ids.indexOf(id)}`,
          stale: false,
        })),
      next: `${created}:${ids[10]}`,
    });
    const page2 = await memoryJson(dash, root, `observations?before=${page1.next}`);
    expect(page2).toEqual({
      rows: ids
        .slice(0, 10)
        .reverse()
        .map((id) => ({
          id,
          createdAtMs: created,
          type: "discovery",
          title: `Line ${ids.indexOf(id)}`,
          stale: false,
        })),
      next: null,
    });
  }, 20_000);

  test("type, file and stale narrow the list, and stale rows stay out without stale=1", async () => {
    const home = makeCrankHome();
    const root = registeredProject(home);
    const [bugfix, feature, flagged] = seedMemory(root, [
      { type: "bugfix", title: "Fix a", filesRead: ["src/a.ts"] },
      { type: "feature", title: "Add b" },
      { type: "decision", title: "Old c" },
    ]);
    seedMemory(root, [], { stale: [{ id: flagged!, reason: "c changed" }] });
    const dash = await startDashboard(home, ["--port", "0"]);
    const ids = async (query: string) =>
      ((await memoryJson(dash, root, `observations${query}`)).rows as Line[]).map((l) => [
        l.id,
        l.stale,
      ]);
    expect(await ids("?type=bugfix")).toEqual([[bugfix!, false]]);
    expect(await ids("?file=src/a.ts")).toEqual([[bugfix!, false]]);
    expect(await ids("")).toEqual([
      [feature!, false],
      [bugfix!, false],
    ]);
    expect(await ids("?stale=1")).toEqual([
      [flagged!, true],
      [feature!, false],
      [bugfix!, false],
    ]);
  }, 20_000);

  test("q searches with the filters, ignores a well-formed before, and names the mode", async () => {
    const home = makeModelHome();
    const keyword = registeredProject(home);
    const [, walrus] = seedMemory(keyword, [
      { type: "bugfix", title: "Lock retry on EEXIST" },
      { type: "bugfix", title: "Walrus cache warms" },
      { type: "feature", title: "Walrus import added" },
    ]);
    const hybrid = registeredProject(makeCrankHome());
    expect(runCli(hybrid, ["upgrade"], { CRANK_HOME: home }).status).toBe(0);
    const [planted] = seedMemory(hybrid, [{ title: "Walrus vectors" }]);
    plantVector(hybrid, planted!);
    const dash = await startDashboard(home, ["--port", "0"]);
    const found = await memoryJson(dash, keyword, "observations?q=walrus&type=bugfix&before=1:1");
    expect([found.rows.map((l: Line) => l.id), found.next, found.mode]).toEqual([
      [walrus],
      null,
      "keyword",
    ]);
    const byMeaning = await memoryJson(dash, hybrid, "observations?q=walrus");
    expect([byMeaning.rows.map((l: Line) => l.id), byMeaning.next, byMeaning.mode]).toEqual([
      [planted],
      null,
      "hybrid",
    ]);
  }, 30_000);

  test("an observation's route answers its whole record, 404 for an unknown id and 400 for a bad one", async () => {
    const home = makeCrankHome();
    const root = registeredProject(home);
    const given = {
      type: "decision" as const,
      title: "Keep retries at 5 s ✓",
      narrative: "Retries stay at 5 s — “why”: load.",
      facts: ["5 s backoff", "max 3 tries"],
      filesRead: ["src/a.ts", "src/b.ts"],
      filesModified: ["src/c.ts"],
    };
    const [id] = seedMemory(root, [given]);
    seedMemory(root, [], { stale: [{ id: id!, reason: "retry is 6 s now" }] });
    const dash = await startDashboard(home, ["--port", "0"]);
    expect(await memoryJson(dash, root, `observations/${id}`)).toEqual({
      ...given,
      id,
      createdAtMs: expect.any(Number),
      stale: true,
      sessionId: expect.stringMatching(/^seed-\d+$/),
      staleFlag: { atMs: expect.any(Number), reason: "retry is 6 s now" },
    });
    for (const [oid, status] of [
      [String(id! + 1), 404],
      ["abc", 400],
      ["1.5", 400],
      ["", 400],
    ] as const) {
      const res = await dash.get(`/api/projects/${projectId(root)}/observations/${oid}`);
      expect([oid, res.status]).toEqual([oid, status]);
    }
  }, 20_000);

  test("a malformed before, an unknown type or a blank q answers 400, with or without q", async () => {
    const home = makeCrankHome();
    const root = registeredProject(home);
    seedMemory(root, [{ title: "Walrus cache warms" }]);
    const dash = await startDashboard(home, ["--port", "0"]);
    for (const query of [
      "before=x",
      "before=1",
      "before=",
      "type=nope",
      "q=%20",
      "q=",
      "q=walrus&before=x",
      "q=walrus&type=nope",
    ]) {
      const res = await dash.get(`/api/projects/${projectId(root)}/observations?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
    }
  }, 20_000);

  test("a store that does not open answers both routes with its note, and another project still answers lines", async () => {
    const home = makeCrankHome();
    const missing = registeredProject(home);
    const newer = registeredProject(home);
    plantMemory(newer, "newer");
    const unreadable = registeredProject(home);
    plantMemory(unreadable, "unreadable");
    const seeded = registeredProject(home);
    const [id] = seedMemory(seeded, [{ title: "Still here" }]);
    const dash = await startDashboard(home, ["--port", "0"]);
    for (const [root, note] of [
      [missing, NO_MEMORY_NOTE],
      [newer, MEMORY_NEWER_NOTE],
      [unreadable, MEMORY_UNREADABLE_NOTE],
    ] as const) {
      for (const route of ["observations", "observations/1"]) {
        expect(await memoryJson(dash, root, route)).toEqual({ note });
      }
    }
    const lines = (await memoryJson(dash, seeded, "observations")).rows as Line[];
    expect(lines.map((l) => [l.id, l.title])).toEqual([[id!, "Still here"]]);
  }, 20_000);

  test("a route that throws after its store opens answers 500, and the server keeps serving", async () => {
    const home = makeCrankHome();
    const root = registeredProject(home);
    const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite;
    const db = new mod.DatabaseSync(path.join(root, ".crank/memory.db"));
    db.exec("PRAGMA user_version = 2");
    db.close();
    const dash = await startDashboard(home, ["--port", "0"]);
    expect(((await projects(dash)) as { projects: { memory: string }[] }).projects).toEqual([
      expect.objectContaining({ memory: "open" }),
    ]);
    for (const route of ["observations", "observations?q=walrus", "observations/1"]) {
      const res = await dash.get(`/api/projects/${projectId(root)}/${route}`);
      expect([
        route,
        res.status,
        res.headers.get("content-type"),
        res.headers.get("x-frame-options"),
        res.headers.get("x-content-type-options"),
        res.headers.get("content-security-policy"),
        await res.text(),
      ]).toEqual([
        route,
        500,
        "text/plain; charset=utf-8",
        "DENY",
        "nosniff",
        "default-src 'self'; frame-ancestors 'none'",
        "crank-mem dashboard: internal error.\n",
      ]);
      expect((await dash.get("/api/projects")).status).toBe(200);
    }
  }, 20_000);
});

type ProposalJson = {
  id: number;
  kind: string;
  bullet: string;
  state: string;
  reason: string | null;
  createdAtMs: number;
  decidedAtMs: number | null;
};

/** Run `fn` on the project's store opened for writing, then close it. */
function withWritable(root: string, fn: (memory: Memory) => void): void {
  const opened = openMemory(memoryPath(root), "write");
  if (opened.status !== "open") throw new Error(`store is ${opened.status}`);
  try {
    fn(opened.memory);
  } finally {
    opened.memory.close();
  }
}

describe("curation view", () => {
  test("proposals, stale flags and consolidation runs page 50 newest first, and a run's decisions show", async () => {
    const home = makeCrankHome();
    const root = registeredProject(home);
    const bullets = Array.from({ length: 55 }, (_, i) => `- **Rule ${i}**: keep é—日本 ${i}`);
    seedMemory(root, [], {
      proposals: bullets.map((bullet, i) => ({
        kind: i % 2 === 0 ? ("memory" as const) : ("preference" as const),
        bullet,
      })),
    });
    const dash = await startDashboard(home, ["--port", "0"]);

    const page1 = await memoryJson(dash, root, "proposals");
    const rows1 = page1.rows as ProposalJson[];
    const created = rows1[0]!.createdAtMs;
    expect(typeof created).toBe("number");
    const all = rows1.map((r) => r.id);
    expect(all).toEqual([...all].sort((a, b) => b - a));
    expect(rows1).toEqual(
      bullets
        .slice(5)
        .reverse()
        .map((bullet, i) => ({
          id: all[i]!,
          kind: bullets.indexOf(bullet) % 2 === 0 ? "memory" : "preference",
          bullet,
          state: "pending",
          reason: null,
          createdAtMs: created,
          decidedAtMs: null,
        })),
    );
    expect(page1.next).toBe(String(all[49]));
    const page2 = await memoryJson(dash, root, `proposals?before=${page1.next}`);
    expect([(page2.rows as ProposalJson[]).map((r) => r.bullet), page2.next]).toEqual([
      bullets.slice(0, 5).reverse(),
      null,
    ]);

    const [p1, p2, p3] = all as [number, number, number];
    let runs = 0;
    withWritable(root, (memory) => {
      memory.recordConsolidation({
        outcome: "ok",
        startedMs: 1,
        model: "m",
        costUsd: 0,
        sent: [p1, p2],
        decided: [
          { id: p1, state: "accepted", reason: "fits" },
          { id: p2, state: "rejected", reason: "dup" },
        ],
        verdicts: [],
      });
      for (let i = 0; i < 3; i++) {
        memory.recordConsolidation({
          outcome: "retry",
          startedMs: 2 + i,
          model: null,
          costUsd: 0,
          sent: [p3],
        });
      }
      runs += 4;
    });
    const inState = async (query: string) =>
      (await memoryJson(dash, root, `proposals?${query}`)) as {
        rows: ProposalJson[];
        next: string | null;
      };
    const accepted = await inState("state=accepted");
    expect(accepted).toEqual({
      rows: [
        {
          ...rows1[0]!,
          state: "accepted",
          reason: "fits",
          decidedAtMs: expect.any(Number),
        },
      ],
      next: null,
    });
    expect((await inState("state=rejected")).rows.map((r) => [r.id, r.state, r.reason])).toEqual([
      [p2, "rejected", "dup"],
    ]);
    expect((await inState("state=expired")).rows.map((r) => [r.id, r.state])).toEqual([
      [p3, "expired"],
    ]);
    const pending1 = await inState("state=pending");
    expect(pending1.rows.length).toBe(50);
    expect(
      pending1.rows.filter((r) => [p1, p2, p3].includes(r.id) || r.state !== "pending"),
    ).toEqual([]);
    expect(pending1.next).not.toBeNull();
    const pending2 = await inState(`state=pending&before=${pending1.next}`);
    expect([pending2.rows.map((r) => r.bullet), pending2.next]).toEqual([
      bullets.slice(0, 2).reverse(),
      null,
    ]);
    for (const query of ["state=nope", "before=x", "before=", "state=pending&before=1:1"]) {
      const res = await dash.get(`/api/projects/${projectId(root)}/proposals?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
    }

    const flagged = seedMemory(
      root,
      Array.from({ length: 51 }, (_, i) => ({ title: `Row ${i} ✓` })),
    );
    seedMemory(root, [], { stale: flagged.map((id, i) => ({ id, reason: `moved — ${i}` })) });
    const stale1 = await memoryJson(dash, root, "stale");
    const staleAt = stale1.rows[0].staleAtMs;
    expect(typeof staleAt).toBe("number");
    const staleRow = (id: number, reviewed = false) => ({
      id,
      title: `Row ${flagged.indexOf(id)} ✓`,
      staleAtMs: staleAt,
      reason: `moved — ${flagged.indexOf(id)}`,
      reviewed,
    });
    expect(stale1).toEqual({
      rows: flagged
        .slice(1)
        .reverse()
        .map((id) => staleRow(id)),
      next: `${staleAt}:${flagged[1]}`,
    });
    expect(await memoryJson(dash, root, `stale?before=${stale1.next}`)).toEqual({
      rows: [staleRow(flagged[0]!)],
      next: null,
    });
    withWritable(root, (memory) => {
      memory.recordConsolidation({
        outcome: "ok",
        startedMs: 5,
        model: "m",
        costUsd: 0,
        sent: [],
        decided: [],
        verdicts: [{ id: flagged[0]!, verdict: "confirmed" }],
      });
      runs += 1;
    });
    expect(await memoryJson(dash, root, `stale?before=${stale1.next}`)).toEqual({
      rows: [staleRow(flagged[0]!, true)],
      next: null,
    });
    for (const query of ["before=1", "before=x", "before="]) {
      const res = await dash.get(`/api/projects/${projectId(root)}/stale?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
    }

    withWritable(root, (memory) => {
      for (let i = 0; i < 52; i++) {
        memory.recordConsolidation({
          outcome: "conflict",
          startedMs: i,
          model: i % 2 === 0 ? null : "sonnet",
          costUsd: i + 0.125,
        });
        runs += 1;
      }
    });
    const runs1 = await memoryJson(dash, root, "consolidations");
    const runIds = (runs1.rows as { id: number }[]).map((r) => r.id);
    expect(runIds.length).toBe(50);
    expect(runIds).toEqual([...runIds].sort((a, b) => b - a));
    expect(runs1.rows[0]).toEqual({
      id: runIds[0],
      startedAtMs: 51,
      finishedAtMs: expect.any(Number),
      outcome: "conflict",
      model: "sonnet",
      costUsd: 51.125,
    });
    expect(runs1.next).toBe(String(runIds[49]));
    const runs2 = await memoryJson(dash, root, `consolidations?before=${runs1.next}`);
    expect([runs2.rows.length, runs2.next]).toEqual([runs - 50, null]);
    expect(runs2.rows.at(-1)).toEqual({
      id: expect.any(Number),
      startedAtMs: 1,
      finishedAtMs: expect.any(Number),
      outcome: "ok",
      model: "m",
      costUsd: 0,
    });
    for (const query of ["before=x", "before=", "before=1:1"]) {
      const res = await dash.get(`/api/projects/${projectId(root)}/consolidations?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
    }
  }, 30_000);

  test("a store that does not open answers every Curation route with the Memory view's note", async () => {
    const home = makeCrankHome();
    const missing = registeredProject(home);
    const newer = registeredProject(home);
    plantMemory(newer, "newer");
    const unreadable = registeredProject(home);
    plantMemory(unreadable, "unreadable");
    const dash = await startDashboard(home, ["--port", "0"]);
    for (const [root, note] of [
      [missing, NO_MEMORY_NOTE],
      [newer, MEMORY_NEWER_NOTE],
      [unreadable, MEMORY_UNREADABLE_NOTE],
    ] as const) {
      for (const route of ["proposals", "stale", "consolidations"]) {
        expect(await memoryJson(dash, root, route)).toEqual({ note });
      }
    }
  }, 20_000);
});

describe("health view", () => {
  test("GET …/health answers the capture rows `stats` prints, unpadded and in order", async () => {
    const home = makeCrankHome();
    const root = registeredProject(home);
    const [a] = seedMemory(root, [{ title: "Lock retry is two seconds" }, { title: "日本 ✓" }], {
      costUsd: 0.002,
      proposals: [{ kind: "memory", bullet: "- **P**: x" }],
    }) as [number];
    seedMemory(root, [], { stale: [{ id: a, reason: "retry is 5 s now" }] });
    const threeHoursAgo = Date.now() - 3 * 3600_000;
    const mod = process.getBuiltinModule("node:sqlite") as typeof sqlite;
    const db = new mod.DatabaseSync(memoryPath(root));
    try {
      db.prepare("UPDATE digests SET created_at = ?").run(threeHoursAgo);
    } finally {
      db.close();
    }
    withWritable(root, (memory) =>
      memory.recordConsolidation({
        outcome: "conflict",
        startedMs: threeHoursAgo,
        model: null,
        costUsd: 0,
      }),
    );
    const dash = await startDashboard(home, ["--port", "0"]);
    const health = await memoryJson(dash, root, "health");

    const run = runCli(root, ["stats"], { CRANK_HOME: home });
    expect(run.status).toBe(0);
    const lines = run.stdout.split("\n");
    const first = lines.findIndex((l) => l.startsWith("  digest:"));
    const last = lines.findIndex((l) => l.startsWith("  embedder:"));
    const printed = lines
      .slice(first, last + 1)
      .map((l) => /^ {2}([^:]+):\s+(.*)$/.exec(l)!.slice(1, 3));
    expect(printed.find(([label]) => label === "consolidation")).toEqual([
      "consolidation",
      "3h ago (conflict)",
    ]);
    expect(health).toEqual({ rows: printed });
  }, 20_000);

  test("a missing or newer store answers the single memory row `stats` prints for it", async () => {
    const home = makeCrankHome();
    const missing = registeredProject(home);
    const newer = registeredProject(home);
    plantMemory(newer, "newer");
    const dash = await startDashboard(home, ["--port", "0"]);
    for (const [root, value] of [
      [missing, "none yet"],
      [newer, "newer than this version; run crank-mem upgrade"],
    ] as const) {
      const { rows } = (await memoryJson(dash, root, "health")) as { rows: [string, string][] };
      expect(rows.map(([label]) => label)).toEqual([
        "digest",
        "daemon",
        "spool",
        "memory",
        "last snapshot",
        "embedder",
      ]);
      expect(rows.find(([label]) => label === "memory")).toEqual(["memory", value]);
    }
  }, 20_000);
});

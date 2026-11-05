import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  cleanup,
  dashboardFixture,
  makeCrankHome,
  makeCrankProject,
  REPO_ROOT,
  runCli,
  startDashboard,
  tempDir,
  waitFor,
} from "./helpers.ts";

afterEach(cleanup);

const USAGE = "Usage: crank-mem dashboard [--port <n>] [--no-open]";
const NOT_BUILT = "crank-mem: the dashboard is not built — run `crank-mem setup`.\n";
const UNAUTHORIZED_BODY = "crank-mem dashboard: open the URL that `crank-mem dashboard` printed.\n";
const STARTUP_URL = /^http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]{64})$/;
const FIXTURE_INDEX = path.join(REPO_ROOT, "tests/fixtures/dashboard-dist/index.html");

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

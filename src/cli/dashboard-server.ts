import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

// The dashboard's HTTP server: loopback only, and every request carries the
// session cookie, which the URL's `?token=` trades for once.

const COOKIE = "crank_dashboard";
const UNAUTHORIZED_BODY = "crank-mem dashboard: open the URL that `crank-mem dashboard` printed.\n";

/** Constant-time equality; a length mismatch fails without comparing. */
function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const pair of (header ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" }).end(UNAUTHORIZED_BODY);
}

export async function serveDashboard(opts: {
  port: number;
  distDir: string;
  token: string;
}): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const given = url.searchParams.get("token");
    if (url.pathname === "/" && given !== null) {
      if (!sameToken(given, opts.token)) return unauthorized(res);
      res
        .writeHead(303, {
          Location: "/",
          "Set-Cookie": `${COOKIE}=${opts.token}; HttpOnly; SameSite=Strict; Path=/`,
        })
        .end();
      return;
    }
    const cookie = cookieValue(req.headers.cookie, COOKIE);
    if (cookie === null || !sameToken(cookie, opts.token)) return unauthorized(res);
    if (url.pathname === "/") {
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(fs.readFileSync(path.join(opts.distDir, "index.html")));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

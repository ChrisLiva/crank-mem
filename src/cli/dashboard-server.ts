import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

// The dashboard's HTTP server: loopback only, and every request carries the
// session cookie, which the URL's `?token=` trades for once. The checks run
// in order (Host, method, token or cookie, then path) and the first failure answers.

const COOKIE = "crank_dashboard";
const UNAUTHORIZED_BODY = "crank-mem dashboard: open the URL that `crank-mem dashboard` printed.\n";
const FORBIDDEN_HOST_BODY = "crank-mem dashboard: forbidden host.\n";
const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
};

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

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** The file under `distDir` that `pathname` names, or null for a miss, a directory or an escape. */
function staticFile(distDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return null;
  }
  const root = path.resolve(distDir);
  const file = path.resolve(root, "." + decoded);
  if (!file.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
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
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if ((req.url ?? "").startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    const port = (server.address() as AddressInfo).port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end(FORBIDDEN_HOST_BODY);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
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
    const file = staticFile(opts.distDir, url.pathname);
    if (file === null) {
      res.writeHead(404).end();
      return;
    }
    const type = CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream";
    if (file === path.join(path.resolve(opts.distDir), "index.html")) {
      res.setHeader("Cache-Control", "no-store");
    }
    res.writeHead(200, { "Content-Type": type }).end(fs.readFileSync(file));
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

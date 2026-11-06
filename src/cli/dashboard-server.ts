import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { CONFIG_FILE, CRANK_DIR, loadConfig } from "../hooks/lib/config.ts";
import {
  memoryPath,
  memoryStatus,
  isObservationType,
  isProposalState,
  openMemory,
  type ConsolidationRow,
  type MemoryRead,
  type MemoryReader,
  type ObservationLine,
  type ProposalRow,
  type StaleRow,
} from "../hooks/lib/memory.ts";
import { readUsage } from "../hooks/lib/usage.ts";
import { readStopState } from "../hooks/lib/user-state.ts";
import { EMBED_MODEL } from "../daemon/embedder.ts";
import { NO_MEMORY_NOTE, queryVector, STATE_NOTES } from "./recall.ts";
import { registeredRoots } from "./registry.ts";
import { captureRows } from "./stats.ts";
import { usageMetrics } from "./usage-metrics.ts";

// The dashboard's HTTP server: loopback only, and every request carries the
// session cookie, which the URL's `?token=` trades for once. The checks run
// in order (Host, method, token or cookie, then path) and the first failure answers.

const COOKIE = "crank_dashboard";
const UNAUTHORIZED_BODY = "crank-mem dashboard: open the URL that `crank-mem dashboard` printed.\n";
const FORBIDDEN_HOST_BODY = "crank-mem dashboard: forbidden host.\n";
const INTERNAL_ERROR_BODY = "crank-mem dashboard: internal error.\n";
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

type Project = { id: string; name: string; root: string };

/**
 * The registered roots that still hold `.crank/config.json`, one per store and
 * listed under the root that holds the store, ordered by name and then root.
 */
function listProjects(): Project[] {
  const byStore = new Map<string, Project>();
  for (const registered of registeredRoots()) {
    if (!fs.existsSync(path.join(registered, CRANK_DIR, CONFIG_FILE))) continue;
    const storeDir = path.dirname(memoryPath(registered));
    const root = path.dirname(storeDir);
    const id = crypto.createHash("sha256").update(storeDir).digest("hex").slice(0, 12);
    byStore.set(storeDir, { id, name: path.basename(root), root });
  }
  return [...byStore.values()].sort(
    (a, b) =>
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.root < b.root ? -1 : a.root > b.root ? 1 : 0),
  );
}

function projectById(id: string): Project | null {
  return listProjects().find((p) => p.id === id) ?? null;
}

/** Green: a readable store taking digests. Grey: digests off. Amber: anything needing a look. */
function projectDot(root: string, memory: MemoryRead["status"]): "green" | "amber" | "grey" {
  if (memory !== "open") return "amber";
  if (!loadConfig(path.join(root, CRANK_DIR)).digest) return "grey";
  return readStopState() === null ? "green" : "amber";
}

function projectsBody(): string {
  const projects = listProjects().map((p) => {
    const memory = memoryStatus(memoryPath(p.root));
    return { ...p, dot: projectDot(p.root, memory), memory };
  });
  return JSON.stringify({ projects });
}

/** `fn`'s answer over the project's store, opened read-only and closed after; a store that does not open answers its note. */
async function withStore<T>(
  root: string,
  fn: (memory: MemoryReader) => T | Promise<T>,
): Promise<T | { note: string }> {
  const opened = openMemory(memoryPath(root), "read");
  if (opened.status === "missing") return { note: NO_MEMORY_NOTE };
  if (opened.status !== "open") return { note: STATE_NOTES[opened.status] };
  try {
    return await fn(opened.memory);
  } finally {
    opened.memory.close();
  }
}

/** A `<ms>:<id>` paging cursor, or null for anything else. */
function parseCursor(s: string): { ms: number; id: number } | null {
  const m = /^(\d+):(\d+)$/.exec(s);
  return m ? { ms: Number(m[1]), id: Number(m[2]) } : null;
}

/** The first `limit` of the `limit + 1` rows a reader returned, and the last kept row's cursor when the extra row exists. */
function pageOf<T>(
  rows: T[],
  limit: number,
  cursor: (row: T) => string,
): { rows: T[]; next: string | null } {
  const kept = rows.slice(0, limit);
  return { rows: kept, next: rows.length > limit ? cursor(kept[kept.length - 1]!) : null };
}

/** A decimal row id, or null for anything else. */
function parseId(s: string): number | null {
  return /^\d+$/.test(s) ? Number(s) : null;
}

const PAGE = 50;
type Answer = { status: number; body?: unknown };

/** `GET …/observations`: one page of lines, newest first. */
async function observations(root: string, params: URLSearchParams): Promise<Answer> {
  const beforeParam = params.get("before");
  const before = beforeParam === null ? null : parseCursor(beforeParam);
  const type = params.get("type");
  const q = params.get("q");
  if (beforeParam !== null && before === null) return { status: 400 };
  if (type !== null && !isObservationType(type)) return { status: 400 };
  if (q !== null && q.trim() === "") return { status: 400 };
  const filters = {
    type,
    file: params.get("file"),
    stale: params.get("stale") === "1",
  };
  const body = await withStore(root, async (memory) => {
    if (q !== null) {
      const vector = await queryVector(memory, q);
      const lines = memory.search({ ...filters, text: q, vector, sinceMs: null, limit: PAGE });
      return { lines, next: null, mode: vector !== null ? "hybrid" : "keyword" };
    }
    const page = pageOf(
      memory.list({
        ...filters,
        limit: PAGE + 1,
        before: before && { createdAtMs: before.ms, id: before.id },
      }),
      PAGE,
      (line: ObservationLine) => `${line.createdAtMs}:${line.id}`,
    );
    return { lines: page.rows, next: page.next };
  });
  return { status: 200, body };
}

/** `GET …/observations/<oid>`: the whole observation. */
async function observation(root: string, oid: string): Promise<Answer> {
  const id = parseId(oid);
  if (id === null) return { status: 400 };
  const body = await withStore(root, (memory) => memory.get([id])[0] ?? null);
  return body === null ? { status: 404 } : { status: 200, body };
}

/** `GET …/proposals`: one page of proposals in every state or in `state`, newest first. */
async function proposals(root: string, params: URLSearchParams): Promise<Answer> {
  const beforeParam = params.get("before");
  const beforeId = beforeParam === null ? null : parseId(beforeParam);
  const state = params.get("state");
  if (beforeParam !== null && beforeId === null) return { status: 400 };
  if (state !== null && !isProposalState(state)) return { status: 400 };
  const body = await withStore(root, (memory) =>
    pageOf(memory.proposalRows({ state, beforeId, limit: PAGE + 1 }), PAGE, (row: ProposalRow) =>
      String(row.id),
    ),
  );
  return { status: 200, body };
}

/** `GET …/stale`: one page of stale-flagged observations, newest flag first. */
async function stale(root: string, params: URLSearchParams): Promise<Answer> {
  const beforeParam = params.get("before");
  const before = beforeParam === null ? null : parseCursor(beforeParam);
  if (beforeParam !== null && before === null) return { status: 400 };
  const body = await withStore(root, (memory) =>
    pageOf(
      memory.staleRows({
        before: before && { staleAtMs: before.ms, id: before.id },
        limit: PAGE + 1,
      }),
      PAGE,
      (row: StaleRow) => `${row.staleAtMs}:${row.id}`,
    ),
  );
  return { status: 200, body };
}

/** `GET …/consolidations`: one page of consolidation runs, newest first. */
async function consolidations(root: string, params: URLSearchParams): Promise<Answer> {
  const beforeParam = params.get("before");
  const beforeId = beforeParam === null ? null : parseId(beforeParam);
  if (beforeParam !== null && beforeId === null) return { status: 400 };
  const body = await withStore(root, (memory) =>
    pageOf(memory.consolidationRows({ beforeId, limit: PAGE + 1 }), PAGE, (row: ConsolidationRow) =>
      String(row.id),
    ),
  );
  return { status: 200, body };
}

/** `GET …/health`: the capture rows `crank-mem stats` prints, without its padding. */
async function health(root: string): Promise<Answer> {
  const rows = await captureRows(root, loadConfig(path.join(root, CRANK_DIR)));
  return { status: 200, body: { rows } };
}

/** `GET …/usage`: the Usage view's metrics over the log; a store that does not open gives no titles, and its note. */
async function usage(root: string, params: URLSearchParams): Promise<Answer> {
  const days = ([7, 30, 90] as const).find((d) => String(d) === params.get("days"));
  const manual = params.get("manual") ?? "0";
  if (days === undefined || (manual !== "0" && manual !== "1")) return { status: 400 };
  const events = readUsage(path.dirname(memoryPath(root)));
  const opts = { nowMs: Date.now(), days, manual: manual === "1" };
  const body = await withStore(root, (memory) =>
    usageMetrics(events, {
      ...opts,
      titles: (ids) => new Map(memory.get(ids).map((o) => [o.id, o.title])),
      observationCount: memory.stats(EMBED_MODEL, 0).observations,
    }),
  );
  if (!("note" in body)) return { status: 200, body };
  return {
    status: 200,
    body: {
      ...usageMetrics(events, { ...opts, titles: () => new Map(), observationCount: 0 }),
      note: body.note,
    },
  };
}

/** The answer for a route under `/api/projects/<id>`, or null when no route matches. */
async function projectRoute(
  project: Project,
  route: string,
  params: URLSearchParams,
): Promise<Answer | null> {
  if (route === "/observations") return observations(project.root, params);
  if (route === "/proposals") return proposals(project.root, params);
  if (route === "/stale") return stale(project.root, params);
  if (route === "/consolidations") return consolidations(project.root, params);
  if (route === "/health") return health(project.root);
  if (route === "/usage") return usage(project.root, params);
  const one = /^\/observations\/([^/]*)$/.exec(route);
  if (one) return observation(project.root, one[1]!);
  return null;
}

function sendAnswer(res: http.ServerResponse, answer: Answer): void {
  if (answer.body === undefined) {
    res.writeHead(answer.status).end();
    return;
  }
  const json = JSON.stringify(answer.body);
  res.writeHead(answer.status, { "Content-Type": "application/json; charset=utf-8" }).end(json);
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
    if (url.pathname === "/api/projects") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(projectsBody());
      return;
    }
    const scoped = /^\/api\/projects\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (scoped) {
      const project = projectById(scoped[1]!);
      if (project === null) {
        res.writeHead(404).end();
        return;
      }
      projectRoute(project, scoped[2]!, url.searchParams)
        .then((answer) => sendAnswer(res, answer ?? { status: 404 }))
        .catch(() => {
          if (res.headersSent) return res.destroy();
          res
            .writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
            .end(INTERNAL_ERROR_BODY);
        });
      return;
    }
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

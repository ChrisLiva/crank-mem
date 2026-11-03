import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { parseArgs } from "../../src/cli/args.ts";

// A stand-in for the model host: answers GET /<org>/<model>/resolve/main/<file>
// from <dir>/<org>/<model>/<file>. Runs as a child process, because runCli's
// spawnSync would block an in-process server.
// Usage: bun model-server.ts --dir <models dir> --mode ok|stall|slow --log <file>

const { flags } = parseArgs(process.argv.slice(2), ["dir", "mode", "log"]);
const dir = String(flags.dir);
const mode = String(flags.mode);
const log = String(flags.log);

const ROUTE = /^\/([^/]+)\/([^/]+)\/resolve\/main\/(.+)$/;

const server = http.createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0]!;
  fs.appendFileSync(log, url + "\n");
  const m = ROUTE.exec(url);
  const file = m ? path.join(dir, m[1]!, m[2]!, decodeURIComponent(m[3]!)) : null;
  if (req.method !== "GET" || !file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
  if (mode === "stall") return;
  if (mode === "slow") {
    let i = 0;
    const iv = setInterval(() => {
      if (i >= body.length) {
        clearInterval(iv);
        res.end();
        return;
      }
      res.write(body.subarray(i, ++i));
    }, 500);
    req.on("close", () => clearInterval(iv));
    return;
  }
  res.end(body);
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  process.stdout.write(`PORT ${typeof addr === "object" && addr ? addr.port : 0}\n`);
});

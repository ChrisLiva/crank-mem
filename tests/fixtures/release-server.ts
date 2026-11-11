import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { parseArgs } from "../../src/cli/args.ts";

// A stand-in for the release host: answers GET /<path> with the file <dir>/<path>,
// 404 when absent. Runs as a child process, because spawnSync would block an
// in-process server.
// Usage: bun release-server.ts --dir <release dir> --log <file>

const { flags } = parseArgs(process.argv.slice(2), ["dir", "log"]);
const dir = path.resolve(String(flags.dir));
const log = String(flags.log);

const server = http.createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0]!;
  fs.appendFileSync(log, url + "\n");
  const file = path.join(dir, decodeURIComponent(url));
  const inside = file.startsWith(dir + path.sep);
  if (req.method !== "GET" || !inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  const body = fs.readFileSync(file);
  res
    .writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
    })
    .end(body);
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  process.stdout.write(`PORT ${typeof addr === "object" && addr ? addr.port : 0}\n`);
});

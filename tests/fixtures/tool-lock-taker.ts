import * as fs from "node:fs";
import { locked } from "../../src/cli/tool-install.ts";

// One tool.lock taker for the steal race test: it spins until the shared start
// time, so every taker finds the dead-pid lock together, then logs its entry and
// exit around a 50 ms hold. CRANK_HOME comes from the env.
// argv: <log file> <start time, epoch ms>

const [log, at] = process.argv.slice(2);
while (Date.now() < Number(at)) {}
await locked("test", async () => {
  fs.appendFileSync(log!, `enter ${process.pid}\n`);
  await new Promise((r) => setTimeout(r, 50));
  fs.appendFileSync(log!, `exit ${process.pid}\n`);
  return 0;
});

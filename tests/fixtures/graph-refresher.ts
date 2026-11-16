import * as path from "node:path";
import { refreshGraph } from "../../src/cli/code-parse.ts";
import { loadConfig } from "../../src/hooks/lib/config.ts";

// One unbounded graph refresh that spins until a shared start time, so writers released together
// contend for code.db at once; a hook's own start-up spreads them too far apart to race. It prints
// each parsed path, in parse order, and exits 1 unless the store ended `open`.
// argv: <project root> <start time, epoch ms>

const [root, at] = process.argv.slice(2);
while (Date.now() < Number(at)) {}
const refreshed = await refreshGraph(root!, loadConfig(path.join(root!, ".crank")), {
  deadlineMs: Infinity,
  onProgress(_done, _total, rel) {
    console.log(rel);
  },
});
process.exit(refreshed.status === "open" ? 0 : 1);

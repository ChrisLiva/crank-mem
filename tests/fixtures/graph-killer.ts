import * as path from "node:path";
import { refreshGraph } from "../../src/cli/code-parse.ts";
import { loadConfig } from "../../src/hooks/lib/config.ts";

// Runs one unbounded graph refresh and SIGKILLs its own process right after the Nth file's
// commit, so a test can read the store a killed parse leaves.
// argv: <project root> <commits before the kill>

const [root, after] = process.argv.slice(2);
await refreshGraph(root!, loadConfig(path.join(root!, ".crank")), {
  deadlineMs: Infinity,
  onProgress(done) {
    if (done >= Number(after)) process.kill(process.pid, "SIGKILL");
  },
});

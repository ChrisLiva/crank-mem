import * as path from "node:path";
import { readStdin, parsePayload, findProjectRoot, runAdvisoryHook } from "../../src/hooks/lib/hook-io.ts";
import { loadConfig, CRANK_DIR } from "../../src/hooks/lib/config.ts";
import { enableDebug } from "../../src/hooks/lib/debug.ts";

// A hook whose body always throws, so the advisory-only epilogue in
// runAdvisoryHook (catch → stderr → debug record → exit 0) can be tested. The
// real hooks are defensive enough that no payload reliably makes them throw.

await runAdvisoryHook("throwing", async () => {
  const payload = parsePayload(await readStdin());
  const root = findProjectRoot(
    typeof payload?.cwd === "string" ? payload.cwd : process.cwd()
  );
  if (root) {
    const crankDir = path.join(root, CRANK_DIR);
    enableDebug(crankDir, loadConfig(crankDir).debug);
  }
  throw new Error("boom from hook body");
});

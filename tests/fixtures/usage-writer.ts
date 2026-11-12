import { recordUsage } from "../../src/hooks/lib/usage.ts";

// One usage writer for the rotation race test: it spins until the shared start
// time, so every writer process stats usage.jsonl at the 4 MiB mark together.
// A hook's own start-up spreads writers too far apart to race reliably.
// argv: <project root> <writer number> <start time, epoch ms>

const [root, n, at] = process.argv.slice(2);
while (Date.now() < Number(at)) {}
recordUsage(root!, { agent: "manual", session: null }, {
  channel: "get",
  requested: [Number(n)],
  found: [],
});

import { recordUntouched } from "../../src/hooks/lib/untouched.ts";

// One untouched.json writer for the sighting race test: it spins until the shared start time, so
// every writer process reads the list together. A hook's own start-up spreads writers too far
// apart to race reliably.
// argv: <repo root> <start time, epoch ms>; CRANK_HOME names the list's home.

const [repo, at] = process.argv.slice(2);
while (Date.now() < Number(at)) {}
recordUntouched([repo!], null);

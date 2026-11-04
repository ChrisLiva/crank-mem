import type { Digest } from "../../src/daemon/digest-prompt.ts";

export const SAMPLE_DIGEST: Digest = {
  observations: [
    {
      type: "bugfix",
      title: "Lock file writes retry on EEXIST",
      narrative: "Concurrent hooks raced on the index lock. The writer now retries for 2 seconds when the lock file exists.",
      facts: ["withLock in src/hooks/lib/lock.ts retries on EEXIST"],
      files_read: [],
      files_modified: ["src/hooks/lib/lock.ts"],
    },
    {
      type: "discovery",
      title: "Scanner reads sources through one helper",
      narrative: "Every source read in the scanner goes through one helper, so a size cap lives in one place.",
      facts: [],
      files_read: ["src/a.ts", ".env", "/elsewhere/x.ts"],
      files_modified: [],
    },
    {
      type: "decision",
      title: "Deploy credentials stay out of the repository",
      narrative: "The session pasted the token " + "ghp_" + "a1".repeat(18) + " by mistake; the user rotated it.",
      facts: [],
      files_read: [],
      files_modified: [],
    },
  ],
  summary: {
    request: "Fix the racing index writes.",
    investigated: "The lock helper and the scanner.",
    learned: "The lock file needed a retry.",
    completed: "Lock writes retry on EEXIST.",
    next_steps: "Wire the daemon.",
  },
  proposals: [],
  stale: [],
};

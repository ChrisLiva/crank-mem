// Runs outside `bun test`, so without the preload: a session start in a fresh project.
import { makeCrankProject, runHook } from "../helpers.ts";
import { claudeSessionStart } from "./payloads.ts";

const root = makeCrankProject();
const run = runHook("src/hooks/session-start.ts", JSON.stringify(claudeSessionStart(root)), root);
process.exit(run.status);

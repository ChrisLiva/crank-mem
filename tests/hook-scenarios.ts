import { expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  REPO_ROOT,
  enableDebugConfig,
  fakeCloneRoot,
  hookContext,
  killDaemon,
  makeCrankHome,
  makeCrankProject,
  plantCodeDb,
  readDaemon,
  readDebugLog,
  runHook,
  seedMemory,
  stopDigests,
  waitFor,
  type HookRun,
} from "./helpers.ts";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { claudeSessionStart } from "./fixtures/payloads.ts";
import { workspace } from "./workspace.ts";

/** Runs one hook against `root` with `env` added to its environment. */
type Trigger = (root: string, env: Record<string, string>) => HookRun;

/** A hook whose run reaches `code.db` must leave a file at another schema version byte-identical. */
export function codeDbAtNewerVersionIsLeftAlone(trigger: Trigger): void {
  const root = makeCrankProject({ "a.ts": "export const a = 1;\n" });
  enableDebugConfig(root);
  const file = path.join(root, ".crank/code.db");
  plantCodeDb(root, "newer");
  const before = fs.readFileSync(file);
  expect(trigger(root, {}).status).toBe(0);
  expect(fs.readFileSync(file).equals(before)).toBe(true);
  const events = readDebugLog(root)
    .flatMap((r) => r.events)
    .filter((e) => String(e.event).startsWith("graph"));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event: "graph-skip", status: "rebuild" });
}

/**
 * A hook run that leaves a parseable file pending starts the daemon, and a stop state keeps it
 * down. `trigger` must leave a new pending file on every call.
 */
export async function parseableWriteStartsDaemonUnlessStopped(trigger: Trigger): Promise<void> {
  const root = makeCrankProject({ "a.ts": "export const a = 1;\n" });
  saveConfig(path.join(root, ".crank"), { ...defaultConfig(), clone_root: REPO_ROOT });
  // Each run has its own crank home: a daemon the first started would satisfy the second's ensureDaemon.
  const started = makeCrankHome();
  try {
    expect(trigger(root, { CRANK_HOME: started }).status).toBe(0);
    await waitFor(() => typeof readDaemon(started)?.heartbeatMs === "number", 5000);
  } finally {
    killDaemon(started);
  }

  const fake = fakeCloneRoot();
  saveConfig(path.join(root, ".crank"), { ...defaultConfig(), clone_root: fake.root });
  const stopped = makeCrankHome();
  stopDigests(stopped);
  expect(trigger(root, { CRANK_HOME: stopped }).status).toBe(0);
  await Bun.sleep(1500);
  expect(fake.starts()).toBe(0);
  expect(readDaemon(stopped)).toBeNull();
}

/**
 * A cerebrum bullet citing a linked project's file reads that project's code.db. `trigger` runs
 * the hook against the project that holds the bullet. Only the session-start copy asserts the
 * linked code.db stays byte-identical.
 */
export function linkedProjectCitationScenario(
  trigger: Trigger,
  { linkedIndexUnchanged }: { linkedIndexUnchanged: boolean },
): void {
  const ws = workspace();
  seedMemory(ws.H, [], { links: ["payments-api"] });
  const env = { CRANK_HOME: ws.home };
  const start = runHook(
    "src/hooks/session-start.ts",
    JSON.stringify(claudeSessionStart(ws.payments)),
    ws.payments,
    env,
  );
  expect(start.status).toBe(0);
  const bullet = "- **Pay**: see `payments-api/src/a.ts` (2020-01-01).";
  fs.appendFileSync(path.join(ws.H, ".crank/cerebrum.md"), `${bullet}\n`);
  const linkedIndex = path.join(ws.payments, ".crank/code.db");
  const before = fs.readFileSync(linkedIndex);

  const ctx = hookContext(trigger(ws.H, env));
  expect(ctx).toContain(
    `${bullet} [cited file modified after this note; check: payments-api/src/a.ts]`,
  );
  expect(ctx).not.toContain("[cited file missing");
  if (linkedIndexUnchanged) expect(fs.readFileSync(linkedIndex).equals(before)).toBe(true);
}

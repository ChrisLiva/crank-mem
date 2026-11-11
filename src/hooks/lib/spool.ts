import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, isObj, type CrankConfig } from "./config.ts";
import { debugEvent } from "./debug.ts";
import type { HookPayload } from "./hook-io.ts";
import {
  crankHome,
  ensureCrankHome,
  readStopState,
  writeJsonAtomic,
  type StopState,
} from "./user-state.ts";

// The digest spool: one <crank home>/spool/<stem>.json per Claude session that
// has work to digest, keyed by the transcript's basename. Stop and SessionEnd
// write it; the digest job reads it, and parks an entry it cannot finish
// under spool/parked/.

/** `cwd` is the session's working directory. */
export type SpoolEntry = {
  transcriptPath: string;
  projectRoot: string;
  cwd: string;
  agent: "claude";
  ended: boolean;
  updatedAt: number;
};
export type SpoolItem = { stem: string; entry: SpoolEntry };

export const DAEMON_FILE = "daemon.json";
/** A heartbeat older than this means the daemon is gone; it heartbeats once a sweep. */
const HEARTBEAT_MAX_MS = 90_000;
/** A spool entry for this project quiet this long turns the digest gate off. */
const CAPTURE_STALL_MS = 2 * 3_600_000;
export type DaemonState = { pid: number; version: string; heartbeatMs: number };

const PARKED = "parked";
const EXT = ".json";

export function spoolDir(): string {
  return path.join(crankHome(), "spool");
}

function parkedDir(): string {
  return path.join(spoolDir(), PARKED);
}

/** A main-session transcript's basename without `.jsonl`; null for anything else, subagent transcripts included. */
export function transcriptStem(transcriptPath: unknown): string | null {
  if (typeof transcriptPath !== "string" || !transcriptPath.endsWith(".jsonl")) return null;
  if (transcriptPath.split(/[\\/]/).includes("subagents")) return null;
  const stem = path.basename(transcriptPath, ".jsonl");
  return /^[\w.-]+$/.test(stem) ? stem : null;
}

/** Write the entry for a transcript, replacing any parked copy so the session is digested again. */
function writeSignal(
  transcriptPath: string,
  projectRoot: string,
  ended: boolean,
  cwd: string,
): void {
  const stem = transcriptStem(transcriptPath);
  if (!stem) return;
  ensureCrankHome();
  deleteParked(stem);
  const entry: SpoolEntry = {
    transcriptPath,
    projectRoot,
    cwd,
    agent: "claude",
    ended,
    updatedAt: Date.now(),
  };
  writeJsonAtomic(path.join(spoolDir(), stem + EXT), entry);
}

/** The hooks' entry point: signal when the project turned digests on. Never throws. */
export function signalDigest(
  payload: HookPayload,
  projectRoot: string,
  config: CrankConfig,
  ended: boolean,
): void {
  if (!config.digest || typeof payload.transcript_path !== "string") return;
  try {
    writeSignal(
      payload.transcript_path,
      projectRoot,
      ended,
      typeof payload.cwd === "string" ? payload.cwd : projectRoot,
    );
    if (readStopState() === null) ensureDaemon(config);
  } catch (err) {
    debugEvent("signal-failed", { error: errorMessage(err) });
  }
}

/** The parsed daemon.json; null when it cannot be read or does not hold a JSON object. */
export function readDaemonState(): Partial<DaemonState> | null {
  try {
    const state: unknown = JSON.parse(
      fs.readFileSync(path.join(crankHome(), DAEMON_FILE), "utf-8"),
    );
    return typeof state === "object" && state !== null ? (state as Partial<DaemonState>) : null;
  } catch {
    return null;
  }
}

/**
 * True while daemon.json holds a heartbeat younger than HEARTBEAT_MAX_MS. A file
 * that does not parse counts by its mtime instead, because a starter between
 * its `wx` create and its first write leaves an empty file.
 */
export function daemonAlive(): boolean {
  const file = path.join(crankHome(), DAEMON_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return false;
  }
  try {
    const state = JSON.parse(text) as Partial<DaemonState> | null;
    if (typeof state?.heartbeatMs === "number")
      return Date.now() - state.heartbeatMs <= HEARTBEAT_MAX_MS;
  } catch {
    // Fall through to the file's age.
  }
  try {
    return Date.now() - fs.statSync(file).mtimeMs < HEARTBEAT_MAX_MS;
  } catch {
    return false;
  }
}

/**
 * Start the clone's daemon unless one is alive. Detached with stdio ignored, so
 * the hook returns at once and nothing reaches its stdout; cwd is the clone so
 * bun never loads a project's .env. Never throws.
 */
export function ensureDaemon(config: Pick<CrankConfig, "clone_root">): void {
  try {
    if (!config.clone_root || daemonAlive()) return;
    const bin = path.join(config.clone_root, "bin", "crank-mem");
    if (!fs.existsSync(bin)) return;
    const child = spawn(bin, ["daemon"], {
      cwd: config.clone_root,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch (err) {
    debugEvent("daemon-start-failed", { error: errorMessage(err) });
  }
}

function readEntries(dir: string): SpoolItem[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const items: SpoolItem[] = [];
  for (const name of names) {
    if (!name.endsWith(EXT)) continue;
    try {
      const entry: SpoolEntry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8"));
      if (isObj(entry)) {
        // An entry written before entries carried cwd takes its project root.
        if (typeof entry.cwd !== "string") entry.cwd = entry.projectRoot;
        items.push({ stem: name.slice(0, -EXT.length), entry });
      }
    } catch {
      // Unparseable or vanished mid-read: skip it.
    }
  }
  return items;
}

export function readSpool(): SpoolItem[] {
  return readEntries(spoolDir());
}

/**
 * The digest gate for one session, read once. `running`: digests run for this
 * Claude session, since the project turned them on, nothing stopped them, and
 * its capture drains. `stalled`: an entry for this project has been quiet past
 * CAPTURE_STALL_MS; the transcript's mtime counts too, because Stop fires only
 * at turn end, so a long turn keeps an old updatedAt while its transcript
 * grows. `drained`: no entry for this project waits (parked ones do not count).
 */
export type DigestGate = {
  running: boolean;
  stop: StopState | null;
  stalled: boolean;
  drained: boolean;
};

export function digestGate(config: CrankConfig, codex: boolean, root: string): DigestGate {
  if (!config.digest) return { running: false, stop: null, stalled: false, drained: true };
  const stop = readStopState();
  const pending = readSpool()
    .map(({ entry }) => entry)
    .filter((entry) => entry.projectRoot === root);
  const cutoff = Date.now() - CAPTURE_STALL_MS;
  const stalled = pending.some((entry) => {
    if (!(entry.updatedAt < cutoff)) return false;
    try {
      return fs.statSync(entry.transcriptPath).mtimeMs < cutoff;
    } catch {
      return true;
    }
  });
  return {
    running: !codex && stop === null && !stalled,
    stop,
    stalled,
    drained: pending.length === 0,
  };
}

export function readParked(): SpoolItem[] {
  return readEntries(parkedDir());
}

/**
 * Delete or park spool/<stem>.json only while it still holds the entry the job
 * read (same updatedAt). The claim name does not end in .json, so readers skip
 * it and a hook writing meanwhile creates a fresh entry. A rewritten entry is
 * linked back unless a newer one already took its place. True when settled.
 */
export function settleEntry(stem: string, updatedAt: number, how: "delete" | "park"): boolean {
  const file = path.join(spoolDir(), stem + EXT);
  const claim = `${file}.${process.pid}.claim`;
  try {
    fs.renameSync(file, claim);
  } catch {
    return false;
  }
  let same = false;
  try {
    same =
      (JSON.parse(fs.readFileSync(claim, "utf-8")) as Partial<SpoolEntry> | null)?.updatedAt ===
      updatedAt;
  } catch {
    // Unparseable: not the entry the job read.
  }
  if (!same) {
    try {
      fs.linkSync(claim, file);
    } catch (e) {
      // EEXIST: a hook wrote a newer entry after the claim; keep it. Without
      // hard links, a rename puts the claim back rather than lose the entry.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        try {
          fs.renameSync(claim, file);
        } catch {
          // The rename failed too: the rmSync below drops the claim.
        }
      }
    }
    fs.rmSync(claim, { force: true });
    return false;
  }
  if (how === "delete") {
    fs.rmSync(claim, { force: true });
  } else {
    fs.mkdirSync(parkedDir(), { recursive: true, mode: 0o700 });
    fs.renameSync(claim, path.join(parkedDir(), stem + EXT));
  }
  return true;
}

export function deleteEntry(stem: string): void {
  fs.rmSync(path.join(spoolDir(), stem + EXT), { force: true });
}

export function deleteParked(stem: string): void {
  fs.rmSync(path.join(parkedDir(), stem + EXT), { force: true });
}

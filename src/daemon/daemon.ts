import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, positive } from "../cli/args.ts";
import { COMMANDS } from "../cli/commands.ts";
import { REPO_ROOT, cliVersion } from "../cli/version.ts";
import { CONFIG_FILE, CRANK_DIR, errorMessage, loadConfig } from "../hooks/lib/config.ts";
import { trySteal } from "../hooks/lib/lock.ts";
import {
  DAEMON_FILE,
  daemonAlive,
  deleteEntry,
  deleteParked,
  readParked,
  readSpool,
  type DaemonState,
  type SpoolItem,
} from "../hooks/lib/spool.ts";
import {
  SEEN_DIR,
  crankHome,
  ensureCrankHome,
  readStopState,
  writeJsonAtomic,
} from "../hooks/lib/user-state.ts";
import { RUN_TIMEOUT_MS } from "./gateway.ts";

// `crank-mem daemon`: one per user, owning <crank home>/daemon.json. Each sweep
// heartbeats, prunes the spool and starts at most one `crank-mem job` child,
// across every project. Hooks start it through ensureDaemon; it exits when
// idle, stopped, upgraded, or replaced by another daemon.

const SWEEP_MS = 30_000;
const IDLE_MS = 600_000;
const RETRY_MS = 300_000;
const RETRY_CAP_MS = 3_600_000;
/** A session whose transcript has not changed for this long is digested before it ends. */
const QUIET_MS = 30 * 60_000;
/** A live session is digested this long after the daemon first saw it, then this long after each digest that exited 0. */
const MID_SESSION_MS = 2 * 3_600_000;
const SEEN_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

type Options = {
  sweepMs: number;
  idleMs: number;
  retryMs: number;
  retryCapMs: number;
  runTimeoutMs: number | null;
  midSessionMs: number;
  once: boolean;
};

export async function run(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, COMMANDS.daemon.value);
  const opts: Options = {
    sweepMs: positive(flags["sweep-ms"], SWEEP_MS),
    idleMs: positive(flags["idle-ms"], IDLE_MS),
    retryMs: positive(flags["retry-ms"], RETRY_MS),
    retryCapMs: positive(flags["retry-cap-ms"], RETRY_CAP_MS),
    runTimeoutMs:
      flags["run-timeout-ms"] === undefined
        ? null
        : positive(flags["run-timeout-ms"], RUN_TIMEOUT_MS),
    midSessionMs: positive(flags["mid-session-ms"], MID_SESSION_MS),
    once: flags.once === true,
  };
  ensureCrankHome();
  const file = path.join(crankHome(), DAEMON_FILE);
  const startVersion = cliVersion();
  if (!claim(file, startVersion)) return 0;
  const daemon = new Daemon(file, startVersion, opts);
  try {
    await daemon.loop();
  } finally {
    if (ownedBy(file, process.pid)) fs.rmSync(file, { force: true });
  }
  return 0;
}

function state(version: string): DaemonState {
  return { pid: process.pid, version, heartbeatMs: Date.now() };
}

/** Create daemon.json exclusively; on EEXIST steal it only when its owner's heartbeat is stale. Never signals a pid. */
function claim(file: string, version: string): boolean {
  if (create(file, version)) return true;
  if (daemonAlive()) return false;
  trySteal(file);
  return create(file, version);
}

function create(file: string, version: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch {
    return false;
  }
  try {
    fs.writeSync(fd, JSON.stringify(state(version)));
    return true;
  } catch {
    fs.rmSync(file, { force: true });
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function ownedBy(file: string, pid: number): boolean {
  try {
    return (JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<DaemonState>).pid === pid;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Daemon {
  private readonly file: string;
  private readonly startVersion: string;
  private readonly opts: Options;
  private stopping = false;
  private job: Promise<void> | null = null;
  private busySince = Date.now();
  /** Stems whose last job failed: no job starts before `untilMs`, and the next failure doubles `delayMs`. Memory only. */
  private readonly holds = new Map<string, { untilMs: number; delayMs: number }>();
  /** When each stem's mid-session window opened: the first sweep that saw it, then each exit 0. Memory only, never pruned. */
  private readonly midSessionFromMs = new Map<string, number>();

  constructor(file: string, startVersion: string, opts: Options) {
    this.file = file;
    this.startVersion = startVersion;
    this.opts = opts;
  }

  async loop(): Promise<void> {
    while (true) {
      if (this.sweep() === "exit") return;
      if (this.opts.once) {
        await this.job;
        return;
      }
      // Sleep until the next sweep, waking early when a job ends so a stopping daemon exits after it.
      const next = Date.now() + this.opts.sweepMs;
      while (Date.now() < next) {
        await Promise.race([sleep(next - Date.now()), this.job ?? new Promise<void>(() => {})]);
        if (this.stopping && this.job === null) return;
      }
    }
  }

  /** One sweep. "exit" ends the daemon at once. */
  private sweep(): "exit" | "continue" {
    // Another daemon took the file: leave it to that one.
    if (!ownedBy(this.file, process.pid)) return "exit";
    // Heartbeat. A failed write must not end the daemon mid-job; the next sweep retries it.
    try {
      writeJsonAtomic(this.file, state(this.startVersion));
    } catch (err) {
      console.error(`crank-mem daemon: heartbeat failed: ${errorMessage(err)}`);
    }
    try {
      // The clone was upgraded under us: finish the current job, then let the next start load the new code.
      if (cliVersion() !== this.startVersion) this.stopping = true;
      pruneSeen();
      pruneProjects();
      // Digests stopped (credential or login).
      if (readStopState() !== null) this.stopping = true;
      this.pruneSpool();
      if (!this.stopping && this.job === null) this.startNext();
    } catch (err) {
      console.error(`crank-mem daemon: sweep failed: ${errorMessage(err)}`);
    }
    if (this.job !== null) {
      this.busySince = Date.now();
      return "continue";
    }
    if (this.stopping) return "exit";
    if (readSpool().length > 0) this.busySince = Date.now();
    else if (Date.now() - this.busySince >= this.opts.idleMs) return "exit";
    return "continue";
  }

  /** Entries whose transcript is gone have nothing left to digest; the rest open their mid-session window on first sight. */
  private pruneSpool(): void {
    const seenMs = Date.now();
    for (const item of readSpool()) {
      if (!fs.existsSync(item.entry.transcriptPath)) deleteEntry(item.stem);
      else if (!this.midSessionFromMs.has(item.stem)) this.midSessionFromMs.set(item.stem, seenMs);
    }
  }

  /** Start a job for the first unheld entry that is eligible now, if any. */
  private startNext(): void {
    const now = Date.now();
    const unheld = readSpool().filter((item) => (this.holds.get(item.stem)?.untilMs ?? 0) <= now);
    const next = eligible(
      unheld,
      { fromMs: this.midSessionFromMs, everyMs: this.opts.midSessionMs },
      now,
    );
    if (next) this.startJob(next.stem);
  }

  private startJob(stem: string): void {
    const argv = ["job", stem];
    if (this.opts.runTimeoutMs !== null)
      argv.push("--run-timeout-ms", String(this.opts.runTimeoutMs));
    const child = spawn(path.join(REPO_ROOT, "bin", "crank-mem"), argv, {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    this.job = new Promise<void>((resolve) => {
      let ended = false;
      const done = (code: number | null) => {
        if (ended) return;
        ended = true;
        this.settle(stem, code);
        this.job = null;
        resolve();
      };
      child.once("exit", (code) => done(code));
      child.once("error", () => done(null));
    });
  }

  /** Exit 0 clears the stem's hold and restarts its mid-session window; any other end holds it for --retry-ms, doubling per failure up to --retry-cap-ms. */
  private settle(stem: string, code: number | null): void {
    if (code === 0) {
      this.holds.delete(stem);
      this.midSessionFromMs.set(stem, Date.now());
      return;
    }
    const prev = this.holds.get(stem);
    const delayMs = prev ? Math.min(prev.delayMs * 2, this.opts.retryCapMs) : this.opts.retryMs;
    this.holds.set(stem, { untilMs: Date.now() + delayMs, delayMs });
  }
}

/** Drop files under <crank home>/seen/ older than 7 days. */
function pruneSeen(): void {
  const dir = path.join(crankHome(), SEEN_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - SEEN_MAX_AGE_MS;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {
      // Vanished mid-sweep.
    }
  }
}

/** Drop spool and parked entries whose project was removed or turned digests off. */
function pruneProjects(): void {
  const wanted = (item: SpoolItem): boolean => {
    const crankDir = path.join(String(item.entry.projectRoot), CRANK_DIR);
    return fs.existsSync(path.join(crankDir, CONFIG_FILE)) && loadConfig(crankDir).digest;
  };
  for (const item of readSpool()) if (!wanted(item)) deleteEntry(item.stem);
  for (const item of readParked()) if (!wanted(item)) deleteParked(item.stem);
}

/** The oldest entry that ended, whose transcript has been quiet for QUIET_MS, or whose mid-session window has passed. */
function eligible(
  items: SpoolItem[],
  midSession: { fromMs: Map<string, number>; everyMs: number },
  now: number,
): SpoolItem | undefined {
  const quietBefore = now - QUIET_MS;
  const ready = items.filter((item) => {
    if (item.entry.ended === true) return true;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(item.entry.transcriptPath).mtimeMs;
    } catch {
      return false;
    }
    return (
      mtimeMs < quietBefore || now - (midSession.fromMs.get(item.stem) ?? now) >= midSession.everyMs
    );
  });
  return ready.sort((a, b) => a.entry.updatedAt - b.entry.updatedAt)[0];
}

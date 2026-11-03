import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, positive } from "../cli/args.ts";
import { REPO_ROOT, cliVersion } from "../cli/version.ts";
import { CONFIG_FILE, CRANK_DIR, loadConfig } from "../hooks/lib/config.ts";
import { trySteal } from "../hooks/lib/lock.ts";
import {
  DAEMON_FILE, daemonAlive, deleteEntry, deleteParked, readParked, readSpool, type DaemonState, type SpoolItem,
} from "../hooks/lib/spool.ts";
import { SEEN_DIR, crankHome, ensureCrankHome, readStopState, writeJsonAtomic } from "../hooks/lib/user-state.ts";
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
const SEEN_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

type Options = { sweepMs: number; idleMs: number; retryMs: number; retryCapMs: number; runTimeoutMs: number | null; once: boolean };

export async function run(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, ["sweep-ms", "idle-ms", "retry-ms", "retry-cap-ms", "run-timeout-ms"]);
  const opts: Options = {
    sweepMs: positive(flags["sweep-ms"], SWEEP_MS),
    idleMs: positive(flags["idle-ms"], IDLE_MS),
    retryMs: positive(flags["retry-ms"], RETRY_MS),
    retryCapMs: positive(flags["retry-cap-ms"], RETRY_CAP_MS),
    runTimeoutMs: flags["run-timeout-ms"] === undefined ? null : positive(flags["run-timeout-ms"], RUN_TIMEOUT_MS),
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

  /** One sweep, steps in order. "exit" ends the daemon at once. */
  private sweep(): "exit" | "continue" {
    // 1. Another daemon took the file: leave it to that one.
    if (!ownedBy(this.file, process.pid)) return "exit";
    // 2. Heartbeat. A failed write must not end the daemon mid-job; the next sweep retries it.
    try {
      writeJsonAtomic(this.file, state(this.startVersion));
    } catch (err) {
      console.error(`crank-mem daemon: heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      // 3. The clone was upgraded under us: finish the current job, then let the next start load the new code.
      if (cliVersion() !== this.startVersion) this.stopping = true;
      pruneSeen();
      pruneProjects();
      // 6. Digests stopped (credential or login).
      if (readStopState() !== null) this.stopping = true;
      // 7. Entries whose transcript is gone have nothing left to digest.
      for (const item of readSpool()) if (!fs.existsSync(item.entry.transcriptPath)) deleteEntry(item.stem);
      // 8–9. Start the oldest eligible entry's job when none is running.
      if (!this.stopping && this.job === null) {
        const now = Date.now();
        const next = eligible(readSpool().filter((item) => (this.holds.get(item.stem)?.untilMs ?? 0) <= now));
        if (next) this.startJob(next.stem);
      }
    } catch (err) {
      console.error(`crank-mem daemon: sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 10.
    if (this.job !== null) {
      this.busySince = Date.now();
      return "continue";
    }
    if (this.stopping) return "exit";
    if (readSpool().length > 0) this.busySince = Date.now();
    else if (Date.now() - this.busySince >= this.opts.idleMs) return "exit";
    return "continue";
  }

  private startJob(stem: string): void {
    const argv = ["job", stem];
    if (this.opts.runTimeoutMs !== null) argv.push("--run-timeout-ms", String(this.opts.runTimeoutMs));
    const child = spawn(path.join(REPO_ROOT, "bin", "crank-mem"), argv, { cwd: REPO_ROOT, stdio: "ignore" });
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

  /** Exit 0 clears the stem's hold; any other end holds it for --retry-ms, doubling per failure up to --retry-cap-ms. */
  private settle(stem: string, code: number | null): void {
    if (code === 0) {
      this.holds.delete(stem);
      return;
    }
    const prev = this.holds.get(stem);
    const delayMs = prev ? Math.min(prev.delayMs * 2, this.opts.retryCapMs) : this.opts.retryMs;
    this.holds.set(stem, { untilMs: Date.now() + delayMs, delayMs });
  }
}

/** 4. Drop files under <crank home>/seen/ older than 7 days. */
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

/** 5. Drop spool and parked entries whose project was removed or turned digests off. */
function pruneProjects(): void {
  const wanted = (item: SpoolItem): boolean => {
    const crankDir = path.join(String(item.entry.projectRoot), CRANK_DIR);
    return fs.existsSync(path.join(crankDir, CONFIG_FILE)) && loadConfig(crankDir).digest;
  };
  for (const item of readSpool()) if (!wanted(item)) deleteEntry(item.stem);
  for (const item of readParked()) if (!wanted(item)) deleteParked(item.stem);
}

/** 9. The oldest entry that ended, or whose transcript has been quiet for QUIET_MS. */
function eligible(items: SpoolItem[]): SpoolItem | undefined {
  const quietBefore = Date.now() - QUIET_MS;
  const ready = items.filter((item) => {
    if (item.entry.ended === true) return true;
    try {
      return fs.statSync(item.entry.transcriptPath).mtimeMs < quietBefore;
    } catch {
      return false;
    }
  });
  return ready.sort((a, b) => a.entry.updatedAt - b.entry.updatedAt)[0];
}

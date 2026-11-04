import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Per-user state under <crank home>: $CRANK_HOME when set, otherwise ~/.crank.

export const STOP_FILE = "digest-state.json";
/** Per-session markers of the file histories each agent has already seen. */
export const SEEN_DIR = "seen";

export type StopState = { reason: "credential" | "login"; atMs: number; detail: string };

/** `||`, not `??`: an empty CRANK_HOME would turn every path under it relative. */
export function crankHome(): string {
  return process.env.CRANK_HOME || path.join(os.homedir(), ".crank");
}

export function ensureCrankHome(): string {
  const home = crankHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

let tmpCounter = 0;

/**
 * Write text through a unique temp file and a rename, so a reader never sees a partial file.
 * With `unchangedFrom`, rename only while the file still holds exactly those bytes: a file
 * that changed or vanished since the caller read it is left alone, and the call returns false.
 */
export function writeTextAtomic(file: string, text: string, unchangedFrom: string | null): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    if (unchangedFrom !== null && !holds(file, unchangedFrom)) {
      fs.rmSync(tmp, { force: true });
      return false;
    }
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function holds(file: string, text: string): boolean {
  try {
    return fs.readFileSync(file, "utf-8") === text;
  } catch {
    return false;
  }
}

/** Write JSON through a unique temp file and a rename, so a reader never sees a partial file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, JSON.stringify(value), null);
}

/** The recorded reason digests stopped, or null when none is recorded or the file is unreadable. */
export function readStopState(): StopState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(crankHome(), STOP_FILE), "utf-8"));
    if (parsed?.reason !== "credential" && parsed?.reason !== "login") return null;
    return parsed as StopState;
  } catch {
    return null;
  }
}

export function writeStopState(state: StopState): void {
  writeJsonAtomic(path.join(crankHome(), STOP_FILE), state);
}

export function clearStopState(): void {
  fs.rmSync(path.join(crankHome(), STOP_FILE), { force: true });
}

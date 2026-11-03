import * as fs from "node:fs";
import * as path from "node:path";
import type { CrankConfig } from "./config.ts";
import { debugEvent } from "./debug.ts";
import type { HookPayload } from "./hook-io.ts";
import { crankHome, ensureCrankHome, writeJsonAtomic } from "./user-state.ts";

// The digest spool: one <crank home>/spool/<stem>.json per Claude session that
// has work to digest, keyed by the transcript's basename. Stop and SessionEnd
// write it; the digest job reads it, and parks an entry it cannot finish
// under spool/parked/.

export type SpoolEntry = { transcriptPath: string; projectRoot: string; agent: "claude"; ended: boolean; updatedAt: number };
export type SpoolItem = { stem: string; entry: SpoolEntry };

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
export function writeSignal(transcriptPath: string, projectRoot: string, ended: boolean): void {
  const stem = transcriptStem(transcriptPath);
  if (!stem) return;
  ensureCrankHome();
  deleteParked(stem);
  const entry: SpoolEntry = { transcriptPath, projectRoot, agent: "claude", ended, updatedAt: Date.now() };
  writeJsonAtomic(path.join(spoolDir(), stem + EXT), entry);
}

/** The hooks' entry point: signal when the project turned digests on. Never throws. */
export function signalDigest(payload: HookPayload, projectRoot: string, config: CrankConfig, ended: boolean): void {
  if (!config.digest || typeof payload.transcript_path !== "string") return;
  try {
    writeSignal(payload.transcript_path, projectRoot, ended);
  } catch (err) {
    debugEvent("signal-failed", { error: err instanceof Error ? err.message : String(err) });
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
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8"));
      if (typeof entry === "object" && entry !== null) items.push({ stem: name.slice(0, -EXT.length), entry });
    } catch {
      // Unparseable or vanished mid-read: skip it.
    }
  }
  return items;
}

export function readSpool(): SpoolItem[] {
  return readEntries(spoolDir());
}

export function readParked(): SpoolItem[] {
  return readEntries(parkedDir());
}

export function parkEntry(stem: string): void {
  fs.mkdirSync(parkedDir(), { recursive: true, mode: 0o700 });
  fs.renameSync(path.join(spoolDir(), stem + EXT), path.join(parkedDir(), stem + EXT));
}

export function deleteEntry(stem: string): void {
  fs.rmSync(path.join(spoolDir(), stem + EXT), { force: true });
}

export function deleteParked(stem: string): void {
  fs.rmSync(path.join(parkedDir(), stem + EXT), { force: true });
}

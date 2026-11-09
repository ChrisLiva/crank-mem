import * as fs from "node:fs";
import * as path from "node:path";
import { CEREBRUM_FILE, fileStamp, manifestDirs } from "../hooks/lib/cerebrum-files.ts";
import { errorMessage, isObj } from "../hooks/lib/config.ts";
import { repoRelative } from "../hooks/lib/hook-io.ts";

// Backups of every file init/upgrade is about to modify, with a manifest
// mapping copy names to original absolute paths. Files that did not exist are
// recorded as absent. Read together, oldest dir first, the manifests form the
// install record: the first entry per path is that file as it was before
// crank-mem first changed it. Restore replays that entry for paths inside the
// project, leaves every other path as is, and never replays .crank/cerebrum.md.

interface ManifestEntry {
  original: string;
  backupFile: string | null; // Null means the file did not exist at backup time.
}

interface Manifest {
  createdAt: string;
  entries: ManifestEntry[];
}

export function newBackupDir(crankDir: string): string {
  const stamp = fileStamp();
  const dir = path.join(crankDir, "backups", stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ createdAt: stamp, entries: [] }, null, 2),
  );
  return dir;
}

function loadManifest(backupDir: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf-8"));
}

function saveManifest(backupDir: string, m: Manifest): void {
  fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify(m, null, 2));
}

/** Snapshot a file before modification (records absence too). Idempotent per path. */
export function backupFile(backupDir: string, originalPath: string): void {
  const m = loadManifest(backupDir);
  if (m.entries.some((e) => e.original === originalPath)) return;
  let backupFileName: string | null = null;
  if (fs.existsSync(originalPath)) {
    backupFileName = m.entries.length + "-" + path.basename(originalPath);
    fs.copyFileSync(originalPath, path.join(backupDir, backupFileName));
  }
  m.entries.push({ original: originalPath, backupFile: backupFileName });
  saveManifest(backupDir, m);
}

export type RestoredPath =
  | { path: string; outcome: "copied" }
  | { path: string; outcome: "removed" } // earliest record says absent, and the file existed
  | { path: string; outcome: "outside" } // outside the project root, left as is
  | { path: string; outcome: "failed"; code: string };

export type RestoreResult =
  | { status: "no-backups" }
  | { status: "unreadable"; manifest: string; detail: string }
  | { status: "replayed"; paths: RestoredPath[] };

type InstallRecord = Map<string, { dir: string; backupFile: string | null }>;

/** A copy name `backupFile` writes: one path segment, never `.` or `..`. */
function isBareName(v: unknown): boolean {
  return (
    typeof v === "string" &&
    v !== "" &&
    v !== "." &&
    v !== ".." &&
    !v.includes("/") &&
    !v.includes("\\")
  );
}

function isEntry(e: unknown): e is ManifestEntry {
  return (
    isObj(e) &&
    typeof e.original === "string" &&
    (e.backupFile === null || isBareName(e.backupFile))
  );
}

/** The manifest's entries, or why it cannot be read as a crank-mem manifest. */
function readEntries(manifest: string): ManifestEntry[] | { detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, "utf-8"));
  } catch (err) {
    return { detail: errorMessage(err) };
  }
  const entries = isObj(parsed) ? parsed.entries : undefined;
  if (!Array.isArray(entries) || !entries.every(isEntry)) {
    return { detail: "not a crank-mem manifest" };
  }
  return entries;
}

/**
 * The first entry per `original`, oldest manifest dir first, with the dir that
 * holds its copy, or the first manifest that cannot be read.
 */
function readInstallRecord(
  crankDir: string,
): { record: InstallRecord } | { manifest: string; detail: string } {
  const record: InstallRecord = new Map();
  for (const d of manifestDirs(crankDir)) {
    const dir = path.join(crankDir, "backups", d);
    const manifest = path.join(dir, "manifest.json");
    const entries = readEntries(manifest);
    if (!Array.isArray(entries)) return { manifest, detail: entries.detail };
    for (const e of entries) {
      if (!record.has(e.original)) record.set(e.original, { dir, backupFile: e.backupFile });
    }
  }
  return { record };
}

/**
 * True iff every manifest reads and the earliest entry whose `original` ===
 * `file` (an absolute path, compared as a string) says it was absent. Any doubt
 * keeps the file. Never throws.
 */
export function createdByCrank(crankDir: string, file: string): boolean {
  const read = readInstallRecord(crankDir);
  return "record" in read && read.record.get(file)?.backupFile === null;
}

/** Replays the earliest copy of each recorded path inside the project. Never throws. */
export function restoreInstall(crankDir: string): RestoreResult {
  if (manifestDirs(crankDir).length === 0) return { status: "no-backups" };
  const read = readInstallRecord(crankDir);
  if (!("record" in read)) return { status: "unreadable", ...read };
  const root = path.dirname(crankDir);
  const cerebrum = path.join(crankDir, CEREBRUM_FILE);
  const paths: RestoredPath[] = [];
  for (const [original, { dir, backupFile }] of read.record) {
    if (original === cerebrum) continue;
    if (!path.isAbsolute(original) || repoRelative(root, root, original) === null) {
      paths.push({ path: original, outcome: "outside" });
      continue;
    }
    try {
      if (backupFile !== null) {
        fs.mkdirSync(path.dirname(original), { recursive: true });
        fs.copyFileSync(path.join(dir, backupFile), original);
        paths.push({ path: original, outcome: "copied" });
      } else if (fs.existsSync(original)) {
        fs.unlinkSync(original);
        paths.push({ path: original, outcome: "removed" });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      paths.push({
        path: original,
        outcome: "failed",
        code: typeof code === "string" ? code : "error",
      });
    }
  }
  return { status: "replayed", paths };
}

import * as fs from "node:fs";
import * as path from "node:path";
import { CEREBRUM_FILE, fileStamp, manifestDirs } from "../hooks/lib/cerebrum-files.ts";
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

/**
 * True iff a manifest proves `originalPath` did not exist before init. The
 * oldest manifest mentioning the path wins — that's the init-time record;
 * later (upgrade) backups don't cover it. No mention anywhere ⇒ false (when
 * in doubt, keep the file).
 */
export function absentAtInit(crankDir: string, originalPath: string): boolean {
  const base = path.join(crankDir, "backups");
  for (const d of manifestDirs(crankDir)) {
    try {
      const entry = loadManifest(path.join(base, d)).entries.find(
        (e) => e.original === originalPath,
      );
      if (entry) return entry.backupFile === null;
    } catch {}
  }
  return false;
}

export type RestoredPath =
  | { path: string; outcome: "copied" }
  | { path: string; outcome: "removed" } // earliest record says absent, and the file existed
  | { path: string; outcome: "outside" }; // outside the project root, left as is

export type RestoreResult =
  | { status: "no-backups" }
  | { status: "replayed"; paths: RestoredPath[] };

/** The first entry per `original`, oldest manifest dir first, with the dir that holds its copy. */
function installRecord(crankDir: string): Map<string, { dir: string; backupFile: string | null }> {
  const record = new Map<string, { dir: string; backupFile: string | null }>();
  for (const d of manifestDirs(crankDir)) {
    const dir = path.join(crankDir, "backups", d);
    for (const e of loadManifest(dir).entries) {
      if (!record.has(e.original)) record.set(e.original, { dir, backupFile: e.backupFile });
    }
  }
  return record;
}

/** Replays the earliest copy of each recorded path inside the project. */
export function restoreInstall(crankDir: string): RestoreResult {
  if (manifestDirs(crankDir).length === 0) return { status: "no-backups" };
  const root = path.dirname(crankDir);
  const cerebrum = path.join(crankDir, CEREBRUM_FILE);
  const paths: RestoredPath[] = [];
  for (const [original, { dir, backupFile }] of installRecord(crankDir)) {
    if (original === cerebrum) continue;
    if (!path.isAbsolute(original) || repoRelative(root, root, original) === null) {
      paths.push({ path: original, outcome: "outside" });
    } else if (backupFile !== null) {
      fs.mkdirSync(path.dirname(original), { recursive: true });
      fs.copyFileSync(path.join(dir, backupFile), original);
      paths.push({ path: original, outcome: "copied" });
    } else if (fs.existsSync(original)) {
      fs.unlinkSync(original);
      paths.push({ path: original, outcome: "removed" });
    }
  }
  return { status: "replayed", paths };
}

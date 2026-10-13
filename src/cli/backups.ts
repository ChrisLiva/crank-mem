import * as fs from "node:fs";
import * as path from "node:path";

// Backups of every file init/upgrade is about to modify, with a manifest
// mapping backup names to original absolute paths so uninstall can restore
// byte-identically. Files that did not exist are recorded as "absent" and
// deleted on restore.

interface ManifestEntry {
  original: string;
  backupFile: string | null; // null ⇒ file did not exist before init
}

interface Manifest {
  createdAt: string;
  entries: ManifestEntry[];
}

export function newBackupDir(crankDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(crankDir, "backups", stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ createdAt: stamp, entries: [] }, null, 2));
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

/** Latest backup dir under .crank/backups, or null. */
export function latestBackupDir(crankDir: string): string | null {
  const base = path.join(crankDir, "backups");
  try {
    const dirs = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, "manifest.json"))).sort();
    const last = dirs[dirs.length - 1];
    return last ? path.join(base, last) : null;
  } catch {
    return null;
  }
}

/**
 * True iff a manifest proves `originalPath` did not exist before init. The
 * oldest manifest mentioning the path wins — that's the init-time record;
 * later (upgrade) backups don't cover it. No mention anywhere ⇒ false (when
 * in doubt, keep the file).
 */
export function absentAtInit(crankDir: string, originalPath: string): boolean {
  const base = path.join(crankDir, "backups");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(base).sort();
  } catch {
    return false;
  }
  for (const d of dirs) {
    try {
      const entry = loadManifest(path.join(base, d)).entries.find((e) => e.original === originalPath);
      if (entry) return entry.backupFile === null;
    } catch {}
  }
  return false;
}

/** Restore every manifest entry: copy back, or delete files that were absent. */
export function restoreBackup(backupDir: string): string[] {
  const m = loadManifest(backupDir);
  const restored: string[] = [];
  for (const e of m.entries) {
    if (e.backupFile) {
      fs.mkdirSync(path.dirname(e.original), { recursive: true });
      fs.copyFileSync(path.join(backupDir, e.backupFile), e.original);
      restored.push(e.original);
    } else if (fs.existsSync(e.original)) {
      fs.unlinkSync(e.original);
      restored.push(e.original + " (removed — did not exist before init)");
    }
  }
  return restored;
}

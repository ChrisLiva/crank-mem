import * as fs from "node:fs";
import * as path from "node:path";
import { CRANK_HOOK_MARKER } from "./settings.ts";
import { backupFile, createdByCrank } from "./backups.ts";
import type { OpenedProject } from "./project.ts";
import { errorMessage, type CodexChoice, type CrankConfig } from "../hooks/lib/config.ts";
import { repoRelative } from "../hooks/lib/hook-io.ts";

// The report type, paths and file helpers every install item shares.

export interface Report {
  lines: string[];
  warnings: string[];
  failed: boolean;
}

export function installPaths(root: string): {
  claudeShared: string;
  claudeLocal: string;
  codexHooks: string;
  codexConfig: string;
  gitignore: string;
  gitExclude: string;
} {
  return {
    claudeShared: path.join(root, ".claude", "settings.json"),
    claudeLocal: path.join(root, ".claude", "settings.local.json"),
    codexHooks: path.join(root, ".codex", "hooks.json"),
    codexConfig: path.join(root, ".codex", "config.toml"),
    gitignore: path.join(root, ".gitignore"),
    gitExclude: path.join(root, ".git", "info", "exclude"),
  };
}

/** The Claude settings file a git mode wires, and the other one, which must hold no crank hooks. */
export function claudeSettingsFiles(
  root: string,
  git: CrankConfig["git"],
): { wired: string; other: string } {
  const { claudeShared, claudeLocal } = installPaths(root);
  return git === "commit"
    ? { wired: claudeShared, other: claudeLocal }
    : { wired: claudeLocal, other: claudeShared };
}

/** The file that holds a git mode's ignore block, or null: commit mode has none, and exclude mode needs a .git directory. */
export function modeIgnoreFile(root: string, git: CrankConfig["git"]): string | null {
  const { gitignore, gitExclude } = installPaths(root);
  if (git === "ignore") return gitignore;
  if (git === "exclude" && fs.existsSync(path.join(root, ".git"))) return gitExclude;
  return null;
}

export interface InstallContext {
  root: string;
  crankDir: string;
  /**
   * The vendored-hooks item's repair sets `vendored_version` here in place once
   * the new copy is in place; upgrade reads it back to pick its summary line.
   */
  config: CrankConfig & { codex: CodexChoice };
  /** The run's backup dir, created on first call. */
  backupDir: () => string;
}

export interface InstallItem {
  /** Install the item for a fresh init; throws on failure. */
  apply(ctx: InstallContext): Report;
  repair(ctx: InstallContext): Report;
  remove(project: OpenedProject): Report;
}

export function report(lines: string[] = []): Report {
  return { lines, warnings: [], failed: false };
}

export function mergeReports(reports: Report[]): Report {
  return {
    lines: reports.flatMap((r) => r.lines),
    warnings: reports.flatMap((r) => r.warnings),
    failed: reports.some((r) => r.failed),
  };
}

export const isEmptyJson = (text: string): boolean => JSON.stringify(JSON.parse(text)) === "{}";
export const isBlank = (text: string): boolean => text.trim() === "";

export function backupWith(ctx: InstallContext): (file: string) => void {
  return (file) => backupFile(ctx.backupDir(), file);
}

/** Run one item's repair, turning a throw into `crank-mem: could not <action> (…)` on `r`. */
export function attemptRepair(r: Report, action: string, steps: () => void): void {
  try {
    steps();
  } catch (err) {
    r.warnings.push(`crank-mem: could not ${action} (${errorMessage(err)})`);
    r.failed = true;
  }
}

export function pushLine(lines: string[], line: string | null): void {
  if (line !== null) lines.push(line);
}

function removalWarning(root: string, file: string, err: unknown): string {
  const detail = errorMessage(err);
  return `crank-mem: could not remove crank-mem's entries from ${repoRelative(root, root, file) ?? file} (${detail})`;
}

/** Run one file's removal steps, turning a throw into `file`'s warning on `r`. */
export function attemptRemoval(r: Report, root: string, file: string, steps: () => void): void {
  try {
    steps();
  } catch (err) {
    r.warnings.push(removalWarning(root, file, err));
    r.failed = true;
  }
}

/** Flag a file that still exists, does not parse, and names crank-mem — its entries stay. */
export function checkParseable(r: Report, root: string, file: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf-8");
  try {
    JSON.parse(text);
  } catch {
    if (text.includes(CRANK_HOOK_MARKER) || text.includes("crank-mem")) {
      r.warnings.push(removalWarning(root, file, "not valid JSON"));
      r.failed = true;
    }
  }
}

/**
 * Delete `file` and return `  deleted now-empty <rel>` when it exists, crank-mem
 * created it, and `isEmpty` holds for its text; otherwise null. A user's own
 * blank or `{}` file survives, and an `isEmpty` that throws counts as not
 * empty. An fs error reading or unlinking the file propagates.
 */
export function deleteNowEmpty(
  root: string,
  crankDir: string,
  file: string,
  isEmpty: (text: string) => boolean,
): string | null {
  if (!fs.existsSync(file) || !createdByCrank(crankDir, file)) return null;
  const text = fs.readFileSync(file, "utf-8");
  try {
    if (!isEmpty(text)) return null;
  } catch {
    return null;
  }
  fs.unlinkSync(file);
  return `  deleted now-empty ${path.relative(root, file)}`;
}

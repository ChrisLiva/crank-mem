import * as fs from "node:fs";
import * as path from "node:path";
import {
  CRANK_HOOK_MARKER,
  addAllowRule,
  addIgnoreLines,
  claudeSettingsFiles,
  crankHooks,
  ensureCodexFeatures,
  ensureCrankGitignore,
  hasCrankHooks,
  isCrankHookCommand,
  mergeHooksIntoFile,
  modeIgnoreFile,
  removeAllowRule,
  removeCodexFeatures,
  removeCrankHooksFromFile,
  removeIgnoreLines,
  unignoreCerebrum,
} from "./settings.ts";
import {
  CODEX_REVIEW_HINT,
  codexTrustStatus,
  crankTrust,
  removeTrustEntries,
  userCodexConfigPath,
  writeTrustEntries,
} from "./codex-trust.ts";
import { registerProject, unregisterProject } from "./registry.ts";
import { backupFile, createdByCrank } from "./backups.ts";
import { templatePath, vendorHooks, vendoredHooksCurrent } from "./vendor.ts";
import { cliVersion } from "./version.ts";
import type { OpenedProject } from "./project.ts";
import { saveConfig, type CodexChoice, type CrankConfig } from "../hooks/lib/config.ts";
import { backupCerebrum, CEREBRUM_FILE, splitPreamble } from "../hooks/lib/cerebrum-files.ts";
import { repoRelative } from "../hooks/lib/hook-io.ts";

// The ordered list of everything crank-mem installs into a project. Each
// command prints a Report's lines to stdout and its warnings to stderr; the
// items themselves print nothing.

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

export interface InstallContext {
  root: string;
  crankDir: string;
  config: CrankConfig & { codex: CodexChoice };
  /** The run's backup dir, created on first call. */
  backupDir: () => string;
}

interface InstallItem {
  repair(ctx: InstallContext): Report;
  remove(project: OpenedProject): Report;
}

/** The recorded Codex choice, or for a legacy config the one its wiring implies. */
export function resolveCodex(root: string, config: CrankConfig): CodexChoice {
  if (config.codex !== null) return config.codex;
  return hasCrankHooks(installPaths(root).codexHooks) ? "review" : "skip";
}

/** Each of `r.lines` to stdout, then each of `r.warnings` to stderr. */
export function printReport(r: Report): void {
  for (const line of r.lines) console.log(line);
  for (const warning of r.warnings) console.error(warning);
}

function report(lines: string[] = []): Report {
  return { lines, warnings: [], failed: false };
}

function mergeReports(reports: Report[]): Report {
  return {
    lines: reports.flatMap((r) => r.lines),
    warnings: reports.flatMap((r) => r.warnings),
    failed: reports.some((r) => r.failed),
  };
}

const isEmptyJson = (text: string): boolean => JSON.stringify(JSON.parse(text)) === "{}";
const isBlank = (text: string): boolean => text.trim() === "";

const vendoredHooks: InstallItem = {
  // A version change re-vendors whether or not the trees differ; at the same
  // version, a pull or a hand edit that leaves .crank/hooks/ unlike the clone
  // re-vendors too. The stamp moves only once the copy is in place.
  repair(ctx) {
    const { crankDir, config } = ctx;
    const r = report();
    attemptRepair(r, "re-vendor .crank/hooks/", () => {
      const versionCurrent = config.vendored_version === cliVersion();
      if (versionCurrent && vendoredHooksCurrent(crankDir)) return;
      const hooksDir = path.join(crankDir, "hooks");
      if (fs.existsSync(hooksDir))
        fs.cpSync(hooksDir, path.join(ctx.backupDir(), "hooks"), { recursive: true });
      vendorHooks(crankDir);
      config.vendored_version = cliVersion();
      saveConfig(crankDir, config);
      if (versionCurrent)
        r.lines.push("  re-vendored .crank/hooks/, which differed from the clone");
    });
    return r;
  },
  remove: () => report(),
};

const claudeWiring: InstallItem = {
  // Crank hooks left in the Claude settings file the git mode does not use run
  // every event twice.
  repair(ctx) {
    const { root, config } = ctx;
    const backup = backupWith(ctx);
    const r = report();
    attemptRepair(r, "re-wire Claude Code hooks", () => {
      const { wired, other } = claudeSettingsFiles(root, config.git);
      if (hasCrankHooks(other)) {
        removeCrankHooksFromFile(other, isCrankHookCommand, backup);
        r.lines.push(`  removed duplicate crank hooks from ${path.relative(root, other)}`);
      }
      if (mergeHooksIntoFile(wired, crankHooks(config.runtime, "claude"), backup))
        r.lines.push(`  re-wired Claude Code hooks in ${path.relative(root, wired)}`);
      if (addAllowRule(wired, backup))
        r.lines.push("  added the crank-mem rules to permissions.allow");
    });
    return r;
  },
  remove({ root, crankDir }) {
    const { claudeShared, claudeLocal } = installPaths(root);
    const r = report();
    for (const f of [claudeShared, claudeLocal]) {
      attemptRemoval(r, root, f, () => {
        const rel = path.relative(root, f);
        let wrote = false;
        if (removeCrankHooksFromFile(f)) {
          r.lines.push(`  removed crank hooks from ${rel}`);
          wrote = true;
        }
        if (removeAllowRule(f)) {
          r.lines.push(`  removed the crank-mem allow rules from ${rel}`);
          wrote = true;
        }
        pushLine(r.lines, deleteNowEmpty(root, crankDir, f, isEmptyJson));
        if (!wrote) checkParseable(r, root, f);
      });
    }
    return r;
  },
};

const codexWiring: InstallItem = {
  // A skip install leaves .codex/ alone. Trust is rewritten only when an entry
  // is missing or stale or an older release's PascalCase orphan is present, so
  // an install already trusted keeps its config.toml untouched.
  repair(ctx) {
    const { root, config } = ctx;
    const r = report();
    if (config.codex === "skip") return r;
    const backup = backupWith(ctx);
    const { codexHooks, codexConfig } = installPaths(root);
    attemptRepair(r, "re-wire Codex hooks", () => {
      if (mergeHooksIntoFile(codexHooks, crankHooks(config.runtime, "codex"), backup)) {
        r.lines.push(`  re-wired Codex hooks in ${path.relative(root, codexHooks)}`);
        if (config.codex === "review") r.lines.push(...CODEX_REVIEW_HINT);
      }
      if (ensureCodexFeatures(codexConfig, backup))
        r.lines.push(
          `  added the crank-mem [features] snippet to ${path.relative(root, codexConfig)}`,
        );
      if (config.codex === "trust") {
        const s = codexTrustStatus(userCodexConfigPath(), root, codexHooks);
        if (s.missing + s.stale + s.orphans > 0) {
          const t = crankTrust(codexHooks);
          writeTrustEntries(userCodexConfigPath(), t.entries, t.staleKeys, backup);
          r.lines.push("  recomputed Codex trusted_hash entries");
        }
      }
    });
    return r;
  },
  remove({ root, crankDir, config }) {
    const { codexHooks, codexConfig } = installPaths(root);
    const r = report();
    // Trust keys come from hooks.json as it stands, before the hooks strip.
    // Both spellings go — older releases keyed on the raw PascalCase event.
    if (config.codex === "trust") {
      attemptRemoval(r, root, userCodexConfigPath(), () => {
        const keys = crankTrust(codexHooks).keys;
        if (keys.length > 0) {
          removeTrustEntries(userCodexConfigPath(), keys);
          r.lines.push(`  removed trusted_hash entries from ${userCodexConfigPath()}`);
        }
      });
    }
    attemptRemoval(r, root, codexHooks, () => {
      const wrote = removeCrankHooksFromFile(codexHooks);
      if (wrote) r.lines.push(`  removed crank hooks from ${path.relative(root, codexHooks)}`);
      pushLine(r.lines, deleteNowEmpty(root, crankDir, codexHooks, isEmptyJson));
      if (!wrote) checkParseable(r, root, codexHooks);
    });
    attemptRemoval(r, root, codexConfig, () => {
      removeCodexFeatures(codexConfig);
      pushLine(r.lines, deleteNowEmpty(root, crankDir, codexConfig, isBlank));
    });
    return r;
  },
};

const crankGitignore: InstallItem = {
  // An install from before the allowlist keeps a denylist that misses state
  // files added since, and every file another tool sharing .crank/ writes.
  repair(ctx) {
    const r = report();
    attemptRepair(r, "write .crank/.gitignore", () => {
      if (ensureCrankGitignore(ctx.crankDir, backupWith(ctx)))
        r.lines.push(`  wrote the allowlist .crank/.gitignore`);
    });
    return r;
  },
  remove: () => report(),
};

const gitIgnoreState: InstallItem = {
  // Commit mode loses a stale crank-mem ignore block, which keeps cerebrum out
  // of git; ignore and exclude mode regain a missing one, whose absence exposes
  // .crank/ to git.
  repair(ctx) {
    const { root, config } = ctx;
    const backup = backupWith(ctx);
    const r = report();
    if (config.git === "commit") {
      attemptRepair(r, "check .crank/cerebrum.md against git ignores", () => {
        const ignoredBy = unignoreCerebrum(root, (f) => {
          backup(f);
          r.lines.push(
            `  removed the crank-mem .crank/ ignore block from ${path.relative(root, f)}`,
          );
        });
        if (ignoredBy)
          r.warnings.push(
            `crank-mem: warning: git ignores .crank/cerebrum.md via ${ignoredBy}, so commit mode cannot track it.`,
          );
      });
      return r;
    }
    const ignoreFile = modeIgnoreFile(root, config.git);
    if (ignoreFile) {
      attemptRepair(r, `write ${path.relative(root, ignoreFile)}`, () => {
        if (addIgnoreLines(ignoreFile, backup))
          r.lines.push(
            `  added the crank-mem .crank/ ignore block to ${path.relative(root, ignoreFile)}`,
          );
      });
    }
    return r;
  },
  remove({ root, crankDir }) {
    const { gitignore, gitExclude } = installPaths(root);
    const r = report();
    attemptRemoval(r, root, gitignore, () => {
      removeIgnoreLines(gitignore);
      pushLine(r.lines, deleteNowEmpty(root, crankDir, gitignore, isBlank));
    });
    attemptRemoval(r, root, gitExclude, () => removeIgnoreLines(gitExclude));
    return r;
  },
};

const cerebrum: InstallItem = {
  repair({ crankDir }) {
    const r = report();
    const cerebrumPath = path.join(crankDir, CEREBRUM_FILE);
    if (!fs.existsSync(cerebrumPath)) {
      attemptRepair(r, `seed .crank/${CEREBRUM_FILE} from the template`, () => {
        fs.copyFileSync(templatePath(CEREBRUM_FILE), cerebrumPath);
        r.lines.push(`  seeded .crank/${CEREBRUM_FILE} from the template`);
      });
      return r;
    }
    // 0.8.1 and earlier seeded the cerebrum with a protocol preamble telling
    // agents how to keep it; consolidation keeps it now, so an unedited copy of
    // that preamble gives way to the current template's. An edited one is the
    // user's and stays. latin1 maps each byte to one char, so the body's bytes
    // survive the rewrite even when they are not valid UTF-8.
    attemptRepair(r, `replace the template preamble of .crank/${CEREBRUM_FILE}`, () => {
      const { preamble, body } = splitPreamble(fs.readFileSync(cerebrumPath, "latin1"));
      if (preamble === fs.readFileSync(templatePath("cerebrum-preamble-0.8.1.md"), "latin1")) {
        const fresh = splitPreamble(
          fs.readFileSync(templatePath(CEREBRUM_FILE), "latin1"),
        ).preamble;
        if (backupCerebrum(crankDir, fs.readFileSync(cerebrumPath)) === null)
          throw new Error("could not back up the cerebrum");
        fs.writeFileSync(cerebrumPath, fresh + (body ?? ""), "latin1");
        r.lines.push(`  replaced the template preamble of .crank/${CEREBRUM_FILE}`);
      }
    });
    return r;
  },
  remove: () => report(),
};

const registry: InstallItem = {
  repair({ root }) {
    registerProject(root);
    return report();
  },
  remove({ root }) {
    unregisterProject(root);
    return report();
  },
};

const ITEMS: InstallItem[] = [
  vendoredHooks,
  claudeWiring,
  codexWiring,
  crankGitignore,
  gitIgnoreState,
  cerebrum,
  registry,
];

/**
 * Bring every item back to the recorded install, in list order. Never throws:
 * an item that fails becomes a warning and sets `failed`, and the walk carries
 * on with the next item.
 */
export function repairInstall(ctx: InstallContext): Report {
  return mergeReports(ITEMS.map((item) => item.repair(ctx)));
}

/**
 * Strip crank-mem's own entries from every item, last installed first.
 * Idempotent. Never throws: a file it cannot clean becomes a warning and sets
 * `failed`, and the walk carries on with the next file.
 */
export function removeInstall(project: OpenedProject): Report {
  return mergeReports([...ITEMS].reverse().map((item) => item.remove(project)));
}

function backupWith(ctx: InstallContext): (file: string) => void {
  return (file) => backupFile(ctx.backupDir(), file);
}

/** Run one item's repair, turning a throw into `crank-mem: could not <action> (…)` on `r`. */
function attemptRepair(r: Report, action: string, steps: () => void): void {
  try {
    steps();
  } catch (err) {
    r.warnings.push(
      `crank-mem: could not ${action} (${err instanceof Error ? err.message : String(err)})`,
    );
    r.failed = true;
  }
}

function pushLine(lines: string[], line: string | null): void {
  if (line !== null) lines.push(line);
}

export function removalWarning(root: string, file: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
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
function checkParseable(r: Report, root: string, file: string): void {
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
function deleteNowEmpty(
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

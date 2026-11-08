import * as fs from "node:fs";
import * as path from "node:path";
import {
  CRANK_HOOK_MARKER,
  removeAllowRule,
  removeCodexFeatures,
  removeCrankHooksFromFile,
  removeIgnoreLines,
} from "./settings.ts";
import { crankTrust, removeTrustEntries, userCodexConfigPath } from "./codex-trust.ts";
import { unregisterProject } from "./registry.ts";
import { createdByCrank } from "./backups.ts";
import type { OpenedProject } from "./project.ts";
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

interface InstallItem {
  remove(project: OpenedProject): Report;
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
  remove: () => report(),
};

const claudeWiring: InstallItem = {
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
  remove: () => report(),
};

const gitIgnoreState: InstallItem = {
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
  remove: () => report(),
};

const registry: InstallItem = {
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
 * Strip crank-mem's own entries from every item, last installed first.
 * Idempotent. Never throws: a file it cannot clean becomes a warning and sets
 * `failed`, and the walk carries on with the next file.
 */
export function removeInstall(project: OpenedProject): Report {
  return mergeReports([...ITEMS].reverse().map((item) => item.remove(project)));
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

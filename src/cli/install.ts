import * as fs from "node:fs";
import * as path from "node:path";
import {
  removeAllowRule,
  removeCodexFeatures,
  removeCrankHooksFromFile,
  removeIgnoreLines,
} from "./settings.ts";
import { crankTrust, removeTrustEntries, userCodexConfigPath } from "./codex-trust.ts";
import { unregisterProject } from "./registry.ts";
import { createdByCrank } from "./backups.ts";
import type { OpenedProject } from "./project.ts";

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
    const lines: string[] = [];
    for (const f of [claudeShared, claudeLocal]) {
      const rel = path.relative(root, f);
      if (removeCrankHooksFromFile(f)) lines.push(`  removed crank hooks from ${rel}`);
      if (removeAllowRule(f)) lines.push(`  removed the crank-mem allow rules from ${rel}`);
      pushLine(lines, deleteNowEmpty(root, crankDir, f, isEmptyJson));
    }
    return report(lines);
  },
};

const codexWiring: InstallItem = {
  remove({ root, crankDir, config }) {
    const { codexHooks, codexConfig } = installPaths(root);
    const lines: string[] = [];
    // Trust keys come from hooks.json as it stands, before the hooks strip.
    // Both spellings go — older releases keyed on the raw PascalCase event.
    if (config.codex === "trust") {
      const keys = crankTrust(codexHooks).keys;
      if (keys.length > 0) {
        removeTrustEntries(userCodexConfigPath(), keys);
        lines.push(`  removed trusted_hash entries from ${userCodexConfigPath()}`);
      }
    }
    if (removeCrankHooksFromFile(codexHooks))
      lines.push(`  removed crank hooks from ${path.relative(root, codexHooks)}`);
    removeCodexFeatures(codexConfig);
    pushLine(lines, deleteNowEmpty(root, crankDir, codexHooks, isEmptyJson));
    pushLine(lines, deleteNowEmpty(root, crankDir, codexConfig, isBlank));
    return report(lines);
  },
};

const crankGitignore: InstallItem = {
  remove: () => report(),
};

const gitIgnoreState: InstallItem = {
  remove({ root, crankDir }) {
    const { gitignore, gitExclude } = installPaths(root);
    const lines: string[] = [];
    removeIgnoreLines(gitignore);
    pushLine(lines, deleteNowEmpty(root, crankDir, gitignore, isBlank));
    removeIgnoreLines(gitExclude);
    return report(lines);
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

/** Strip crank-mem's own entries from every item, last installed first. Idempotent. */
export function removeInstall(project: OpenedProject): Report {
  return mergeReports([...ITEMS].reverse().map((item) => item.remove(project)));
}

function pushLine(lines: string[], line: string | null): void {
  if (line !== null) lines.push(line);
}

/**
 * Delete `file` and return `  deleted now-empty <rel>` when it exists, crank-mem
 * created it, and `isEmpty` holds for its text; otherwise null. A user's own
 * blank or `{}` file survives. Never throws.
 */
function deleteNowEmpty(
  root: string,
  crankDir: string,
  file: string,
  isEmpty: (text: string) => boolean,
): string | null {
  try {
    if (!fs.existsSync(file) || !createdByCrank(crankDir, file)) return null;
    if (isEmpty(fs.readFileSync(file, "utf-8"))) {
      fs.unlinkSync(file);
      return `  deleted now-empty ${path.relative(root, file)}`;
    }
  } catch {}
  return null;
}

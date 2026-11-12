import * as path from "node:path";
import {
  addIgnoreLines,
  ensureCrankGitignore,
  removeIgnoreLines,
  unignoreCerebrum,
} from "./settings.ts";
import {
  attemptRemoval,
  attemptRepair,
  backupWith,
  deleteNowEmpty,
  installPaths,
  isBlank,
  modeIgnoreFile,
  pushLine,
  report,
  type InstallContext,
  type InstallItem,
  type Report,
} from "./install-support.ts";

// The .crank/.gitignore and git ignore state install items.

export const crankGitignore: InstallItem = {
  apply(ctx) {
    ensureCrankGitignore(ctx.crankDir, backupWith(ctx));
    return report();
  },
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

// Commit mode loses a stale crank-mem ignore block, which keeps cerebrum out of
// git, and warns when another ignore rule still hides it.
function unignoreForCommit(r: Report, root: string, backup: (file: string) => void): void {
  const ignoredBy = unignoreCerebrum(root, (f) => {
    backup(f);
    r.lines.push(`  removed the crank-mem .crank/ ignore block from ${path.relative(root, f)}`);
  });
  if (ignoredBy)
    r.warnings.push(
      `crank-mem: warning: git ignores .crank/cerebrum.md via ${ignoredBy}, so commit mode cannot track it.`,
    );
}

// Commit mode drops a stale ignore block; ignore and exclude mode regain a
// missing one, whose absence exposes .crank/ to git. Returns the ignore file
// it added the block to, or null.
function ensureGitIgnoreState(ctx: InstallContext, r: Report): string | null {
  const { root, config } = ctx;
  const backup = backupWith(ctx);
  if (config.git === "commit") {
    unignoreForCommit(r, root, backup);
    return null;
  }
  const ignoreFile = modeIgnoreFile(root, config.git);
  return ignoreFile !== null && addIgnoreLines(ignoreFile, backup) ? ignoreFile : null;
}

export const gitIgnoreState: InstallItem = {
  apply(ctx) {
    const r = report();
    ensureGitIgnoreState(ctx, r);
    return r;
  },
  repair(ctx) {
    const { root, config } = ctx;
    const r = report();
    const ignoreFile = modeIgnoreFile(root, config.git);
    const action =
      ignoreFile === null
        ? "check .crank/cerebrum.md against git ignores"
        : `write ${path.relative(root, ignoreFile)}`;
    attemptRepair(r, action, () => {
      const added = ensureGitIgnoreState(ctx, r);
      if (added !== null)
        r.lines.push(`  added the crank-mem .crank/ ignore block to ${path.relative(root, added)}`);
    });
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

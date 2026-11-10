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

export const gitIgnoreState: InstallItem = {
  apply(ctx) {
    const { root, config } = ctx;
    const backup = backupWith(ctx);
    const r = report();
    if (config.git === "commit") {
      unignoreForCommit(r, root, backup);
      return r;
    }
    const ignoreFile = modeIgnoreFile(root, config.git);
    if (ignoreFile) addIgnoreLines(ignoreFile, backup);
    return r;
  },
  // Ignore and exclude mode regain a missing ignore block, whose absence
  // exposes .crank/ to git.
  repair(ctx) {
    const { root, config } = ctx;
    const backup = backupWith(ctx);
    const r = report();
    if (config.git === "commit") {
      attemptRepair(r, "check .crank/cerebrum.md against git ignores", () =>
        unignoreForCommit(r, root, backup),
      );
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

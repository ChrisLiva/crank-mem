import * as fs from "node:fs";
import * as path from "node:path";
import { hasCrankHooks } from "./settings.ts";
import { registerProject, unregisterProject } from "../hooks/lib/registry.ts";
import { templatePath, vendorHooks, vendoredHooksCurrent } from "./vendor.ts";
import { cliVersion } from "./version.ts";
import type { OpenedProject } from "./project.ts";
import { saveConfig, type CodexChoice, type CrankConfig } from "../hooks/lib/config.ts";
import { backupCerebrum, CEREBRUM_FILE, splitPreamble } from "../hooks/lib/cerebrum-files.ts";
import {
  attemptRepair,
  installPaths,
  mergeReports,
  report,
  type InstallContext,
  type InstallItem,
  type Report,
} from "./install-support.ts";
import { claudeWiring, codexWiring } from "./install-agents.ts";
import { crankGitignore, gitIgnoreState } from "./install-gitignore.ts";

// The ordered list of everything crank-mem installs into a project. Each
// command prints a Report's lines to stdout and its warnings to stderr; the
// items themselves print nothing.

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

const vendoredHooks: InstallItem = {
  apply({ crankDir }) {
    vendorHooks(crankDir);
    return report();
  },
  // A version change re-vendors whether or not the trees differ; at the same
  // version, a pull or a hand edit that leaves .crank/hooks/ unlike the
  // running crank-mem's re-vendors too. The stamp moves only once the copy is
  // in place.
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
        r.lines.push("  re-vendored .crank/hooks/, which differed from the running crank-mem");
    });
    return r;
  },
  remove: () => report(),
};

/** Copy the template to .crank/cerebrum.md when none exists; true exactly when it copied. */
function seedCerebrum(crankDir: string): boolean {
  const cerebrumPath = path.join(crankDir, CEREBRUM_FILE);
  if (fs.existsSync(cerebrumPath)) return false;
  fs.copyFileSync(templatePath(CEREBRUM_FILE), cerebrumPath);
  return true;
}

const cerebrum: InstallItem = {
  apply({ crankDir }) {
    seedCerebrum(crankDir);
    return report();
  },
  repair({ crankDir }) {
    const r = report();
    const cerebrumPath = path.join(crankDir, CEREBRUM_FILE);
    let seeded = false;
    attemptRepair(r, `seed .crank/${CEREBRUM_FILE} from the template`, () => {
      seeded = seedCerebrum(crankDir);
      if (seeded) r.lines.push(`  seeded .crank/${CEREBRUM_FILE} from the template`);
    });
    if (seeded || r.failed) return r;
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

function ensureRegistered({ root }: InstallContext): Report {
  registerProject(root);
  return report();
}

const registry: InstallItem = {
  apply: ensureRegistered,
  repair: ensureRegistered,
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
 * Install every item for a fresh init, in list order. The first item that
 * throws stops the walk: no later item is applied and the error propagates.
 */
export function applyInstall(ctx: InstallContext): Report {
  const reports: Report[] = [];
  for (const item of ITEMS) reports.push(item.apply(ctx));
  return mergeReports(reports);
}

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

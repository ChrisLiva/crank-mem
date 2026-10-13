import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

// Additive wiring of hook entries into agent settings files, and its exact
// inverse. Merge adds missing entries and refreshes only command forms
// crank-mem itself emitted; removal deletes exactly the entries whose
// command references .crank/hooks/. Files are written as 2-space JSON.

export const CRANK_HOOK_MARKER = ".crank/hooks/";

/** True for a command from a current (.crank/hooks/) install. */
export function isCrankHookCommand(command: string | undefined): boolean {
  return !!command && command.includes(CRANK_HOOK_MARKER);
}

/** True for a command from a legacy pre-rename (non-dotted crank/hooks/) install. */
export function isLegacyHookCommand(command: string | undefined): boolean {
  return !!command && command.includes("crank/hooks/") && !command.includes(CRANK_HOOK_MARKER);
}

interface HookHandler {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

export type HooksMap = Record<string, HookGroup[]>;

type Runtime = "bun" | "node";
type Agent = "claude" | "codex";

function commandParts(runtime: Runtime, script: string, agent: Agent): { runner: string; p: string } {
  const runner = runtime === "bun" ? "bun" : "node --disable-warning=ExperimentalWarning";
  // Claude expands $CLAUDE_PROJECT_DIR; Codex runs hooks with the project cwd.
  const p = agent === "claude" ? `"$CLAUDE_PROJECT_DIR"/.crank/hooks/${script}` : `.crank/hooks/${script}`;
  return { runner, p };
}

export function hookCommand(runtime: Runtime, script: string, agent: Agent): string {
  const { runner, p } = commandParts(runtime, script, agent);
  // A committed settings file outlives .crank/ in clean checkouts and
  // worktrees; without the script the hook exits 0 instead of failing.
  return `[ ! -f ${p} ] || ${runner} ${p}`;
}

/** Every command form crank-mem has emitted for a script: the unguarded form
 * older releases wrote and the current guarded one, for both runtimes and both agents. */
function commandForms(script: string): Set<string> {
  const forms = new Set<string>();
  for (const runtime of ["bun", "node"] as const) {
    for (const agent of ["claude", "codex"] as const) {
      const { runner, p } = commandParts(runtime, script, agent);
      forms.add(`${runner} ${p}`).add(hookCommand(runtime, script, agent));
    }
  }
  return forms;
}

/** The hook entries crank-mem wires, per agent. */
export function crankHooks(runtime: Runtime, agent: Agent): HooksMap {
  const matcher = agent === "claude" ? "Write|Edit|MultiEdit" : "apply_patch";
  const map: HooksMap = {
    SessionStart: [
      { hooks: [{ type: "command", command: hookCommand(runtime, "session-start.ts", agent), timeout: 10 }] },
    ],
    PostToolUse: [
      { matcher, hooks: [{ type: "command", command: hookCommand(runtime, "post-write.ts", agent), timeout: 10 }] },
    ],
  };
  // Stop nudge is Claude-only: it emits advisory additionalContext, which Codex
  // Stop hooks don't support (their only lever forces a continuation, which the
  // advisory-only invariant forbids). Codex leans on the session-start reminder.
  if (agent === "claude") {
    map.Stop = [
      { hooks: [{ type: "command", command: hookCommand(runtime, "stop.ts", agent), timeout: 10 }] },
    ];
  }
  return map;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** The script a command runs from .crank/hooks/, or undefined. */
function hookScript(command: string | undefined): string | undefined {
  if (!isCrankHookCommand(command)) return undefined;
  return command!.slice(command!.indexOf(CRANK_HOOK_MARKER) + CRANK_HOOK_MARKER.length).split(/[\s"']/)[0];
}

/**
 * Wire crank hook groups into a settings-shaped file ({hooks: {Event: []}}
 * — Claude settings.json and Codex hooks.json share this shape), additively.
 * A group in a form crank-mem emitted is replaced in place by the current
 * one, and further copies are dropped. A command the user edited that runs
 * the same script counts as wired and stays as written. Events with no group
 * for their script are appended. Everything else is preserved. Writes only
 * when something changed, calling `beforeWrite` first; returns whether it
 * wrote.
 */
export function mergeHooksIntoFile(file: string, add: HooksMap, beforeWrite?: () => void): boolean {
  const root: Record<string, unknown> = fs.existsSync(file) ? readJson(file) : {};
  const before = JSON.stringify(root);
  const hooks = (root.hooks ?? {}) as Record<string, unknown>;
  for (const [event, groups] of Object.entries(add)) {
    let list = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
    for (const want of groups) {
      const script = hookScript(want.hooks[0]?.command);
      const forms = commandForms(script ?? "");
      const runs = (g: HookGroup) => (g.hooks ?? []).some((h) => hookScript(h.command) === script);
      const ours = (g: HookGroup) => (g.hooks ?? []).every((h) => forms.has(h.command ?? ""));
      const userWired = list.some((g) => runs(g) && !ours(g));
      let placed = userWired;
      list = list.flatMap((g) => {
        if (!runs(g) || !ours(g)) return [g];
        if (placed) return [];
        placed = true;
        return [want];
      });
      if (!placed) list.push(want);
    }
    hooks[event] = list;
  }
  root.hooks = hooks;
  if (JSON.stringify(root) === before) return false;
  beforeWrite?.();
  writeJson(file, root);
  return true;
}

/** True when a settings-shaped file holds any crank hook group. */
export function hasCrankHooks(file: string): boolean {
  try {
    const hooks = readJson(file).hooks as Record<string, HookGroup[]> | undefined;
    return Object.values(hooks ?? {}).some(
      (groups) => Array.isArray(groups) && groups.some((g) => (g.hooks ?? []).some((h) => isCrankHookCommand(h.command)))
    );
  } catch {
    return false;
  }
}

/** The Claude settings file a git mode wires, and the other one, which must hold no crank hooks. */
export function claudeSettingsFiles(root: string, git: "commit" | "ignore" | "exclude"): { wired: string; other: string } {
  const shared = path.join(root, ".claude", "settings.json");
  const local = path.join(root, ".claude", "settings.local.json");
  return git === "commit" ? { wired: shared, other: local } : { wired: local, other: shared };
}

/**
 * Remove every hook group whose command references .crank/hooks/. Drops empty
 * event arrays and an empty hooks object; returns false if the file does not
 * exist or parsing failed (leave it alone).
 */
export function removeCrankHooksFromFile(
  file: string,
  matches: (command: string | undefined) => boolean = isCrankHookCommand,
): boolean {
  if (!fs.existsSync(file)) return false;
  let root: Record<string, unknown>;
  try {
    root = readJson(file);
  } catch {
    return false;
  }
  const hooks = root.hooks as Record<string, HookGroup[]> | undefined;
  if (!hooks) return false;
  let changed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter(
      (g) => !(g.hooks ?? []).some((h) => matches(h.command))
    );
    if (kept.length !== groups.length) {
      changed = true;
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
  }
  if (Object.keys(hooks).length === 0) delete root.hooks;
  if (changed) writeJson(file, root);
  return changed;
}

// ── Line-based files (.gitignore, .git/info/exclude, codex config.toml) ─────

export const IGNORE_LINE = ".crank/";
export const IGNORE_COMMENT = "# crank-mem";
const IGNORE_BLOCK = `${IGNORE_COMMENT}\n${IGNORE_LINE}\n`;
/** The block a legacy pre-rename install appended (non-dotted crank/). */
export const LEGACY_IGNORE_BLOCK = `${IGNORE_COMMENT}\ncrank/\n`;

/** Append our ignore block if .crank/ isn't covered. Creates the file if needed. */
export function addIgnoreLines(file: string): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  if (existing.split("\n").some((l) => l.trim() === IGNORE_LINE)) return;
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, existing + sep + IGNORE_BLOCK);
}

/**
 * Remove exactly the block addIgnoreLines appended. A user's own `.crank/`
 * line (which made addIgnoreLines skip) has no crank-mem comment and is
 * left untouched; no match means no rewrite.
 */
export function removeIgnoreLines(file: string, block: string = IGNORE_BLOCK): void {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, "utf-8");
  if (!content.includes(block)) return;
  fs.writeFileSync(file, content.replace(block, ""));
}

/**
 * Commit mode needs .crank/cerebrum.md in git. Strip crank-mem's own ignore
 * block from each file that makes git ignore it (left by an earlier ignore or
 * exclude-mode init), calling `beforeStrip` first. Returns the foreign rule
 * that still ignores it as `source:line (pattern)`, or null.
 */
export function unignoreCerebrum(root: string, beforeStrip: (file: string) => void): string | null {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  const top = git("rev-parse", "--show-toplevel").stdout?.trim();
  if (!top) return null;
  for (;;) {
    const [, source, line, pattern] =
      git("check-ignore", "-v", "--", ".crank/cerebrum.md").stdout?.match(/^(.*):(\d+):(.*)\t/) ?? [];
    // No match, or a re-including `!` match, which -v also reports with exit 0.
    if (!source || !pattern || pattern.startsWith("!")) return null;
    // check-ignore names sources relative to the repo top, not the cwd.
    const file = path.resolve(top, source);
    const content = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    if (pattern !== IGNORE_LINE || !content.includes(IGNORE_BLOCK)) return `${source}:${line} (${pattern})`;
    beforeStrip(file);
    removeIgnoreLines(file);
  }
}

export const CODEX_FEATURES_SNIPPET = "\n# crank-mem\n[features]\nhooks = true\n";

/** Ensure [features] hooks = true in a codex config.toml, non-destructively. */
export function ensureCodexFeatures(file: string): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  if (/^\s*hooks\s*=\s*true\s*$/m.test(existing)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, existing + CODEX_FEATURES_SNIPPET);
}

/** Remove exactly the snippet ensureCodexFeatures appended (if present). */
export function removeCodexFeatures(file: string): void {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, "utf-8");
  if (!content.includes(CODEX_FEATURES_SNIPPET)) return;
  fs.writeFileSync(file, content.replace(CODEX_FEATURES_SNIPPET, ""));
}

import * as fs from "node:fs";
import * as path from "node:path";

// Additive wiring of hook entries into agent settings files, and its exact
// inverse. Merge appends only; removal deletes exactly the entries whose
// command references .crank/hooks/. Files are written as 2-space JSON.

export const CRANK_HOOK_MARKER = ".crank/hooks/";

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

export function hookCommand(runtime: "bun" | "node", script: string, agent: "claude" | "codex"): string {
  const runner = runtime === "bun" ? "bun" : "node --disable-warning=ExperimentalWarning";
  // Claude expands $CLAUDE_PROJECT_DIR; Codex runs hooks with the project cwd.
  const p = agent === "claude" ? `"$CLAUDE_PROJECT_DIR"/.crank/hooks/${script}` : `.crank/hooks/${script}`;
  return `${runner} ${p}`;
}

/** The hook entries crank-mem wires, per agent. */
export function crankHooks(runtime: "bun" | "node", agent: "claude" | "codex"): HooksMap {
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

/**
 * Append crank hook groups into a settings-shaped file ({hooks: {Event: []}}
 * — Claude settings.json and Codex hooks.json share this shape). Existing
 * content is preserved; crank groups already present are not duplicated.
 */
export function mergeHooksIntoFile(file: string, add: HooksMap): void {
  const root: Record<string, unknown> = fs.existsSync(file) ? readJson(file) : {};
  const hooks = (root.hooks ?? {}) as Record<string, unknown>;
  for (const [event, groups] of Object.entries(add)) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
    const withoutCrank = existing.filter(
      (g) => !(g.hooks ?? []).some((h) => h.command?.includes(CRANK_HOOK_MARKER))
    );
    hooks[event] = [...withoutCrank, ...groups];
  }
  root.hooks = hooks;
  writeJson(file, root);
}

/**
 * Remove every hook group whose command references .crank/hooks/. Drops empty
 * event arrays and an empty hooks object; returns false if the file does not
 * exist or parsing failed (leave it alone).
 */
export function removeCrankHooksFromFile(file: string): boolean {
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
      (g) => !(g.hooks ?? []).some((h) => h.command?.includes(CRANK_HOOK_MARKER))
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
export function removeIgnoreLines(file: string): void {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, "utf-8");
  if (!content.includes(IGNORE_BLOCK)) return;
  fs.writeFileSync(file, content.replace(IGNORE_BLOCK, ""));
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

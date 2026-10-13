import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { isCrankHookCommand, type HooksMap } from "./settings.ts";

// Opt-in Codex per-hook trust: compute trusted_hash entries the way codex-rs
// does (ADR 0002, verified against rust-v0.144.6 source, identical to 0.144.5:
// hooks/src/engine/discovery.rs command_hook_hash + config/src/fingerprint.rs
// version_for_toml) and write them to the user's ~/.codex/config.toml so
// headless sessions skip the interactive hooks review.

/** Codex hashes the snake_case event label (hooks/src/lib.rs hook_event_key_label). */
function eventLabel(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Recursively key-sorted JSON — codex's canonical serialization. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
  }
  return JSON.stringify(value);
}

export interface TrustEntry {
  key: string;
  hash: string;
}

type HookGroup = HooksMap[string][number];
type HookHandler = HookGroup["hooks"][number];

/**
 * Visit every crank handler in a hooks map at its ACTUAL discovered position —
 * codex keys trust by position in the discovered list, so a crank group merged
 * after pre-existing user groups must be keyed at its real index. Both the
 * live keys and the stale ones walk through here, so they can never drift
 * apart in position.
 */
function eachCrankHandler(
  hooks: HooksMap,
  matches: (command: string | undefined) => boolean,
  visit: (event: string, group: HookGroup, groupIdx: number, handler: HookHandler, handlerIdx: number) => void,
): void {
  for (const [event, groups] of Object.entries(hooks)) {
    groups.forEach((group, groupIdx) => {
      (group.hooks ?? []).forEach((handler, handlerIdx) => {
        if (!matches(handler.command)) return;
        visit(event, group, groupIdx, handler, handlerIdx);
      });
    });
  }
}

/** Parse the `hooks` map out of a hooks.json on disk; null when unreadable. */
function readHooksMap(hooksJsonPath: string): HooksMap | null {
  try {
    const root = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
    const hooks = root?.hooks;
    if (typeof hooks !== "object" || hooks === null) return null;
    return hooks as HooksMap;
  } catch {
    return null;
  }
}

/**
 * Compute the [hooks.state] entries for the crank handlers in a hooks map.
 * The key's event segment is the snake_case label — the spelling codex looks
 * the entry up by (hooks/src/lib.rs hook_event_key_label), same as the one
 * that goes into the hash.
 */
export function trustEntries(
  hooksJsonPath: string,
  hooks: HooksMap,
  matches: (command: string | undefined) => boolean = isCrankHookCommand,
): TrustEntry[] {
  const out: TrustEntry[] = [];
  eachCrankHandler(hooks, matches, (event, group, groupIdx, handler, handlerIdx) => {
    // Field names are codex's serde WIRE names ("timeout", not the Rust
    // field timeout_sec); absent optionals (matcher, statusMessage,
    // commandWindows) are omitted entirely, as codex's TOML round-trip
    // drops None fields.
    const normalized = {
      event_name: eventLabel(event),
      matcher: group.matcher,
      hooks: [
        {
          type: "command",
          command: handler.command,
          timeout: Math.max(handler.timeout ?? 600, 1),
          async: false,
        },
      ],
    };
    const hash = crypto.createHash("sha256").update(canonicalJson(normalized)).digest("hex");
    out.push({
      key: `${hooksJsonPath}:${eventLabel(event)}:${groupIdx}:${handlerIdx}`,
      hash: `sha256:${hash}`,
    });
  });
  return out;
}

/**
 * Keys crank wrote before the label fix, when the state key carried the raw
 * PascalCase event (`SessionStart`) that codex never looks up — orphans to be
 * swept whenever we write or remove trust. An event whose raw spelling already
 * equals its label yields NO key: such an entry is indistinguishable from one
 * codex wrote for itself, and must never be stripped.
 */
export function staleTrustKeys(
  hooksJsonPath: string,
  hooks: HooksMap,
  matches: (command: string | undefined) => boolean = isCrankHookCommand,
): string[] {
  const out: string[] = [];
  eachCrankHandler(hooks, matches, (event, _group, groupIdx, _handler, handlerIdx) => {
    if (event === eventLabel(event)) return;
    out.push(`${hooksJsonPath}:${event}:${groupIdx}:${handlerIdx}`);
  });
  return out;
}

export interface CrankTrust {
  entries: TrustEntry[];
  staleKeys: string[];
  /** Every key crank owns in config.toml: the entries' keys, then the stale keys. */
  keys: string[];
}

/** Crank's trust entries and stale keys from one read of the hooks.json on disk; all empty when unreadable. */
export function crankTrust(
  hooksJsonPath: string,
  matches: (command: string | undefined) => boolean = isCrankHookCommand,
): CrankTrust {
  const hooks = readHooksMap(hooksJsonPath);
  const entries = hooks ? trustEntries(hooksJsonPath, hooks, matches) : [];
  const staleKeys = hooks ? staleTrustKeys(hooksJsonPath, hooks, matches) : [];
  return { entries, staleKeys, keys: [...entries.map((e) => e.key), ...staleKeys] };
}

/** What to do when crank's Codex hooks changed and no trust entries were written for them. */
export const CODEX_REVIEW_HINT = [
  "  Codex trust: open codex once in this project and accept the hooks review",
  "  (or headless: codex --dangerously-bypass-hook-trust)",
];

export function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export function userCodexConfigPath(): string {
  return path.join(codexHome(), "config.toml");
}

function entryBlock(e: TrustEntry): string {
  return `[hooks.state."${e.key}"]\ntrusted_hash = "${e.hash}"\n`;
}

/**
 * Append trust entries to the user config.toml, replacing any blocks for the
 * same keys — plus `staleKeys`, the orphans older crank releases left behind.
 */
export function writeTrustEntries(configPath: string, entries: TrustEntry[], staleKeys: string[] = []): void {
  let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
  content = stripTrustEntries(content, [...entries.map((e) => e.key), ...staleKeys]);
  const sep = content === "" || content.endsWith("\n") ? "" : "\n";
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, content + sep + entries.map(entryBlock).join(""));
}

/** Remove exactly the [hooks.state."<key>"] blocks for the given keys. */
export function removeTrustEntries(configPath: string, keys: string[]): void {
  if (!fs.existsSync(configPath)) return;
  const content = fs.readFileSync(configPath, "utf-8");
  fs.writeFileSync(configPath, stripTrustEntries(content, keys));
}

function stripTrustEntries(content: string, keys: string[]): string {
  let out = content;
  for (const key of keys) {
    // A block is the header line plus following lines up to the next [ header.
    const re = new RegExp(
      `\\[hooks\\.state\\."${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]\\n(?:(?!\\[)[^\\n]*\\n?)*`,
      "g"
    );
    out = out.replace(re, "");
  }
  return out;
}

/**
 * The string values under each [table] header, keyed by the header text as
 * written. Enough TOML for the [projects."…"] and [hooks.state."…"] tables
 * codex writes; arrays, inline tables and multi-line strings are skipped.
 */
function readTomlStrings(content: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  let current = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^[].*)\]\s*(?:#.*)?$/);
    if (header) {
      current = new Map();
      tables.set(header[1]!.trim(), current);
      continue;
    }
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
    if (kv) {
      try {
        current.set(kv[1]!, JSON.parse(kv[2]!));
      } catch {}
    }
  }
  return tables;
}

export interface TrustStatus {
  /** trust_level of the exact-path [projects."<root>"] table; null when that table is absent. */
  projectTrustLevel: string | null;
  current: number;
  /** trusted_hash present but different: codex re-asks for review and skips the hook until then. */
  stale: number;
  missing: number;
}

/** Compare the crank handlers in a hooks.json with the trust config.toml holds for them. */
export function codexTrustStatus(configPath: string, root: string, hooksJsonPath: string): TrustStatus {
  let tables = new Map<string, Map<string, string>>();
  try {
    tables = readTomlStrings(fs.readFileSync(configPath, "utf-8"));
  } catch {}
  const status: TrustStatus = {
    projectTrustLevel: tables.get(`projects.${JSON.stringify(root)}`)?.get("trust_level") ?? null,
    current: 0,
    stale: 0,
    missing: 0,
  };
  for (const e of crankTrust(hooksJsonPath).entries) {
    const hash = tables.get(`hooks.state.${JSON.stringify(e.key)}`)?.get("trusted_hash");
    if (hash === undefined) status.missing++;
    else if (hash === e.hash) status.current++;
    else status.stale++;
  }
  return status;
}

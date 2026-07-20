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

/**
 * Compute the [hooks.state] entries for the crank handlers in a hooks map,
 * using each group's ACTUAL index — codex keys trust by position in the
 * discovered list, so a crank group merged after pre-existing user groups
 * must be keyed at its real index.
 */
export function trustEntries(
  hooksJsonPath: string,
  hooks: HooksMap,
  matches: (command: string | undefined) => boolean = isCrankHookCommand,
): TrustEntry[] {
  const out: TrustEntry[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    groups.forEach((group, groupIdx) => {
      (group.hooks ?? []).forEach((handler, handlerIdx) => {
        if (!matches(handler.command)) return;
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
          key: `${hooksJsonPath}:${event}:${groupIdx}:${handlerIdx}`,
          hash: `sha256:${hash}`,
        });
      });
    });
  }
  return out;
}

/** Trust entries computed from the hooks.json actually on disk. */
export function trustEntriesFromFile(
  hooksJsonPath: string,
  matches?: (command: string | undefined) => boolean,
): TrustEntry[] {
  try {
    const root = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
    const hooks = root?.hooks;
    if (typeof hooks !== "object" || hooks === null) return [];
    return trustEntries(hooksJsonPath, hooks as HooksMap, matches);
  } catch {
    return [];
  }
}

export function userCodexConfigPath(): string {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
}

function entryBlock(e: TrustEntry): string {
  return `[hooks.state."${e.key}"]\ntrusted_hash = "${e.hash}"\n`;
}

/** Append trust entries to the user config.toml (replacing stale ones for the same keys). */
export function writeTrustEntries(configPath: string, entries: TrustEntry[]): void {
  let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
  content = stripTrustEntries(content, entries.map((e) => e.key));
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

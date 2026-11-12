import * as fs from "node:fs";
import * as path from "node:path";

// .crank/config.json load with defaults, plus the always-on sensitive-file
// filter (not configurable — never index secrets).

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const CRANK_DIR = ".crank";
export const CONFIG_FILE = "config.json";
/** Per-checkout settings, kept out of git by .crank/.gitignore's `/*` line. */
export const LOCAL_CONFIG_FILE = "config.local.json";
const MAX_FILE_SIZE_BYTES = 1024 * 1024;

// Hidden paths (.git, .claude, .codex, .crank itself, …) are excluded by the
// always-on dot rule in isExcluded, so only non-hidden names belong here.
export const DEFAULT_EXCLUDES = [
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  "target",
  "*.min.js",
  "*.min.css",
];

/** What init did with Codex: left it alone, wired hooks for the user to review, or also wrote trust entries. */
export type CodexChoice = "skip" | "review" | "trust";

export interface CrankConfig {
  version: number;
  excludes: string[];
  max_files: number;
  max_file_size_bytes: number;
  /**
   * Cap on the session-start injection, in bytes. Claude Code caps
   * additionalContext at 10,000 characters and swaps an oversized injection
   * for a file path and a 2,000-character preview (ADR 0005), so a token
   * budget cannot see the limit that binds. UTF-8 bytes never undercount
   * characters, so a byte budget under the cap holds for any text.
   */
  injection_budget_bytes: number;
  adr_path: string;
  git: "commit" | "ignore" | "exclude";
  runtime: "bun" | "node";
  vendored_version: string;
  /**
   * Absolute path to the crank-mem clone these hooks were vendored from, so a
   * session start can compare versions and report drift (lib/drift.ts). Empty
   * on installs predating the field; `upgrade` stamps it.
   */
  clone_root: string;
  /** The Codex choice init recorded; null on an install that recorded none. */
  codex: CodexChoice | null;
  /** Write a per-run JSONL trace to .crank/debug.log (off by default). */
  debug: boolean;
  /**
   * Run background digests of finished sessions through `claude -p` (off by
   * default). Read only from config.local.json, so a committed config.json
   * cannot turn digests on for every checkout.
   */
  digest: boolean;
}

export function defaultConfig(): CrankConfig {
  return {
    version: 1,
    excludes: [...DEFAULT_EXCLUDES],
    max_files: 500,
    max_file_size_bytes: MAX_FILE_SIZE_BYTES,
    injection_budget_bytes: 8192,
    adr_path: "docs/adr",
    git: "exclude",
    runtime: "bun",
    vendored_version: "0.0.0",
    clone_root: "",
    codex: null,
    debug: false,
    digest: false,
  };
}

/**
 * Retired fields. Unknown keys are normally carried through so a user's own
 * additions survive a round-trip; these are dropped instead, so a stale knob
 * that no longer governs anything doesn't linger in every installed config.
 */
const LEGACY_KEYS = new Set(["injection_budget_tokens", "codex_trust_written"]);

const GIT_MODES: readonly CrankConfig["git"][] = ["commit", "ignore", "exclude"];
const RUNTIMES: readonly CrankConfig["runtime"][] = ["bun", "node"];
const CODEX_CHOICES: readonly CodexChoice[] = ["skip", "review", "trust"];

/**
 * Load config, accepting each known field only when it matches the expected
 * shape. Unknown keys are carried through verbatim so a user's additions
 * survive a load → save round-trip.
 */
export function loadConfig(crankDir: string): CrankConfig {
  const config = defaultConfig();
  config.digest = loadDigest(crankDir);
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(crankDir, CONFIG_FILE), "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return config;
    raw = parsed as Record<string, unknown>;
  } catch {
    return config;
  }
  for (const key of Object.keys(config) as (keyof CrankConfig)[]) {
    const value = raw[key];
    if (value === undefined || key === "digest" || key === "codex") continue;
    if (key === "excludes") {
      if (Array.isArray(value) && value.every((v) => typeof v === "string"))
        config.excludes = value;
    } else if (key === "git") {
      if (GIT_MODES.includes(value as CrankConfig["git"])) config.git = value as CrankConfig["git"];
    } else if (key === "runtime") {
      if (RUNTIMES.includes(value as CrankConfig["runtime"]))
        config.runtime = value as CrankConfig["runtime"];
    } else if (
      typeof value === typeof config[key] &&
      (typeof value !== "number" || (Number.isFinite(value) && value > 0))
    ) {
      (config as unknown as Record<string, unknown>)[key] = value;
    }
  }
  // Installs before `codex` recorded only whether init wrote trust entries.
  config.codex = CODEX_CHOICES.includes(raw.codex as CodexChoice)
    ? (raw.codex as CodexChoice)
    : raw.codex_trust_written === true
      ? "trust"
      : null;
  for (const key of Object.keys(raw)) {
    if (key in config || LEGACY_KEYS.has(key)) continue;
    (config as unknown as Record<string, unknown>)[key] = raw[key];
  }
  return config;
}

function loadDigest(crankDir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(crankDir, LOCAL_CONFIG_FILE), "utf-8"),
    );
    return isObj(parsed) && parsed.digest === true;
  } catch {
    return false;
  }
}

export function saveConfig(crankDir: string, config: CrankConfig): void {
  const { digest, ...rest } = config;
  const shared: Record<string, unknown> = { ...rest };
  if (shared.codex === null) delete shared.codex;
  fs.writeFileSync(path.join(crankDir, CONFIG_FILE), JSON.stringify(shared, null, 2) + "\n");
  const local = path.join(crankDir, LOCAL_CONFIG_FILE);
  if (digest) fs.writeFileSync(local, JSON.stringify({ digest: true }, null, 2) + "\n");
  else fs.rmSync(local, { force: true });
}

// ── Sensitive filter (always on, regardless of config) ──────────────────────

const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p8",
  ".p12",
  ".pfx",
  ".keystore",
  ".jks",
  ".ppk",
  ".kdbx",
  ".tfstate",
]);
const SENSITIVE_BASENAMES = new Set([".npmrc", ".netrc", ".htpasswd", ".pgpass"]);

/**
 * The filter as permission globs, for the read-only tools a consolidation run gets (ADR 0011).
 * The probed list matches isSensitiveFile under path.matchesGlob apart from case, and Claude Code
 * applies it regardless of case (ADR 0015).
 */
export const SENSITIVE_GLOBS: readonly string[] = [
  ...[...SENSITIVE_BASENAMES].map((b) => `**/${b}`),
  ...[...SENSITIVE_EXTENSIONS].map((ext) => `**/*${ext}`),
  "**/.env",
  "**/.env.*",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/*credential*",
  "**/secrets.json",
  "**/secrets.yaml",
  "**/secrets.yml",
  "**/secrets.toml",
];

export function isSensitiveFile(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (SENSITIVE_BASENAMES.has(lower)) return true;
  const dot = lower.lastIndexOf(".");
  if (dot >= 0 && SENSITIVE_EXTENSIONS.has(lower.slice(dot))) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(lower)) return true;
  if (lower.includes("credential") || /^secrets\.(json|ya?ml|toml)$/.test(lower)) return true;
  return false;
}

/** True if relPath (posix separators) is excluded by config or sensitivity. */
export function isExcluded(relPath: string, excludes: string[]): boolean {
  const parts = relPath.split("/");
  const basename = parts[parts.length - 1]!;
  if (isSensitiveFile(basename)) return true;
  // Hidden paths — any dot-prefixed component (.claude/skills, .codex,
  // .github, .crank itself, .DS_Store) — are never indexed. Always on, like
  // the sensitive filter: agent/tool config trees don't belong in the anatomy.
  if (parts.some((p) => p.startsWith("."))) return true;
  for (const pattern of excludes) {
    if (pattern.startsWith("*.")) {
      if (relPath.endsWith(pattern.slice(1))) return true;
    } else if (parts.includes(pattern)) {
      return true;
    }
  }
  return false;
}

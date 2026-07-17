import * as fs from "node:fs";
import * as path from "node:path";

// crank/config.json load with defaults, plus the always-on sensitive-file
// filter (not configurable — never index secrets).

export const CRANK_DIR = "crank";
export const CONFIG_FILE = "config.json";
export const MAX_FILE_SIZE_BYTES = 1024 * 1024;

export const DEFAULT_EXCLUDES = [
  "node_modules", ".git", "dist", "build", "crank", ".next", ".nuxt",
  "coverage", "__pycache__", ".cache", "target", ".vscode", ".idea",
  ".turbo", ".vercel", ".netlify", ".output", "*.min.js", "*.min.css",
];

export interface CrankConfig {
  version: number;
  excludes: string[];
  max_files: number;
  max_file_size_bytes: number;
  injection_budget_tokens: number;
  adr_path: string;
  git: "commit" | "ignore" | "exclude";
  runtime: "bun" | "node";
  vendored_version: string;
  codex_trust_written: boolean;
}

export function defaultConfig(): CrankConfig {
  return {
    version: 1,
    excludes: [...DEFAULT_EXCLUDES],
    max_files: 500,
    max_file_size_bytes: MAX_FILE_SIZE_BYTES,
    injection_budget_tokens: 5000,
    adr_path: "docs/adr",
    git: "exclude",
    runtime: "bun",
    vendored_version: "0.0.0",
    codex_trust_written: false,
  };
}

export function loadConfig(crankDir: string): CrankConfig {
  const defaults = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(crankDir, CONFIG_FILE), "utf-8"));
    return { ...defaults, ...raw };
  } catch {
    return defaults;
  }
}

export function saveConfig(crankDir: string, config: CrankConfig): void {
  fs.writeFileSync(path.join(crankDir, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n");
}

// ── Sensitive filter (always on, regardless of config) ──────────────────────

const SENSITIVE_EXTENSIONS = new Set([
  ".pem", ".key", ".p8", ".p12", ".pfx", ".keystore", ".jks", ".ppk", ".kdbx", ".tfstate",
]);
const SENSITIVE_BASENAMES = new Set([".npmrc", ".netrc", ".htpasswd", ".pgpass"]);

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
  for (const pattern of excludes) {
    if (pattern.startsWith("*.")) {
      if (relPath.endsWith(pattern.slice(1))) return true;
    } else if (parts.includes(pattern)) {
      return true;
    }
  }
  return false;
}

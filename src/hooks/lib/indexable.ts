import * as path from "node:path";
import { isExcluded, type CrankConfig } from "./config.ts";

// Which relative paths the index may hold: the binary, lockfile, test-path and name gates.

// Fast path ahead of the NUL sniff in indexFile, which catches the rest.
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".svg",
  ".webp",
  ".avif",
  ".heic",
  ".heif",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".a",
  ".lib",
  ".o",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".webm",
  ".ogg",
  ".sqlite",
  ".db",
  ".wasm",
  ".npy",
  ".npz",
  ".lock",
]);

// Generated lockfiles the ".lock" extension misses (pnpm-lock.yaml, …).
const LOCKFILE = /(^|\/)(package-lock\.json|[^/]*-lock\.yaml)$/;

// git's binary heuristic: a NUL byte within the first 8,000 bytes.
export const BINARY_SNIFF_BYTES = 8000;

// Test and spec files get no symbols: their names list cases, not an API.
export const TEST_PATH =
  /(^|\/)(__tests__|tests?|specs?)\/|(^|\/)test_[^/]*$|[._-](test|spec)\.[^/]+$/;

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Orders strings by UTF-16 code unit, the one order every sorted list of paths and names here keeps. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Stat-free name gate: excluded, binary or lockfile paths are never indexable. */
export function isIndexableName(relPath: string, config: CrankConfig): boolean {
  if (isExcluded(relPath, config.excludes)) return false;
  if (BINARY_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return false;
  if (LOCKFILE.test(relPath)) return false;
  return true;
}

/** Extensions of first-party source: the walk ranks them first and the session-start pointer counts the ones no grammar reads. */
export const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".scala",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".m",
  ".mm",
  ".cs",
  ".rb",
  ".php",
  ".lua",
  ".dart",
  ".zig",
  ".sh",
  ".sql",
  ".css",
  ".scss",
  ".vue",
  ".svelte",
]);

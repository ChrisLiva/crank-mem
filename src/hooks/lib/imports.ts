import * as fs from "node:fs";
import * as path from "node:path";
import type { CrankConfig } from "./config.ts";
import { isIndexableName, toPosix } from "./indexable.ts";
import type { FileEntry } from "./store.ts";
import { SYMBOL_MAX_BYTES } from "./symbols.ts";

// The anatomy's file-to-file links: which indexed files a file imports,
// resolved by regex and a few stats. Never shown in anatomy.md.

const TS_JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// A quoted specifier after `from` (import or export, on any line of a
// multi-line one), after a bare `import`, or inside `require(` / `import(`,
// in source order.
const TS_JS_SPECIFIER =
  /\bfrom\s*["'](?<from>[^"'\n]+)["']|\bimport\s*["'](?<bare>[^"'\n]+)["']|\b(?:require|import)\s*\(\s*["'](?<call>[^"'\n]+)["']\s*\)/g;

const MAX_LINKS = 50;

function firstUnique(values: string[]): string[] {
  return [...new Set(values)].slice(0, MAX_LINKS);
}

function isRegularFile(rootDir: string, rel: string): boolean {
  return fs.statSync(path.join(rootDir, rel), { throwIfNoEntry: false })?.isFile() ?? false;
}

/** Exact path, then each extension, then `/index` + each; a `.js` specifier falls back to `.ts` then `.tsx`. */
function resolveTsJs(rootDir: string, fromRel: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const base = path.posix.join(path.posix.dirname(fromRel), specifier);
  const candidates = [
    base,
    ...TS_JS_EXTENSIONS.map((ext) => base + ext),
    ...TS_JS_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  const found = candidates.find((rel) => isRegularFile(rootDir, rel));
  if (found) return found;
  if (base.endsWith(".js")) {
    const stem = base.slice(0, -".js".length);
    return [`${stem}.ts`, `${stem}.tsx`].find((rel) => isRegularFile(rootDir, rel)) ?? null;
  }
  return null;
}

/**
 * The files `relPath` imports, as repo-relative paths in source order. `{}`
 * when nothing resolves; never throws, since indexFile must not.
 */
export function fileLinks(
  rootDir: string,
  relPath: string,
  content: string,
  config: CrankConfig,
): Pick<FileEntry, "imports" | "namespaces"> {
  try {
    const importer = toPosix(relPath);
    if (content.length > SYMBOL_MAX_BYTES) return {};
    if (!TS_JS_EXTENSIONS.includes(path.posix.extname(importer).toLowerCase())) return {};
    const resolved: string[] = [];
    for (const m of content.matchAll(TS_JS_SPECIFIER)) {
      const { from, bare, call } = m.groups!;
      const rel = resolveTsJs(rootDir, importer, (from ?? bare ?? call)!);
      if (rel && rel !== importer && isIndexableName(rel, config)) resolved.push(rel);
    }
    const imports = firstUnique(resolved);
    return imports.length > 0 ? { imports } : {};
  } catch {
    return {};
  }
}

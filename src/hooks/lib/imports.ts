import * as fs from "node:fs";
import * as path from "node:path";
import { isObj, type CrankConfig } from "./config.ts";
import { isProjectFile } from "./hook-io.ts";
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
  /\bfrom\s*["'](?<from>[^"'\n]+)["']|\bimport\s*["'](?<bare>[^"'\n]+)["']|\b(?:require|import)\s*\(\s*["'](?<call>[^"'\n]+)["']\s*\)/dg;

// `from <module> import <names>` (a parenthesized list may span lines) or
// `import <modules>`, each anchored at a line start, in source order.
const PYTHON_IMPORT =
  /^[ \t]*(?:from[ \t]+(?<module>\.*[\w.]*)[ \t]+import[ \t]*(?:\((?<list>[^)]*)\)|(?<line>[^\n#]*))|import[ \t]+(?<modules>[^\n#]+))/gm;

// A quoted path after `import` (with an optional alias), or an `import ( … )`
// block whose lines each hold one optionally aliased path, in source order.
const GO_IMPORT =
  /^[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?"(?<single>[^"\n]+)"|^[ \t]*import[ \t]*\((?<block>[^)]*)\)/gm;
const GO_BLOCK_LINE = /^[ \t]*(?:[\w.]+[ \t]+)?"(?<path>[^"\n]+)"/gm;
const GO_PACKAGE_MAX_FILES = 10;

// `mod <name>;` or `use <tree>;` (each optionally `pub` or `pub(…)`),
// anchored at a line start, in source order. An inline `mod x { … }` has no
// file and does not match.
const RUST_ITEM =
  /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:mod[ \t]+(?<mod>\w+)[ \t]*;|use[ \t]+(?<use>[^;]+);)/gm;
const RUST_MOD_ROOTS = ["mod.rs", "lib.rs", "main.rs"];

const C_EXTENSIONS = [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"];
// A quoted `#include "<path>"`; angle includes name system headers and do not match.
const C_INCLUDE = /^[ \t]*#[ \t]*include[ \t]*"(?<path>[^"\n]+)"/gm;

// `namespace <name>` (block or file-scoped), or a `using <name>;` directive
// (optionally `global`); `using static` and `using <alias> = …` do not match.
const CS_NAMESPACE =
  /^[ \t]*namespace[ \t]+(?<declares>[\w.]+)|^[ \t]*(?:global[ \t]+)?using[ \t]+(?!static\b)(?<uses>[\w.]+)[ \t]*;/gm;

const MAX_LINKS = 50;

function firstUnique(values: string[]): string[] {
  return [...new Set(values)].slice(0, MAX_LINKS);
}

/** A relative specifier against the importer's directory; any other through the nearest config's aliases. */
function resolveTsJs(rootDir: string, fromRel: string, specifier: string): string | null {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolveTsJsPath(rootDir, path.posix.join(path.posix.dirname(fromRel), specifier));
  }
  return resolveAlias(rootDir, fromRel, specifier);
}

/** Exact path, then each extension, then `/index` + each; a `.js` path falls back to `.ts` then `.tsx`. Null outside the root. */
function resolveTsJsPath(rootDir: string, base: string): string | null {
  if (base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) return null;
  const candidates = [
    base,
    ...TS_JS_EXTENSIONS.map((ext) => base + ext),
    ...TS_JS_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  const found = candidates.find((rel) => isProjectFile(rootDir, rel));
  if (found) return found;
  if (base.endsWith(".js")) {
    const stem = base.slice(0, -".js".length);
    return [`${stem}.ts`, `${stem}.tsx`].find((rel) => isProjectFile(rootDir, rel)) ?? null;
  }
  return null;
}

/** A dotted module path (slashes already) as `<p>.py`, else `<p>/__init__.py`. */
function resolvePythonModule(rootDir: string, modulePath: string): string | null {
  if (modulePath === "." || modulePath === ".." || modulePath.startsWith("../")) return null;
  return (
    [`${modulePath}.py`, `${modulePath}/__init__.py`].find((rel) => isProjectFile(rootDir, rel)) ??
    null
  );
}

/** Each name or module before an optional `as`, dropping comments and parentheses. */
function pythonNames(list: string): string[] {
  return list
    .replace(/#[^\n]*/g, "")
    .split(",")
    .map((item) => item.trim().split(/\s+/)[0]!)
    .filter((name) => /^[\w.]+$/.test(name));
}

/** The files an `import <modules>` line names. */
function pythonPlainTargets(rootDir: string, modules: string): string[] {
  const found: string[] = [];
  for (const name of pythonNames(modules)) {
    const rel = resolvePythonModule(rootDir, name.replaceAll(".", "/"));
    if (rel) found.push(rel);
  }
  return found;
}

/** A `from` module as a slash path, with leading dots resolved against `importer`'s directory. */
function pythonModuleBase(importer: string, module: string): string {
  const dots = /^\.*/.exec(module)![0].length;
  const dotted = module.slice(dots).replaceAll(".", "/");
  return dots === 0
    ? dotted
    : path.posix.join(path.posix.dirname(importer), "../".repeat(dots - 1), dotted);
}

/** Each name as a submodule of `base`, else `base` itself. */
function pythonFromTargets(rootDir: string, base: string, names: string): string[] {
  const found: string[] = [];
  for (const name of pythonNames(names)) {
    const submodule = path.posix.join(base, name.replaceAll(".", "/")) + ".py";
    const rel = isProjectFile(rootDir, submodule) ? submodule : resolvePythonModule(rootDir, base);
    if (rel) found.push(rel);
  }
  return found;
}

function pythonImports(rootDir: string, importer: string, content: string): string[] {
  const found: string[] = [];
  for (const m of content.matchAll(PYTHON_IMPORT)) {
    const { module, list, line, modules } = m.groups!;
    if (modules !== undefined) found.push(...pythonPlainTargets(rootDir, modules));
    else {
      const base = pythonModuleBase(importer, module!);
      found.push(...pythonFromTargets(rootDir, base, list ?? line ?? ""));
    }
  }
  return found;
}

/** The nearest `go.mod` at or above `importer`'s directory, read once: its directory and module path. */
function goModule(rootDir: string, importer: string): { dir: string; module: string } | null {
  for (let dir = path.posix.dirname(importer); ; dir = path.posix.dirname(dir)) {
    const rel = path.posix.join(dir, "go.mod");
    if (isProjectFile(rootDir, rel)) {
      const text = fs.readFileSync(path.join(rootDir, rel), "utf-8");
      const module = /^[ \t]*module[ \t]+"?(?<module>[^"\s]+)"?/m.exec(text)?.groups!.module;
      return module ? { dir, module } : null;
    }
    if (dir === ".") return null;
  }
}

/** Every quoted import path, single or in a block, in source order. */
function goImportPaths(content: string): string[] {
  const importPaths: string[] = [];
  for (const m of content.matchAll(GO_IMPORT)) {
    const { single, block } = m.groups!;
    if (single !== undefined) importPaths.push(single);
    else for (const line of block!.matchAll(GO_BLOCK_LINE)) importPaths.push(line.groups!.path!);
  }
  return importPaths;
}

/** The package's non-test `.go` files, sorted; `[]` outside the module, for a non-directory, or over the cap. */
function goPackageFiles(
  rootDir: string,
  mod: { dir: string; module: string },
  importPath: string,
): string[] {
  if (importPath !== mod.module && !importPath.startsWith(`${mod.module}/`)) return [];
  const pkgDir = path.posix.join(mod.dir, importPath.slice(mod.module.length));
  const abs = path.join(rootDir, pkgDir);
  let isDir = false;
  try {
    isDir = fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {}
  if (!isDir) return [];
  const goFiles = fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".go") && !e.name.endsWith("_test.go"))
    .map((e) => path.posix.join(pkgDir, e.name))
    .sort();
  return goFiles.length <= GO_PACKAGE_MAX_FILES ? goFiles : [];
}

function goImports(rootDir: string, importer: string, content: string): string[] {
  const importPaths = goImportPaths(content);
  if (importPaths.length === 0) return [];
  const mod = goModule(rootDir, importer);
  if (!mod) return [];
  const found: string[] = [];
  for (const importPath of importPaths) found.push(...goPackageFiles(rootDir, mod, importPath));
  return found;
}

/** A module path as `<p>.rs`, else `<p>/mod.rs`. */
function resolveRustModule(rootDir: string, modulePath: string): string | null {
  return (
    [`${modulePath}.rs`, `${modulePath}/mod.rs`].find((rel) => isProjectFile(rootDir, rel)) ?? null
  );
}

/** Every path a use tree names, with `{a, b::c}` groups expanded and `as` aliases dropped. */
function rustUsePaths(tree: string): string[][] {
  const text = tree.replace(/\s+as\s+\w+/g, "").replace(/\s+/g, "");
  const open = text.indexOf("{");
  if (open === -1) return [text.split("::").filter(Boolean)];
  const prefix = text.slice(0, open).split("::").filter(Boolean);
  const inner = text.slice(open + 1, text.lastIndexOf("}"));
  const branches: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "{") depth++;
    else if (inner[i] === "}") depth--;
    else if (inner[i] === "," && depth === 0) {
      branches.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  branches.push(inner.slice(start));
  return branches
    .filter((branch) => branch !== "")
    .flatMap((branch) =>
      branch === "self" ? [prefix] : rustUsePaths(branch).map((p) => [...prefix, ...p]),
    );
}

/** The nearest directory named `src` at or above `importer`'s directory. */
function rustCrateSrc(importer: string): string | null {
  for (let dir = path.posix.dirname(importer); dir !== "."; dir = path.posix.dirname(dir)) {
    if (path.posix.basename(dir) === "src") return dir;
  }
  return null;
}

/** The directory `importer`'s `mod <name>;` children live in. */
function rustModDir(importer: string): string {
  const dir = path.posix.dirname(importer);
  const fileName = path.posix.basename(importer);
  return RUST_MOD_ROOTS.includes(fileName)
    ? dir
    : path.posix.join(dir, fileName.slice(0, -".rs".length));
}

/** The file of the longest `crate::` prefix of `segments` that resolves under `crateSrc`. */
function rustCrateTarget(rootDir: string, crateSrc: string, segments: string[]): string | null {
  if (segments[0] !== "crate") return null;
  for (let end = segments.length; end > 1; end--) {
    const rel = resolveRustModule(rootDir, path.posix.join(crateSrc, ...segments.slice(1, end)));
    if (rel) return rel;
  }
  return null;
}

function rustImports(rootDir: string, importer: string, content: string): string[] {
  const found: string[] = [];
  const modDir = rustModDir(importer);
  const crateSrc = rustCrateSrc(importer);
  for (const m of content.matchAll(RUST_ITEM)) {
    const { mod, use } = m.groups!;
    if (mod !== undefined) {
      const rel = resolveRustModule(rootDir, path.posix.join(modDir, mod));
      if (rel) found.push(rel);
      continue;
    }
    if (crateSrc === null) continue;
    for (const segments of rustUsePaths(use!)) {
      const rel = rustCrateTarget(rootDir, crateSrc, segments);
      if (rel) found.push(rel);
    }
  }
  return found;
}

function cImports(rootDir: string, importer: string, content: string): string[] {
  const found: string[] = [];
  for (const m of content.matchAll(C_INCLUDE)) {
    const include = m.groups!.path!;
    if (include.startsWith("/")) continue;
    const rel = [
      path.posix.join(path.posix.dirname(importer), include),
      path.posix.normalize(include),
    ].find((candidate) => isProjectFile(rootDir, candidate));
    if (rel) found.push(rel);
  }
  return found;
}

function csNamespaces(content: string): NonNullable<FileEntry["namespaces"]> {
  const declares: string[] = [];
  const uses: string[] = [];
  for (const m of content.matchAll(CS_NAMESPACE)) {
    if (m.groups!.declares !== undefined) declares.push(m.groups!.declares);
    else uses.push(m.groups!.uses!);
  }
  const namespaces: NonNullable<FileEntry["namespaces"]> = {};
  if (declares.length > 0) namespaces.declares = firstUnique(declares);
  if (uses.length > 0) namespaces.uses = firstUnique(uses);
  return namespaces;
}

function tsJsImports(rootDir: string, importer: string, content: string): string[] {
  const behind = namedThroughReexports(rootDir, importer, content);
  const found: string[] = [];
  for (const m of content.matchAll(TS_JS_SPECIFIER)) {
    const { from, bare, call } = m.groups!;
    const rel = resolveTsJs(rootDir, importer, (from ?? bare ?? call)!);
    const at = m.indices!.groups!.from?.[0];
    if (rel) found.push(rel, ...((at === undefined ? undefined : behind.get(at)) ?? []));
  }
  return found;
}

// tsconfig.json or jsconfig.json `compilerOptions.baseUrl` and `paths`, from the nearest config at
// or above the importer. `extends` is not followed. A config is parsed once per mtime and size.
const TS_CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];
type Aliases = { baseUrl: string | null; pathsBase: string; paths: [string, string[]][] };
const parsedConfigs = new Map<string, { stamp: string; aliases: Aliases | null }>();

/** Drops `//` and block comments and trailing commas outside strings, as tsconfig allows them. */
function stripJsonc(text: string): string {
  return text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str?: string) => str ?? "")
    .replace(
      /("(?:\\.|[^"\\])*")|,(\s*[}\]])/g,
      (_, str?: string, close?: string) => str ?? close!,
    );
}

/** A config's aliases, `paths` resolving against `baseUrl` when set and the config's directory otherwise. */
function aliasesOf(configDir: string, options: unknown): Aliases | null {
  if (!isObj(options)) return null;
  const baseUrl =
    typeof options.baseUrl === "string" ? path.posix.join(configDir, options.baseUrl) : null;
  const paths: [string, string[]][] = [];
  if (isObj(options.paths)) {
    for (const [pattern, targets] of Object.entries(options.paths)) {
      if (Array.isArray(targets)) {
        paths.push([pattern, targets.filter((t): t is string => typeof t === "string")]);
      }
    }
  }
  if (baseUrl === null && paths.length === 0) return null;
  return { baseUrl, pathsBase: baseUrl ?? configDir, paths };
}

function readAliases(rootDir: string, rel: string): Aliases | null {
  const abs = path.join(rootDir, rel);
  try {
    const stat = fs.statSync(abs);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const memo = parsedConfigs.get(abs);
    if (memo?.stamp === stamp) return memo.aliases;
    const parsed: unknown = JSON.parse(stripJsonc(fs.readFileSync(abs, "utf-8")));
    const aliases = isObj(parsed)
      ? aliasesOf(path.posix.dirname(rel), parsed.compilerOptions)
      : null;
    parsedConfigs.set(abs, { stamp, aliases });
    return aliases;
  } catch {
    // Unreadable or unparsable: the config resolves nothing.
    return null;
  }
}

function nearestAliases(rootDir: string, importer: string): Aliases | null {
  for (let dir = path.posix.dirname(importer); ; dir = path.posix.dirname(dir)) {
    for (const name of TS_CONFIG_NAMES) {
      const rel = dir === "." ? name : `${dir}/${name}`;
      if (isProjectFile(rootDir, rel)) return readAliases(rootDir, rel);
    }
    if (dir === ".") return null;
  }
}

/** The text a pattern's one `*` stands for in `specifier`, or null; a pattern without `*` matches only itself. */
function patternCapture(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  const fits =
    specifier.length >= prefix.length + suffix.length &&
    specifier.startsWith(prefix) &&
    specifier.endsWith(suffix);
  return fits ? specifier.slice(prefix.length, specifier.length - suffix.length) : null;
}

/** The longest-prefix `paths` pattern's first target that resolves, else `baseUrl` + the specifier. */
function resolveAlias(rootDir: string, importer: string, specifier: string): string | null {
  const aliases = nearestAliases(rootDir, importer);
  if (aliases === null) return null;
  let best: { prefix: number; targets: string[]; capture: string } | null = null;
  for (const [pattern, targets] of aliases.paths) {
    const capture = patternCapture(pattern, specifier);
    const prefix = pattern.indexOf("*") < 0 ? pattern.length : pattern.indexOf("*");
    if (capture !== null && (best === null || prefix > best.prefix)) {
      best = { prefix, targets, capture };
    }
  }
  for (const target of best?.targets ?? []) {
    const base = path.posix.join(aliases.pathsBase, target.replace("*", best!.capture));
    const found = resolveTsJsPath(rootDir, base);
    if (found) return found;
  }
  return aliases.baseUrl === null
    ? null
    : resolveTsJsPath(rootDir, path.posix.join(aliases.baseUrl, specifier));
}

// A braced import list (`import { a, b as c }`, `import type { … }`, or one after a default
// import) and its quoted specifier.
const TS_JS_NAMED =
  /\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{(?<names>[^}]*)\}\s*from\s*["'](?<spec>[^"'\n]+)["']/dg;
// A re-export (`export { a, b as c }` or `export *`, each followed by a quoted specifier);
// `export * as ns` names one binding.
const TS_JS_REEXPORT =
  /\bexport\s+(?:type\s+)?(?:\{(?<names>[^}]*)\}|\*(?:\s+as\s+(?<ns>[\w$]+))?)\s*from\s*["'](?<spec>[^"'\n]+)["']/g;
// A declaration exported where it stands, or an `export { … }` list with no `from`.
const TS_JS_DECLARED =
  /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|type|interface|enum|namespace)\s+(?<name>[\w$]+)|\bexport\s+(?:type\s+)?\{(?<list>[^}]*)\}(?!\s*from\b)/g;
const REEXPORT_HOPS = 3;

/** A module's exports as regex reads them: names it declares, names it re-exports, and its `export *` sources. */
type ModuleExports = {
  declared: Set<string>;
  named: Map<string, { spec: string; source: string }>;
  stars: string[];
};
const moduleExports = new Map<string, { stamp: string; exports: ModuleExports }>();

/** Each `a` or `a as b` of a brace list as [source name, bound name], `type` modifiers dropped. */
function braceNames(list: string): [string, string][] {
  const out: [string, string][] = [];
  for (const item of list.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").split(",")) {
    const m = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(item);
    if (m) out.push([m[1]!, m[2] ?? m[1]!]);
  }
  return out;
}

function parseExports(content: string): ModuleExports {
  const exports: ModuleExports = { declared: new Set(), named: new Map(), stars: [] };
  for (const m of content.matchAll(TS_JS_DECLARED)) {
    if (m.groups!.name) exports.declared.add(m.groups!.name);
    for (const [, bound] of braceNames(m.groups!.list ?? "")) exports.declared.add(bound);
  }
  for (const m of content.matchAll(TS_JS_REEXPORT)) {
    const { names, ns, spec } = m.groups!;
    if (ns) exports.named.set(ns, { spec: spec!, source: "*" });
    else if (names === undefined) exports.stars.push(spec!);
    for (const [source, bound] of braceNames(names ?? "")) {
      exports.named.set(bound, { spec: spec!, source });
    }
  }
  return exports;
}

/** The module's exports, or null for a file that is unreadable or longer than the symbol limit. */
function exportsOf(rootDir: string, rel: string): ModuleExports | null {
  const abs = path.join(rootDir, rel);
  try {
    const stat = fs.statSync(abs);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const memo = moduleExports.get(abs);
    if (memo?.stamp === stamp) return memo.exports;
    const content = fs.readFileSync(abs, "utf-8");
    if (content.length > SYMBOL_MAX_BYTES) return null;
    const exports = parseExports(content);
    moduleExports.set(abs, { stamp, exports });
    return exports;
  } catch {
    // Gone or unreadable since it resolved: this name links nothing more.
    return null;
  }
}

/**
 * The file declaring `name` behind `rel`, following re-exports up to `hops` more modules: `rel`
 * itself when it declares the name; for a name re-exported by name, the last module reached when
 * no deeper one declares it; null when nothing does or two `export *` sources both do.
 */
function declaringFile(rootDir: string, rel: string, name: string, hops: number): string | null {
  const exports = exportsOf(rootDir, rel);
  if (exports === null || exports.declared.has(name)) return exports ? rel : null;
  if (hops === 0) return null;
  const named = exports.named.get(name);
  if (named) {
    const next = resolveTsJs(rootDir, rel, named.spec);
    if (next === null || named.source === "*") return next;
    return declaringFile(rootDir, next, named.source, hops - 1) ?? next;
  }
  return starDeclarer(rootDir, rel, exports.stars, name, hops - 1);
}

/** The one file declaring `name` behind `rel`'s `export *` sources, or null for none or several. */
function starDeclarer(
  rootDir: string,
  rel: string,
  stars: string[],
  name: string,
  hops: number,
): string | null {
  const found = new Set<string>();
  for (const spec of stars) {
    const next = resolveTsJs(rootDir, rel, spec);
    const file = next === null ? null : declaringFile(rootDir, next, name, hops);
    if (file) found.add(file);
  }
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * For each named import, keyed by its specifier's start index, the files declaring its names behind
 * the imported module's re-exports, the module itself left out.
 */
function namedThroughReexports(
  rootDir: string,
  importer: string,
  content: string,
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const m of content.matchAll(TS_JS_NAMED)) {
    const target = resolveTsJs(rootDir, importer, m.groups!.spec!);
    if (target === null) continue;
    const files: string[] = [];
    for (const [source] of braceNames(m.groups!.names!)) {
      const file = declaringFile(rootDir, target, source, REEXPORT_HOPS);
      if (file !== null && file !== target) files.push(file);
    }
    out.set(m.indices!.groups!.spec![0], files);
  }
  return out;
}

type ImportExtractor = (rootDir: string, importer: string, content: string) => string[];

const EXTRACTORS = new Map<string, ImportExtractor>([
  ...TS_JS_EXTENSIONS.map((ext): [string, ImportExtractor] => [ext, tsJsImports]),
  [".py", pythonImports],
  [".go", goImports],
  [".rs", rustImports],
  ...C_EXTENSIONS.map((ext): [string, ImportExtractor] => [ext, cImports]),
]);

/** The import targets of the extractor for `ext`, or `[]` for a language without one. */
function importTargets(rootDir: string, importer: string, ext: string, content: string): string[] {
  return EXTRACTORS.get(ext)?.(rootDir, importer, content) ?? [];
}

/**
 * The files `relPath` imports, as repo-relative paths in source order, or for
 * C# the namespaces it declares and uses. `{}` when nothing resolves; never
 * throws, since indexFile must not.
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
    const ext = path.posix.extname(importer).toLowerCase();
    if (ext === ".cs") {
      const namespaces = csNamespaces(content);
      return Object.keys(namespaces).length > 0 ? { namespaces } : {};
    }
    const targets = importTargets(rootDir, importer, ext, content);
    const imports = firstUnique(
      targets.filter((rel) => rel !== importer && isIndexableName(rel, config)),
    );
    return imports.length > 0 ? { imports } : {};
  } catch {
    return {};
  }
}

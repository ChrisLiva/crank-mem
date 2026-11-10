import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT } from "./helpers.ts";

// `init` vendors src/hooks/ into each project, so hook code may import only
// node: builtins and files inside src/hooks/. node:sqlite is type-only here.

const HOOKS_DIR = path.join(REPO_ROOT, "src/hooks");

const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function tsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((rel) => rel.endsWith(".ts"))
    .map((rel) => path.join(dir, rel));
}

/** Every rule break in `file`, as `<repo path>:<line>: <specifier>`. */
function violations(file: string): string[] {
  const text = fs.readFileSync(file, "utf-8");
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1]!;
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      const legal =
        spec === "node:sqlite"
          ? text.startsWith("import type", lineStart)
          : spec.startsWith("node:") ||
            (spec.startsWith(".") &&
              !path.relative(HOOKS_DIR, path.resolve(path.dirname(file), spec)).startsWith(".."));
      const line = text.slice(0, match.index).split("\n").length;
      if (!legal) found.push(`${path.relative(REPO_ROOT, file)}:${line}: ${spec}`);
    }
  }
  return found;
}

test("hook sources import only node: builtins and files inside src/hooks/", () => {
  const files = tsFiles(HOOKS_DIR);
  expect(files.length).toBeGreaterThan(0);
  expect(files.flatMap(violations)).toEqual([]);
});

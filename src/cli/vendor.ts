import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT } from "./version.ts";

// Vendoring: recursive copy of src/hooks/ (the single implementation,
// lib/ included) into <project>/.crank/hooks/. The CLI imports the same lib
// from the clone — no duplicated core.

export function vendorHooks(crankDir: string): void {
  const src = path.join(REPO_ROOT, "src", "hooks");
  const dest = path.join(crankDir, "hooks");
  fs.rmSync(dest, { recursive: true, force: true });
  // Only the implementation ships. Without this, editor/OS droppings beside the
  // sources (.DS_Store, .swp) get copied into every target project.
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (from) => !path.basename(from).startsWith("."),
  });
}

/**
 * Whether `<crankDir>/hooks/` holds exactly the clone's hook files, byte for
 * byte. Regular files only; a path with a dot-named segment is skipped on
 * either side, as vendorHooks skips it. False on any read error.
 */
export function vendoredHooksCurrent(crankDir: string): boolean {
  try {
    const clone = hookFiles(path.join(REPO_ROOT, "src", "hooks"));
    const vendored = hookFiles(path.join(crankDir, "hooks"));
    if (clone.size !== vendored.size) return false;
    for (const [rel, bytes] of clone) {
      const other = vendored.get(rel);
      if (!other || !bytes.equals(other)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hookFiles(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const rel of fs.readdirSync(dir, { recursive: true, encoding: "utf-8" })) {
    if (rel.split(path.sep).some((seg) => seg.startsWith("."))) continue;
    const file = path.join(dir, rel);
    if (fs.lstatSync(file).isFile()) files.set(rel, fs.readFileSync(file));
  }
  return files;
}

export function templatePath(name: string): string {
  return path.join(REPO_ROOT, "src", "templates", name);
}

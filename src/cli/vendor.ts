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

export function templatePath(name: string): string {
  return path.join(REPO_ROOT, "src", "templates", name);
}

import * as fs from "node:fs";
import * as path from "node:path";
import { CRANK_DIR, defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { registerProject } from "../src/hooks/lib/registry.ts";
import { REPO_ROOT, git, gitCommit, makeCrankHome, tempDir, withEnv } from "./helpers.ts";

type Workspace = {
  parent: string;
  home: string;
  H: string;
  clone: string;
  submodule: string;
  storefront: string;
  payments: string;
  worktree: string;
  scratch: string;
};

function writeFile(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function gitInit(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(dir, rel), content);
}

function install(root: string, home: string): void {
  const crankDir = path.join(root, CRANK_DIR);
  fs.mkdirSync(crankDir, { recursive: true });
  saveConfig(crankDir, { ...defaultConfig(), digest: true });
  const template = fs.readFileSync(path.join(REPO_ROOT, "src/templates/cerebrum.md"), "utf-8");
  fs.writeFileSync(
    path.join(crankDir, "cerebrum.md"),
    `${template.trimEnd()}\n- **Marker**: project ${path.basename(root)}.\n`,
  );
  withEnv({ CRANK_HOME: home }, () => registerProject(root));
}

/**
 * Sibling repos under one parent: installed `H` holding an uninstalled nested clone and a
 * submodule-style `.git` file, installed `storefront` and `payments-api`, a linked worktree of
 * `payments-api` with no `.crank/`, and uninstalled `scratch-repo`.
 */
export function workspace(): Workspace {
  const parent = fs.realpathSync(tempDir("crank-ws-"));
  const home = makeCrankHome();
  const H = path.join(parent, "H");
  const clone = path.join(H, "clones/u");
  const submodule = path.join(H, "vendor/m");
  const storefront = path.join(parent, "storefront");
  const payments = path.join(parent, "payments-api");
  const worktree = path.join(parent, "payments-api-wt");
  const scratch = path.join(parent, "scratch-repo");

  gitInit(H, { "src/h.ts": "export const h = 1;\n" });
  gitInit(clone, { "x.ts": "export const u = 1;\n" });
  fs.mkdirSync(path.join(H, ".git/modules/m"), { recursive: true });
  writeFile(path.join(submodule, ".git"), "gitdir: ../../.git/modules/m\n");
  writeFile(path.join(submodule, "x.ts"), "export const m = 1;\n");
  gitInit(storefront, { "src/a.ts": "export const storefront = 1;\n" });
  gitInit(payments, { "src/a.ts": "export const payments = 1;\n" });
  gitCommit(payments, "init");
  git(payments, "worktree", "add", "-q", "../payments-api-wt");
  gitInit(scratch, { "a.ts": "export const scratch = 1;\n" });

  for (const root of [H, storefront, payments]) install(root, home);
  return { parent, home, H, clone, submodule, storefront, payments, worktree, scratch };
}

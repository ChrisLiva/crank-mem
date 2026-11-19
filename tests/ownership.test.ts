import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  claudePostEdit,
  claudePostWrite,
  claudeSessionStart,
  codexApplyPatch,
} from "./fixtures/payloads.ts";
import { CRANK_DIR, defaultConfig, readJsonObject, saveConfig } from "../src/hooks/lib/config.ts";
import { openCodeDb } from "../src/hooks/lib/code-db.ts";
import { projectName } from "../src/hooks/lib/owner.ts";
import { installedStores, registerProject, rootOfName } from "../src/hooks/lib/registry.ts";
import {
  holdCodeDb,
  hookContext,
  makeCrankHome,
  makeCrankProject,
  plantCodeDb,
  runCli,
  runHook,
  seedMemory,
  tempDir,
  withEnv,
} from "./helpers.ts";
import { workspace } from "./workspace.ts";

const HOOK = "src/hooks/session-start.ts";
const POST_WRITE = "src/hooks/post-write.ts";

function postWrite(payload: object, home: string) {
  return runHook(POST_WRITE, JSON.stringify(payload), undefined, { CRANK_HOME: home });
}

/** What a project's code.db holds for each file, as one string; null when the project has no store. */
function indexBytes(root: string): string | null {
  const opened = openCodeDb(root, "read");
  if (opened.status !== "open" || !opened.db) return null;
  try {
    return JSON.stringify(
      opened.db.prepare("SELECT path, size, mtime_ms, write_count FROM files ORDER BY path").all(),
    );
  } finally {
    opened.db.close();
  }
}

function indexed(root: string): string[] {
  const opened = openCodeDb(root, "read");
  if (opened.status !== "open" || !opened.db) return [];
  try {
    return (opened.db.prepare("SELECT path FROM files").all() as { path: string }[]).map(
      (row) => row.path,
    );
  } finally {
    opened.db.close();
  }
}

/** Gives `root` an empty code.db, as a project whose store an earlier hook or command made. */
function createStore(root: string): void {
  const opened = openCodeDb(root, "write");
  expect(opened.status).toBe("open");
  opened.db!.close();
}

/** The repo roots `<home>/untouched.json` lists, or null when the file is absent. */
function untouchedRoots(home: string): string[] | null {
  const raw = readJsonObject(path.join(home, "untouched.json"));
  return raw === null ? null : (raw.repos as { root: string }[]).map((r) => r.root);
}

/** A linked worktree of `main` made by hand: its `.git` file points into `main`'s `worktrees/`. */
function handWorktree(main: string, top: string): void {
  const gitdir = path.join(main, ".git/worktrees", path.basename(top));
  fs.mkdirSync(gitdir, { recursive: true });
  fs.mkdirSync(top, { recursive: true });
  fs.writeFileSync(path.join(top, ".git"), `gitdir: ${gitdir}\n`);
}

function sessionStart(cwd: string, home: string) {
  return runHook(HOOK, JSON.stringify(claudeSessionStart(cwd)), undefined, { CRANK_HOME: home });
}

describe("ownership", () => {
  test("session start and the CLI resolve their project by the walk rule", () => {
    const ws = workspace();
    expect(hookContext(sessionStart(ws.H, ws.home))).toContain("project H.");
    const clone = sessionStart(ws.clone, ws.home);
    expect(clone).toMatchObject({ status: 0, stdout: "" });
    expect(runCli(ws.clone, ["search", "x"], { CRANK_HOME: ws.home })).toEqual({
      status: 1,
      stdout: "",
      stderr: "crank-mem: not initialized here — run `crank-mem init` first.\n",
    });
    expect(hookContext(sessionStart(ws.submodule, ws.home))).toContain("project H.");
    expect(hookContext(sessionStart(ws.worktree, ws.home))).toContain("project payments-api.");
    expect(sessionStart(ws.scratch, ws.home)).toMatchObject({ status: 0, stdout: "" });
    expect(fs.existsSync(path.join(ws.worktree, ".crank"))).toBe(false);

    fs.writeFileSync(
      path.join(ws.worktree, ".git"),
      "gitdir: ../payments-api/.git/worktrees/payments-api-wt\n",
    );
    expect(hookContext(sessionStart(ws.worktree, ws.home))).toContain("project payments-api.");

    // A worktree with its own config still reads the main store, with git failing.
    const crankDir = path.join(ws.worktree, CRANK_DIR);
    fs.mkdirSync(crankDir);
    saveConfig(crankDir, defaultConfig());
    seedMemory(ws.payments, [{ title: "Main store fact" }]);
    const bin = tempDir("crank-nogit-");
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const run = runCli(ws.worktree, ["search", "Main store fact"], {
      CRANK_HOME: ws.home,
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(run.stdout).toContain("Main store fact");
  });

  test("project names come from config, else the sanitized basename", () => {
    const root = path.join(tempDir("crank-name-"), "My App!");
    const crankDir = path.join(root, CRANK_DIR);
    fs.mkdirSync(crankDir, { recursive: true });
    expect(projectName(root)).toBe("My-App-");
    saveConfig(crankDir, defaultConfig());
    expect(projectName(root)).toBe("My-App-");
    saveConfig(crankDir, { ...defaultConfig(), name: "storefront" });
    expect(projectName(root)).toBe("storefront");
    saveConfig(crankDir, { ...defaultConfig(), name: "bad name" });
    expect(projectName(root)).toBe("My-App-");
  });

  test("a name maps to the newest root among distinct stores", () => {
    const named = (root: string, name: string) =>
      saveConfig(path.join(root, CRANK_DIR), { ...defaultConfig(), name });
    const a = makeCrankProject();
    const b = makeCrankProject();
    named(a, "dup");
    named(b, "dup");
    withEnv({ CRANK_HOME: makeCrankHome() }, () => {
      registerProject(a);
      Bun.sleepSync(2);
      registerProject(b);
      expect(rootOfName("dup")).toBe(b);
      named(b, "other");
      expect(rootOfName("dup")).toBe(a);
      expect(rootOfName("other")).toBe(b);
      expect(rootOfName("missing")).toBeNull();
    });

    const ws = workspace();
    fs.mkdirSync(path.join(ws.worktree, CRANK_DIR));
    named(ws.worktree, "payments-api");
    withEnv({ CRANK_HOME: ws.home }, () => {
      registerProject(ws.worktree);
      expect(rootOfName("payments-api")).toBe(ws.payments);
      const main = installedStores().filter(
        (s) => s.storeDir === path.join(ws.payments, CRANK_DIR),
      );
      expect(main).toHaveLength(1);
      expect(main[0]!.root).toBe(ws.payments);
      expect(installedStores()).toHaveLength(3);
    });
  });

  test("post-write routes each path by the walk rule", () => {
    const ws = workspace();
    const scratchWt = path.join(ws.parent, "scratch-wt");
    handWorktree(ws.scratch, scratchWt);
    fs.writeFileSync(path.join(scratchWt, "a.ts"), "export const wt = 1;\n");
    const projects: Record<string, string> = {
      H: ws.H,
      storefront: ws.storefront,
      "payments-api": ws.payments,
    };
    // Another project's store is written only once it exists; the start project's is created.
    createStore(ws.storefront);
    createStore(ws.payments);
    const rows: [string, Record<string, string>, string | null][] = [
      [ws.H, {}, null],
      [path.join(ws.clone, "x.ts"), {}, ws.clone],
      [path.join(ws.submodule, "x.ts"), { H: "vendor/m/x.ts" }, null],
      [path.join(ws.storefront, "src/a.ts"), { storefront: "src/a.ts" }, null],
      [path.join(ws.worktree, "src/a.ts"), {}, null],
      [path.join(ws.scratch, "a.ts"), {}, ws.scratch],
      [path.join(scratchWt, "a.ts"), {}, scratchWt],
      ["/nonexistent-crank-dir/x.ts", {}, null],
    ];
    for (const [written, gains, untouched] of rows) {
      const home = makeCrankHome();
      const before = Object.fromEntries(
        Object.entries(projects).map(([name, root]) => [name, indexBytes(root)]),
      );
      expect(postWrite(claudePostWrite(ws.H, written), home)).toMatchObject({
        status: 0,
        stdout: "",
      });
      for (const [name, root] of Object.entries(projects)) {
        const gained = gains[name];
        if (gained === undefined)
          expect([written, name, indexBytes(root)]).toEqual([written, name, before[name]!]);
        else expect(indexed(root)).toContain(gained);
      }
      expect([written, untouchedRoots(home)]).toEqual([
        written,
        untouched === null ? null : [untouched],
      ]);
    }

    const fromWorktree = makeCrankHome();
    const payments = indexBytes(ws.payments);
    const run = postWrite(
      claudePostWrite(ws.worktree, path.join(ws.worktree, "src/a.ts")),
      fromWorktree,
    );
    expect(run).toMatchObject({ status: 0, stdout: "" });
    expect(indexBytes(ws.payments)).toBe(payments);

    const fromScratch = makeCrankHome();
    const storefront = indexBytes(ws.storefront);
    const scratchRun = postWrite(
      claudePostWrite(ws.scratch, path.join(ws.storefront, "src/a.ts")),
      fromScratch,
    );
    expect(scratchRun).toMatchObject({ status: 0, stdout: "" });
    expect(indexBytes(ws.storefront)).toBe(storefront);
    expect(untouchedRoots(fromScratch)).toBeNull();
  });

  test("Codex apply_patch routes Add, Update and Delete to the owner", () => {
    const ws = workspace();
    const src = path.join(ws.storefront, "src");
    fs.writeFileSync(path.join(src, "old.ts"), "export const old = 1;\n");
    expect(runCli(ws.storefront, ["scan"], { CRANK_HOME: ws.home }).status).toBe(0);
    expect(indexed(ws.storefront)).toContain("src/old.ts");
    fs.writeFileSync(path.join(src, "new.ts"), "export const fresh = 1;\n");
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${path.join(src, "new.ts")}`,
      "+export const fresh = 1;",
      "*** Update File: ../storefront/src/a.ts",
      "@@",
      "+export const more = 2;",
      `*** Delete File: ${path.join(src, "old.ts")}`,
      "*** End Patch",
    ].join("\n");
    expect(postWrite(codexApplyPatch(ws.H, patch), ws.home)).toMatchObject({
      status: 0,
      stdout: "",
    });
    const files = indexed(ws.storefront);
    expect(files).toEqual(expect.arrayContaining(["src/new.ts", "src/a.ts"]));
    expect(files).not.toContain("src/old.ts");

    for (const name of ["e.ts", "m.ts"]) fs.writeFileSync(path.join(src, name), "export {};\n");
    expect(postWrite(claudePostEdit(ws.H, path.join(src, "e.ts")), ws.home).status).toBe(0);
    const multi = { ...claudePostEdit(ws.H, path.join(src, "m.ts")), tool_name: "MultiEdit" };
    expect(postWrite(multi, ws.home).status).toBe(0);
    expect(indexed(ws.storefront)).toEqual(expect.arrayContaining(["src/e.ts", "src/m.ts"]));
  });

  test("post-write leaves another project's code.db at another schema version alone and creates none", () => {
    const ws = workspace();
    const file = path.join(ws.storefront, CRANK_DIR, "code.db");
    plantCodeDb(ws.storefront, "newer");
    const before = fs.readFileSync(file);
    for (const root of [ws.H, ws.storefront, ws.payments]) {
      fs.writeFileSync(path.join(root, "src/n.ts"), "export const n = 1;\n");
    }
    const patch = [
      "*** Begin Patch",
      ...[ws.H, ws.storefront, ws.payments].flatMap((root) => [
        `*** Add File: ${path.join(root, "src/n.ts")}`,
        "+export const n = 1;",
      ]),
      "*** End Patch",
    ].join("\n");
    expect(postWrite(codexApplyPatch(ws.H, patch), ws.home).status).toBe(0);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    // The start project's store is created; another project's absent one stays absent.
    expect(fs.existsSync(path.join(ws.H, CRANK_DIR, "code.db"))).toBe(true);
    expect(fs.existsSync(path.join(ws.payments, CRANK_DIR, "code.db"))).toBe(false);
  });

  test("post-write exits 0 silently when another project or untouched.json cannot be written", () => {
    const ws = workspace();
    const silent = { status: 0, stdout: "", stderr: "" };
    createStore(ws.storefront);
    const store = path.join(ws.storefront, CRANK_DIR, "code.db");
    for (const root of [ws.H, ws.storefront]) {
      fs.writeFileSync(path.join(root, "src/a2.ts"), "export const a2 = 1;\n");
    }
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${path.join(ws.storefront, "src/a2.ts")}`,
      "+export const a2 = 1;",
      `*** Add File: ${path.join(ws.H, "src/a2.ts")}`,
      "+export const a2 = 1;",
      "*** End Patch",
    ].join("\n");
    fs.chmodSync(store, 0o000);
    try {
      expect(postWrite(codexApplyPatch(ws.H, patch), ws.home)).toMatchObject(silent);
      expect(indexed(ws.H)).toContain("src/a2.ts");
    } finally {
      fs.chmodSync(store, 0o644);
    }
    expect(indexed(ws.storefront)).toEqual([]);

    const untouched = path.join(ws.home, "untouched.json");
    fs.mkdirSync(untouched);
    try {
      const run = postWrite(claudePostWrite(ws.H, path.join(ws.scratch, "a.ts")), ws.home);
      expect(run).toMatchObject(silent);
    } finally {
      fs.rmSync(untouched, { recursive: true, force: true });
    }

    // A writer holding the store past the hook's busy wait leaves it as it was.
    const before = indexBytes(ws.storefront);
    const release = holdCodeDb(ws.storefront);
    try {
      const run = postWrite(claudePostWrite(ws.H, path.join(ws.storefront, "src/a.ts")), ws.home);
      expect(run).toMatchObject(silent);
    } finally {
      release();
    }
    expect(indexBytes(ws.storefront)).toBe(before);
  }, 15_000);
});

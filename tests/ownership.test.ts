import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  claudePostEdit,
  claudePostWrite,
  claudeSessionStart,
  codexApplyPatch,
} from "./fixtures/payloads.ts";
import { CRANK_DIR, defaultConfig, readJsonObject, saveConfig } from "../src/hooks/lib/config.ts";
import { INDEX_FILE, loadIndex } from "../src/hooks/lib/store.ts";
import { projectName } from "../src/hooks/lib/owner.ts";
import { memoryPath, openMemory } from "../src/hooks/lib/memory.ts";
import {
  installedStores,
  linkedProjects,
  registerProject,
  rootOfName,
} from "../src/hooks/lib/registry.ts";
import {
  makeCrankHome,
  makeCrankProject,
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

function indexBytes(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, CRANK_DIR, INDEX_FILE), "utf-8");
  } catch {
    return null;
  }
}

function indexed(root: string): string[] {
  return Object.keys(loadIndex(path.join(root, CRANK_DIR)).files);
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

function context(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

describe("ownership", () => {
  test("session start resolves its project by the walk rule", () => {
    const ws = workspace();
    expect(context(sessionStart(ws.H, ws.home).stdout)).toContain("project H.");
    const clone = sessionStart(ws.clone, ws.home);
    expect(clone).toMatchObject({ status: 0, stdout: "" });
    expect(context(sessionStart(ws.submodule, ws.home).stdout)).toContain("project H.");
    expect(context(sessionStart(ws.worktree, ws.home).stdout)).toContain("project payments-api.");
    expect(sessionStart(ws.scratch, ws.home)).toMatchObject({ status: 0, stdout: "" });
    expect(fs.existsSync(path.join(ws.worktree, ".crank"))).toBe(false);

    fs.writeFileSync(
      path.join(ws.worktree, ".git"),
      "gitdir: ../payments-api/.git/worktrees/payments-api-wt\n",
    );
    expect(context(sessionStart(ws.worktree, ws.home).stdout)).toContain("project payments-api.");
  });

  test("a nested clone is not its enclosing project's", () => {
    const ws = workspace();
    expect(runCli(ws.clone, ["search", "x"], { CRANK_HOME: ws.home })).toEqual({
      status: 1,
      stdout: "",
      stderr: "crank-mem: not initialized here — run `crank-mem init` first.\n",
    });
  });

  test("a worktree with its own config reads the main store without git", () => {
    const ws = workspace();
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

  test("linked projects are the stored links that resolve", () => {
    const ws = workspace();
    seedMemory(ws.H, [], { links: ["storefront", "ghost", "payments-api"] });
    const opened = openMemory(memoryPath(ws.H), "read");
    if (opened.status !== "open") throw new Error(opened.status);
    try {
      withEnv({ CRANK_HOME: ws.home }, () => {
        expect(linkedProjects(opened.memory)).toEqual([
          { name: "payments-api", root: ws.payments },
          { name: "storefront", root: ws.storefront },
        ]);
      });
    } finally {
      opened.memory.close();
    }
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

  test("post-write leaves another anatomy at another index version alone", () => {
    const ws = workspace();
    const file = path.join(ws.storefront, CRANK_DIR, INDEX_FILE);
    fs.writeFileSync(file, JSON.stringify({ version: 1, meta: {}, files: {} }));
    const before = fs.readFileSync(file, "utf-8");
    for (const root of [ws.H, ws.storefront]) {
      fs.writeFileSync(path.join(root, "src/n.ts"), "export const n = 1;\n");
    }
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${path.join(ws.H, "src/n.ts")}`,
      "+export const n = 1;",
      `*** Add File: ${path.join(ws.storefront, "src/n.ts")}`,
      "+export const n = 1;",
      "*** End Patch",
    ].join("\n");
    expect(postWrite(codexApplyPatch(ws.H, patch), ws.home).status).toBe(0);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    expect(indexed(ws.H)).toContain("src/n.ts");
  });

  test("post-write exits 0 silently when another project or untouched.json cannot be written", () => {
    const ws = workspace();
    const silent = { status: 0, stdout: "", stderr: "" };
    const anatomyMd = path.join(ws.storefront, CRANK_DIR, "anatomy.md");
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
    fs.mkdirSync(anatomyMd);
    try {
      expect(postWrite(codexApplyPatch(ws.H, patch), ws.home)).toMatchObject(silent);
      expect(indexed(ws.H)).toContain("src/a2.ts");
    } finally {
      fs.rmSync(anatomyMd, { recursive: true, force: true });
    }

    const untouched = path.join(ws.home, "untouched.json");
    fs.mkdirSync(untouched);
    try {
      const run = postWrite(claudePostWrite(ws.H, path.join(ws.scratch, "a.ts")), ws.home);
      expect(run).toMatchObject(silent);
    } finally {
      fs.rmSync(untouched, { recursive: true, force: true });
    }

    const lock = path.join(ws.storefront, CRANK_DIR, "anatomy-index.lock");
    const before = indexBytes(ws.storefront);
    fs.writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: Date.now() + 60_000,
      }),
    );
    try {
      const run = postWrite(claudePostWrite(ws.H, path.join(ws.storefront, "src/a.ts")), ws.home);
      expect(run).toMatchObject(silent);
      expect(indexBytes(ws.storefront)).toBe(before);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }, 15_000);
});

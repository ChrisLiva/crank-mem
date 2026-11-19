import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type * as sqlite from "node:sqlite";
import { fileFacts, walkProject } from "../src/hooks/lib/scanner.ts";
import { openCodeDb, refreshFileFacts } from "../src/hooks/lib/code-db.ts";
import { defaultConfig } from "../src/hooks/lib/config.ts";
import {
  git,
  gitCommit,
  makeCrankProject,
  runCli,
  runHook,
  setMtime,
  withReadOnlyCodeDb,
} from "./helpers.ts";
import { claudePostWrite, claudeSessionStart, codexApplyPatch } from "./fixtures/payloads.ts";

function makeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-scan-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

describe("walkProject", () => {
  test("finds files, skips excluded dirs, sensitive and binary files", () => {
    const root = makeProject({
      "src/a.ts": "export const a = 1;",
      "README.md": "# Hi",
      "node_modules/pkg/index.js": "x",
      ".crank/anatomy.md": "internal",
      ".claude/skills/tdd/SKILL.md": "# skill",
      ".github/workflows/ci.yml": "on: push",
      ".env": "SECRET=1",
      "logo.png": "binary",
      "img/layer1.webp": "binary",
      "deps/libgmp-10.lib": "binary",
      "pnpm-lock.yaml": "lockfileVersion: 9",
      "web/package-lock.json": "{}",
    });
    expect(walkProject(root, defaultConfig(), Infinity)!.sort()).toEqual(["README.md", "src/a.ts"]);
  });

  test("outside git, lists every file in path order with no cap", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 600; i++) files[`f${String(i).padStart(3, "0")}.ts`] = "x";
    const root = makeProject(files);
    expect(walkProject(root, defaultConfig(), Infinity)).toEqual(Object.keys(files));
  });
});

describe("walkProject in a git repo", () => {
  function makeRepo(files: Record<string, string>): string {
    const root = makeProject(files);
    git(root, "init", "-q");
    return root;
  }

  test("lists git's files, ranks first-party code ahead of vendored code, and takes every one", () => {
    const root = makeRepo({
      ".gitignore": "ignored/\n",
      "ignored/x.ts": "x",
      "deps_src/a.ts": "x",
      "deps_src/b.ts": "x",
      "src/a.ts": "x",
      "src/b.ts": "x",
      "src/c.ts": "x",
      "README.md": "# Hi",
      "notes.md": "untracked",
    });
    git(root, "add", ".gitignore", "deps_src", "src", "README.md");
    expect(walkProject(root, defaultConfig(), Infinity)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "README.md",
      "notes.md",
      "deps_src/a.ts",
      "deps_src/b.ts",
    ]);
  });

  test("a listing past 1 MiB still comes from git", () => {
    const root = makeRepo({ ".gitignore": "ignored/\n", "ignored/x.ts": "x", "src/a.ts": "x" });
    // 12,000 index entries with no file on disk: ~1.2 MB of output, which
    // fails with ENOBUFS at the 1 MiB default maxBuffer and would fall back to
    // the tree walk, where ignored/x.ts reappears.
    const entries = Array.from(
      { length: 12_000 },
      (_, i) => `100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\tzz/${"p".repeat(90)}${i}.txt\n`,
    ).join("");
    const r = spawnSync("git", ["update-index", "--add", "--index-info"], {
      cwd: root,
      input: entries,
    });
    expect(r.status).toBe(0);
    expect(walkProject(root, defaultConfig(), Infinity)).toEqual(["src/a.ts"]);
  });

  test("a conflicted path git lists once per stage counts once", () => {
    const root = makeRepo({ "a.ts": "x", "b.ts": "x", "c.ts": "x" });
    git(root, "add", "b.ts", "c.ts");
    const blob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    const stages = [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\ta.ts\n`).join("");
    const r = spawnSync("git", ["update-index", "--index-info"], { cwd: root, input: stages });
    expect(r.status).toBe(0);
    expect(
      git(root, "ls-files", "-co")
        .split("\n")
        .filter((l) => l === "a.ts"),
    ).toHaveLength(3);
    expect(walkProject(root, defaultConfig(), Infinity)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("a tracked symlink is not a file to index", () => {
    const root = makeRepo({ "src/a.ts": "x" });
    const outside = makeProject({ "secret.txt": "outside the project" });
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    git(root, "add", ".");
    expect(walkProject(root, defaultConfig(), Infinity)).toEqual(["src/a.ts"]);
  });

  /** Runs `fn` with a `git` first on PATH that sleeps 2 s before `ls-files`, then runs the real one. */
  function withSlowLsFiles<T>(fn: () => T): T {
    const realGit = Bun.which("git")!;
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "crank-git-shim-"));
    fs.writeFileSync(
      path.join(shimDir, "git"),
      `#!/bin/sh\ncase " $* " in *" ls-files "*) sleep 2;; esac\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    const saved = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${saved}`;
    try {
      return fn();
    } finally {
      process.env.PATH = saved;
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  }

  test("a slow git listing is waited for with no deadline, and past a deadline keeps code.db's rows and reports partial", () => {
    const root = makeRepo({ ".gitignore": "ignored.ts\n", "a.ts": "const a = 1;" });
    git(root, "add", ".");
    fs.writeFileSync(path.join(root, "ignored.ts"), "const i = 1;");
    const config = defaultConfig();
    const db = openFacts(root);
    try {
      withSlowLsFiles(() => {
        refreshFileFacts(root, config, db, Infinity);
        const before = filesIn(db);
        expect(before).toContain("a.ts");
        expect(before).not.toContain("ignored.ts");
        const result = refreshFileFacts(root, config, db, Date.now() + 1000);
        expect(result).toEqual({ changed: 0, added: 0, removed: 0, partial: true, listed: false });
        expect(filesIn(db)).toEqual(before);
      });
    } finally {
      db.close();
    }
  }, 20_000);
});

describe("fileFacts", () => {
  test("reads a file's description, tokens, size and mtime, and flags a generated file", () => {
    const bigTs =
      "/** Widget engine. */\n" +
      Array.from({ length: 60 }, (_, i) => `export function w${i}() { return ${i}; }`).join("\n");
    const root = makeProject({
      "src/big.ts": bigTs,
      "notes.md": "# Notes\nbody",
      "api/gen/models.go": "// Code generated by sqlc. DO NOT EDIT.\n\npackage gen\n",
      "api/auth.go": "package api\n",
    });
    setMtime(path.join(root, "src/big.ts"), 1_700_000_000_000);
    const big = fileFacts(root, "src/big.ts", defaultConfig())!;
    expect(big.description).toBe("Widget engine.");
    // 22 chars of header + 60 functions (10 at 34 chars, 50 at 36) + 59 newlines = 2221 bytes; code files are 3.5 chars a token, so ceil(2221 / 3.5) = 635.
    expect(big.tokens).toBe(635);
    expect(big.size).toBe(2221);
    expect(big.mtimeMs).toBe(1_700_000_000_000);
    expect(big.generated).toBe(false);
    expect(fileFacts(root, "notes.md", defaultConfig())!.description).toBe("Notes");
    expect(fileFacts(root, "api/gen/models.go", defaultConfig())).toMatchObject({
      generated: true,
      description: "Code generated by sqlc. DO NOT EDIT.",
    });
    expect(fileFacts(root, "api/auth.go", defaultConfig())!.generated).toBe(false);
  });

  test("skips files with a NUL byte in the first 8,000 bytes", () => {
    const root = makeProject({
      "blob.dat": "RIFF\0\0WEBP",
      "late-nul.txt": "x".repeat(8000) + "\0",
      "plain.txt": "hello",
    });
    const config = defaultConfig();
    expect(fileFacts(root, "blob.dat", config)).toBeNull();
    expect(fileFacts(root, "late-nul.txt", config)).not.toBeNull();
    expect(fileFacts(root, "plain.txt", config)).not.toBeNull();
  });

  test("gives nothing for a sensitive, excluded, oversized, missing or unreadable path", () => {
    const root = makeProject({
      ".env": "SECRET=1",
      "node_modules/p/i.js": "x",
      "big.ts": "x".repeat(100),
      "locked.ts": "x",
      "ok.ts": "x",
    });
    const config = { ...defaultConfig(), max_file_size_bytes: 50 };
    const locked = path.join(root, "locked.ts");
    fs.chmodSync(locked, 0o000);
    try {
      for (const rel of [".env", "node_modules/p/i.js", "big.ts", "missing.ts", "locked.ts"])
        expect(fileFacts(root, rel, config)).toBeNull();
    } finally {
      fs.chmodSync(locked, 0o644);
    }
    expect(fileFacts(root, "ok.ts", config)).not.toBeNull();
  });
});

describe("ownership", () => {
  /** P: a git repo holding a nested project, a nested clone and a submodule. */
  function makeOwnersRepo(): string {
    const root = makeProject({
      "src/a.ts": "export const a = 1;",
      "pkg/.crank/config.json": "{}",
      "pkg/x.ts": "export const x = 1;",
      "clones/u/y.ts": "export const y = 1;",
      "vendor/m/.git": "gitdir: ../../.git/modules/m\n",
      "vendor/m/x.ts": "export const m = 1;",
    });
    git(root, "init", "-q");
    git(path.join(root, "clones/u"), "init", "-q");
    fs.mkdirSync(path.join(root, ".git/modules/m"), { recursive: true });
    return root;
  }

  /** Q: no git, no install, holding a nested project and a nested repo. */
  function makeOwnersTree(extra: Record<string, string>): string {
    return makeProject({
      "q1.ts": "export const q1 = 1;",
      "q2.ts": "export const q2 = 1;",
      "child/.crank/config.json": "{}",
      "child/c.ts": "export const c = 1;",
      "repo/.git/HEAD": "ref: refs/heads/main\n",
      "repo/r.ts": "export const r = 1;",
      ...extra,
    });
  }

  test("a walk leaves out files another project or repo owns, and stops there", () => {
    expect(walkProject(makeOwnersRepo(), defaultConfig(), Infinity)!.sort()).toEqual([
      "src/a.ts",
      "vendor/m/x.ts",
    ]);

    const extra: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) extra[`child/f${i}.ts`] = `export const f${i} = 1;`;
    expect(walkProject(makeOwnersTree(extra), defaultConfig(), Infinity)!.sort()).toEqual([
      "q1.ts",
      "q2.ts",
    ]);
  });
});

/** A fresh code.db for `root`, closed by the test's `finally`. */
function openFacts(root: string): sqlite.DatabaseSync {
  fs.mkdirSync(path.join(root, ".crank"), { recursive: true });
  const opened = openCodeDb(root, "write");
  expect(opened.status).toBe("open");
  return opened.db!;
}

const filesIn = (db: sqlite.DatabaseSync): string[] =>
  (db.prepare("SELECT path FROM files ORDER BY path").all() as { path: string }[]).map(
    (row) => row.path,
  );

describe("refreshFileFacts", () => {
  test("unchanged files are not read again", () => {
    const root = makeCrankProject({ "a.ts": "/** Alpha. */\nconst x = 1;\n" });
    const file = path.join(root, "a.ts");
    const start = () =>
      runHook("src/hooks/session-start.ts", JSON.stringify(claudeSessionStart(root)));
    const described = () => withReadOnlyCodeDb(root, () => runCli(root, ["anatomy"]).stdout);
    const stamp = fs.statSync(file).mtimeMs - 5000;
    setMtime(file, stamp);
    expect(start().status).toBe(0);
    expect(described()).toContain("`a.ts` — Alpha.");

    // Same size, new text, the old mtime: a refresh that reads the file again would show "Omega."
    fs.writeFileSync(file, "/** Omega. */\nconst x = 1;\n");
    setMtime(file, stamp);
    expect(start().status).toBe(0);
    expect(described()).toContain("`a.ts` — Alpha.");

    setMtime(file, stamp + 2000);
    expect(start().status).toBe(0);
    expect(described()).toContain("`a.ts` — Omega.");
  });

  test("an expired deadline marks partial, reads no new file and still drops deleted ones", () => {
    const root = makeProject({ "a.ts": "const a = 1;", "gone.ts": "const g = 1;" });
    const config = defaultConfig();
    const db = openFacts(root);
    try {
      refreshFileFacts(root, config, db, Infinity);
      fs.unlinkSync(path.join(root, "gone.ts"));
      fs.writeFileSync(path.join(root, "new.ts"), "const n = 1;");
      const result = refreshFileFacts(root, config, db, 0);
      expect(result).toMatchObject({ partial: true, removed: 1, added: 0 });
      expect(filesIn(db)).toEqual(["a.ts"]);
    } finally {
      db.close();
    }
  });
});

describe("churn and write pins", () => {
  const start = (root: string) =>
    runHook("src/hooks/session-start.ts", JSON.stringify(claudeSessionStart(root)));
  /** The files `crank-mem anatomy` lists under Most active files, as the hooks left them. */
  const mostActive = (root: string): string[] => {
    const out = withReadOnlyCodeDb(root, () => runCli(root, ["anatomy"]).stdout);
    const section = out.split("## Most active files")[1]?.split("## All files")[0] ?? "";
    return [...section.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!);
  };

  test("ranks by commits and skips commits touching more than 50 files", () => {
    const bulk: Record<string, string> = {};
    for (let i = 0; i < 51; i++) bulk[`vendor/v${i}.ts`] = "x";
    const root = makeCrankProject({ "src/a.ts": "x", "src/b.ts": "x", ...bulk });
    git(root, "init", "-q");
    gitCommit(root, "bulk");
    fs.writeFileSync(path.join(root, "src/b.ts"), "y");
    gitCommit(root, "b");
    fs.writeFileSync(path.join(root, "src/b.ts"), "z");
    fs.writeFileSync(path.join(root, "src/a.ts"), "z");
    gitCommit(root, "a and b");
    expect(start(root).status).toBe(0);
    expect(mostActive(root)).toEqual(["src/b.ts", "src/a.ts"]);
  });

  test("keeps at most 100 write pins, dropping the least recently written", () => {
    const root = makeCrankProject({ "old.ts": "export const old = 1;\n" });
    // The oldest file is written most, so it tops the list unless the pin cap drops it.
    setMtime(path.join(root, "old.ts"), new Date(2020, 0, 1).getTime());
    for (let i = 0; i < 3; i++)
      runHook(
        "src/hooks/post-write.ts",
        JSON.stringify(claudePostWrite(root, path.join(root, "old.ts"))),
      );
    const added: string[] = [];
    for (let i = 0; i < 100; i++) {
      const rel = `f${String(i).padStart(3, "0")}.ts`;
      fs.writeFileSync(path.join(root, rel), `export const v${i} = ${i};\n`);
      added.push(`*** Add File: ${path.join(root, rel)}`, "+x");
    }
    const patch = ["*** Begin Patch", ...added, "*** End Patch"].join("\n");
    expect(
      runHook("src/hooks/post-write.ts", JSON.stringify(codexApplyPatch(root, patch))).status,
    ).toBe(0);
    expect(start(root).status).toBe(0);
    const active = mostActive(root);
    expect(active).toHaveLength(25);
    expect(active).not.toContain("old.ts");
  });
});

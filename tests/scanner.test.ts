import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type * as sqlite from "node:sqlite";
import { fileFacts, walkProject } from "../src/hooks/lib/scanner.ts";
import { openCodeDb, refreshFileFacts } from "../src/hooks/lib/code-db.ts";
import { readChurn, writeActivity } from "../src/hooks/lib/activity.ts";
import { defaultConfig } from "../src/hooks/lib/config.ts";
import { git, gitCommit } from "./helpers.ts";

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
    expect(walkProject(root, defaultConfig()).sort()).toEqual(["README.md", "src/a.ts"]);
  });

  test("outside git, lists every file in path order with no cap", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 600; i++) files[`f${String(i).padStart(3, "0")}.ts`] = "x";
    const root = makeProject(files);
    expect(walkProject(root, defaultConfig())).toEqual(Object.keys(files));
  });

  test("an oversized file is no file to index", () => {
    const root = makeProject({ "big.ts": "x".repeat(100), "small.ts": "x" });
    const config = { ...defaultConfig(), max_file_size_bytes: 50 };
    expect(fileFacts(root, "big.ts", config)).toBeNull();
    expect(fileFacts(root, "small.ts", config)).not.toBeNull();
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
    expect(walkProject(root, defaultConfig())).toEqual([
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
    expect(walkProject(root, defaultConfig())).toEqual(["src/a.ts"]);
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
    expect(walkProject(root, defaultConfig())).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("an oversized file is left out of the walk", () => {
    const root = makeRepo({ "src/a.ts": "x".repeat(100), "src/b.ts": "x", "src/c.ts": "x" });
    git(root, "add", ".");
    const config = { ...defaultConfig(), max_file_size_bytes: 50 };
    expect(walkProject(root, config)).toEqual(["src/b.ts", "src/c.ts"]);
  });

  test("a tracked symlink is not a file to index", () => {
    const root = makeRepo({ "src/a.ts": "x" });
    const outside = makeProject({ "secret.txt": "outside the project" });
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    git(root, "add", ".");
    expect(walkProject(root, defaultConfig())).toEqual(["src/a.ts"]);
  });
});

describe("fileFacts", () => {
  test("reads a file's description, tokens, size and mtime", () => {
    const bigTs =
      "/** Widget engine. */\n" +
      Array.from({ length: 60 }, (_, i) => `export function w${i}() { return ${i}; }`).join("\n");
    const root = makeProject({ "src/big.ts": bigTs, "notes.md": "# Notes\nbody" });
    const big = fileFacts(root, "src/big.ts", defaultConfig())!;
    expect(big.description).toBe("Widget engine.");
    expect(big.tokens).toBeGreaterThan(300);
    expect(big.size).toBe(Buffer.byteLength(bigTs));
    expect(big.generated).toBe(false);
    expect(fileFacts(root, "notes.md", defaultConfig())!.description).toBe("Notes");
  });

  test("flags a generated file and keeps its description", () => {
    const root = makeProject({
      "api/gen/models.go": "// Code generated by sqlc. DO NOT EDIT.\n\npackage gen\n",
      "api/auth.go": "package api\n",
    });
    const config = defaultConfig();
    expect(fileFacts(root, "api/gen/models.go", config)).toMatchObject({
      generated: true,
      description: "Code generated by sqlc. DO NOT EDIT.",
    });
    expect(fileFacts(root, "api/auth.go", config)!.generated).toBe(false);
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

  test("gives nothing for a sensitive, excluded, missing or unreadable path", () => {
    const root = makeProject({ ".env": "SECRET=1", "node_modules/p/i.js": "x", "ok.ts": "x" });
    const config = defaultConfig();
    for (const rel of [".env", "node_modules/p/i.js", "missing.ts"])
      expect(fileFacts(root, rel, config)).toBeNull();
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
    expect(walkProject(makeOwnersRepo(), defaultConfig()).sort()).toEqual([
      "src/a.ts",
      "vendor/m/x.ts",
    ]);

    const extra: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) extra[`child/f${i}.ts`] = `export const f${i} = 1;`;
    expect(walkProject(makeOwnersTree(extra), defaultConfig()).sort()).toEqual(["q1.ts", "q2.ts"]);
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
  test("detects changed, added, deleted", () => {
    const root = makeProject({ "a.ts": "const a = 1;", "b.ts": "const b = 1;" });
    const config = defaultConfig();
    const db = openFacts(root);
    try {
      expect(refreshFileFacts(root, config, db, Infinity)).toMatchObject({ added: 2 });

      // change a (content + size), add c and d, delete b
      fs.writeFileSync(path.join(root, "a.ts"), "const a = 12345; // changed now");
      fs.writeFileSync(path.join(root, "c.ts"), "const c = 1;");
      fs.writeFileSync(path.join(root, "d.ts"), "const d = 1;");
      fs.unlinkSync(path.join(root, "b.ts"));

      expect(refreshFileFacts(root, config, db, Infinity)).toEqual({
        changed: 1,
        added: 2,
        removed: 1,
        partial: false,
      });
      expect(filesIn(db)).toEqual(["a.ts", "c.ts", "d.ts"]);
    } finally {
      db.close();
    }
  });

  test("unchanged files are not read again", () => {
    const root = makeProject({ "a.ts": "const a = 1;" });
    const config = defaultConfig();
    const db = openFacts(root);
    try {
      refreshFileFacts(root, config, db, Infinity);
      // A sentinel no analysis would ever produce: reading a file again overwrites its description.
      db.exec("UPDATE files SET description = 'SENTINEL — not read again'");
      expect(refreshFileFacts(root, config, db, Infinity).changed).toBe(0);
      expect(
        (db.prepare("SELECT description FROM files").get() as { description: string }).description,
      ).toBe("SENTINEL — not read again");
    } finally {
      db.close();
    }
  });

  test("drops a file once it grows past max_file_size_bytes", () => {
    const root = makeProject({ "a.ts": "const a = 1;" });
    const config = { ...defaultConfig(), max_file_size_bytes: 50 };
    const db = openFacts(root);
    try {
      refreshFileFacts(root, config, db, Infinity);
      expect(filesIn(db)).toEqual(["a.ts"]);
      fs.writeFileSync(path.join(root, "a.ts"), "x".repeat(100));
      expect(refreshFileFacts(root, config, db, Infinity).removed).toBe(1);
      expect(filesIn(db)).toEqual([]);
    } finally {
      db.close();
    }
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

  test("drops a file once a nested project claims it", () => {
    const p = makeProject({ "src/a.ts": "export const a = 1;", "pkg/x.ts": "export const x = 1;" });
    git(p, "init", "-q");
    const config = defaultConfig();
    const db = openFacts(p);
    try {
      refreshFileFacts(p, config, db, Infinity);
      expect(filesIn(db)).toContain("pkg/x.ts");
      fs.mkdirSync(path.join(p, "pkg/.crank"));
      fs.writeFileSync(path.join(p, "pkg/.crank/config.json"), "{}");
      refreshFileFacts(p, config, db, Infinity);
      expect(filesIn(db)).toEqual(["src/a.ts"]);
    } finally {
      db.close();
    }

    // Outside git the walk itself stops at the claim.
    const q = makeProject({ "q1.ts": "export const q1 = 1;", "child/c.ts": "export const c = 1;" });
    const qdb = openFacts(q);
    try {
      refreshFileFacts(q, config, qdb, Infinity);
      fs.mkdirSync(path.join(q, "child/.crank"));
      fs.writeFileSync(path.join(q, "child/.crank/config.json"), "{}");
      refreshFileFacts(q, config, qdb, Infinity);
      expect(filesIn(qdb)).toEqual(["q1.ts"]);
    } finally {
      qdb.close();
    }
  });
});

describe("churn and write pins", () => {
  test("ranks by commits, skips commits touching more than 50 files, and reuses the list while HEAD stays put", () => {
    const bulk: Record<string, string> = {};
    for (let i = 0; i < 51; i++) bulk[`vendor/v${i}.ts`] = "x";
    const root = makeProject({ "src/a.ts": "x", "src/b.ts": "x", ...bulk });
    git(root, "init", "-q");
    gitCommit(root, "bulk");
    fs.writeFileSync(path.join(root, "src/b.ts"), "y");
    gitCommit(root, "b");
    fs.writeFileSync(path.join(root, "src/b.ts"), "z");
    fs.writeFileSync(path.join(root, "src/a.ts"), "z");
    gitCommit(root, "a and b");
    const config = defaultConfig();
    const db = openFacts(root);
    try {
      refreshFileFacts(root, config, db, Infinity);
      writeActivity(db, root, config);
      const head = git(root, "rev-parse", "HEAD").trim();
      expect(readChurn(db)).toEqual({ head, paths: ["src/b.ts", "src/a.ts"] });

      // A cached list for the current HEAD is trusted as is; a new commit replaces it.
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('churn', ?)").run(
        JSON.stringify({ head, paths: ["src/a.ts"] }),
      );
      writeActivity(db, root, config);
      expect(readChurn(db)!.paths).toEqual(["src/a.ts"]);
      fs.writeFileSync(path.join(root, "src/a.ts"), "w");
      gitCommit(root, "a");
      writeActivity(db, root, config);
      expect(readChurn(db)!.paths).toEqual(["src/a.ts", "src/b.ts"]);
    } finally {
      db.close();
    }
  });

  test("keeps at most 100 write pins, dropping the least recently written", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 101; i++) files[`f${String(i).padStart(3, "0")}.ts`] = "x";
    const root = makeProject(files);
    fs.utimesSync(path.join(root, "f050.ts"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    const config = defaultConfig();
    const db = openFacts(root);
    try {
      refreshFileFacts(root, config, db, Infinity);
      db.exec("UPDATE files SET write_count = 1");
      writeActivity(db, root, config);
      const pinned = (
        db.prepare("SELECT path FROM files WHERE write_count = 1").all() as {
          path: string;
        }[]
      ).map((row) => row.path);
      expect(pinned).toHaveLength(100);
      expect(pinned).not.toContain("f050.ts");
    } finally {
      db.close();
    }
  });
});

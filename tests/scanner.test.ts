import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fullScan, refreshIndex, walkProject } from "../src/hooks/lib/scanner.ts";
import { defaultConfig } from "../src/hooks/lib/config.ts";
import { SYMBOL_MIN_TOKENS } from "../src/hooks/lib/symbols.ts";
import { git } from "./helpers.ts";

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
    const files = walkProject(root, defaultConfig()).files;
    expect(files.sort()).toEqual(["README.md", "src/a.ts"]);
  });

  test("outside git, caps at max_files and records truncation without a count", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${String(i).padStart(2, "0")}.ts`] = "x";
    const root = makeProject(files);
    expect(walkProject(root, { ...defaultConfig(), max_files: 5 })).toEqual({
      files: ["f00.ts", "f01.ts", "f02.ts", "f03.ts", "f04.ts"],
      truncated: true,
      candidateCount: null,
    });
    const all = walkProject(root, { ...defaultConfig(), max_files: 20 });
    expect(all.truncated).toBe(false);
    expect(all.candidateCount).toBe(20);
  });

  test("oversized files survive the stat-free walk but are not indexed", () => {
    const root = makeProject({ "big.ts": "x".repeat(100), "small.ts": "x" });
    const config = { ...defaultConfig(), max_file_size_bytes: 50 };
    expect(walkProject(root, config).files.sort()).toEqual(["big.ts", "small.ts"]);
    expect(Object.keys(fullScan(root, config).files)).toEqual(["small.ts"]);
  });
});

describe("walkProject in a git repo", () => {
  function makeRepo(files: Record<string, string>): string {
    const root = makeProject(files);
    git(root, "init", "-q");
    return root;
  }

  test("lists git's files, ranks first-party code ahead of vendored code, and cuts at max_files", () => {
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
    expect(walkProject(root, { ...defaultConfig(), max_files: 5 })).toEqual({
      files: ["src/a.ts", "src/b.ts", "src/c.ts", "README.md", "notes.md"],
      truncated: true,
      candidateCount: 7,
    });
  });

  test("a listing past 1 MiB still comes from git", () => {
    const root = makeRepo({ ".gitignore": "ignored/\n", "ignored/x.ts": "x", "src/a.ts": "x" });
    // 12,000 index entries with no file on disk: ~1.2 MB of output, which
    // throws ENOBUFS at execFileSync's default buffer and would fall back to
    // the tree walk, where ignored/x.ts reappears.
    const entries = Array.from(
      { length: 12_000 },
      (_, i) => `100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\tzz/${"p".repeat(90)}${i}.txt\n`
    ).join("");
    const r = spawnSync("git", ["update-index", "--add", "--index-info"], { cwd: root, input: entries });
    expect(r.status).toBe(0);
    expect(walkProject(root, defaultConfig())).toEqual({
      files: ["src/a.ts"],
      truncated: false,
      candidateCount: 12_001,
    });
  });

  test("a tracked symlink is not a file to index", () => {
    const root = makeRepo({ "src/a.ts": "x" });
    const outside = makeProject({ "secret.txt": "outside the project" });
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    git(root, "add", ".");
    expect(walkProject(root, defaultConfig()).files).toEqual(["src/a.ts"]);
  });
});

describe("fullScan", () => {
  test("indexes with descriptions, tokens, symbols for big files", () => {
    const bigTs = "/** Widget engine. */\n" +
      Array.from({ length: 60 }, (_, i) => `export function w${i}() { return ${i}; }`).join("\n");
    const root = makeProject({ "src/big.ts": bigTs, "notes.md": "# Notes\nbody" });
    const index = fullScan(root, defaultConfig());
    expect(index.meta.fileCount).toBe(2);
    const big = index.files["src/big.ts"]!;
    expect(big.description).toBe("Widget engine.");
    expect(big.tokens).toBeGreaterThan(300);
    expect(big.symbols!.length).toBeGreaterThan(0);
    expect(index.files["notes.md"]!.description).toBe("Notes");
  });

  test("omits symbols for test, spec and generated files but keeps their descriptions", () => {
    const body = Array.from({ length: 100 }, (_, i) => `export function w${i}() { return ${i}; }`).join("\n");
    const goBody = "package api\n" + Array.from({ length: 100 }, (_, i) => `func W${i}() int { return ${i} }`).join("\n");
    const pyBody = Array.from({ length: 100 }, (_, i) => `def test_w${i}():\n    assert ${i}`).join("\n");
    const root = makeProject({
      "src/widget.ts": body,
      "src/api.py": pyBody,
      "api/auth.go": goBody,
      "src/widget.test.ts": body,
      "src/widget.spec.ts": body,
      "src/__tests__/widget.ts": body,
      "tests/test_api.py": pyBody,
      "api/auth_test.go": goBody,
      "api/gen/models.go": "// Code generated by sqlc. DO NOT EDIT.\n\n" + goBody,
    });
    const files = fullScan(root, defaultConfig()).files;
    for (const rel of ["src/widget.ts", "src/api.py", "api/auth.go"]) expect(files[rel]!.symbols!.length).toBeGreaterThan(0);
    for (const rel of ["src/widget.test.ts", "src/widget.spec.ts", "src/__tests__/widget.ts", "tests/test_api.py", "api/auth_test.go", "api/gen/models.go"]) {
      expect(files[rel]!.tokens).toBeGreaterThanOrEqual(SYMBOL_MIN_TOKENS);
      expect(files[rel]!.symbols).toBeUndefined();
    }
    expect(files["api/gen/models.go"]!.description).toBe("Code generated by sqlc. DO NOT EDIT.");
  });

  test("skips files with a NUL byte in the first 8,000 bytes", () => {
    const root = makeProject({
      "blob.dat": "RIFF\0\0WEBP",
      "late-nul.txt": "x".repeat(8000) + "\0",
      "plain.txt": "hello",
    });
    expect(Object.keys(fullScan(root, defaultConfig()).files).sort()).toEqual(["late-nul.txt", "plain.txt"]);
  });
});

describe("walk metadata", () => {
  test("fullScan records truncation and the candidate count; refreshIndex clears truncation once it no longer applies", () => {
    const root = makeProject({ "a.ts": "x", "b.ts": "x", "c.ts": "x" });
    git(root, "init", "-q");
    const config = { ...defaultConfig(), max_files: 2 };
    const index = fullScan(root, config);
    expect(index.meta.truncated).toBe(true);
    expect(index.meta.candidateCount).toBe(3);
    fs.unlinkSync(path.join(root, "c.ts"));
    const result = refreshIndex(root, config, index, 5000);
    expect(result.index.meta.truncated).toBeUndefined();
    expect(result.index.meta.candidateCount).toBe(2);
  });
});

describe("refreshIndex", () => {
  test("detects changed, added, deleted", () => {
    const root = makeProject({ "a.ts": "const a = 1;", "b.ts": "const b = 1;" });
    const config = defaultConfig();
    const index = fullScan(root, config);

    // change a (content + size), add c, delete b
    fs.writeFileSync(path.join(root, "a.ts"), "const a = 12345; // changed now");
    fs.writeFileSync(path.join(root, "c.ts"), "const c = 1;");
    fs.unlinkSync(path.join(root, "b.ts"));

    const result = refreshIndex(root, config, index, 5000);
    expect(result.changed).toBe(1);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.partial).toBe(false);
    expect(Object.keys(result.index.files).sort()).toEqual(["a.ts", "c.ts"]);
  });

  test("unchanged files are not re-extracted", () => {
    const root = makeProject({ "a.ts": "const a = 1;" });
    const config = defaultConfig();
    const index = fullScan(root, config);
    // A sentinel no analysis would ever produce: re-extraction overwrites the
    // whole entry, so its survival is the observation. (mtimeMs cannot serve —
    // it is copied from the file's stat and is identical either way.)
    index.files["a.ts"]!.description = "SENTINEL — not re-extracted";
    const result = refreshIndex(root, config, index, 5000);
    expect(result.changed).toBe(0);
    expect(result.index.files["a.ts"]!.description).toBe("SENTINEL — not re-extracted");
  });

  test("drops the stale entry when a file grows past max_file_size_bytes", () => {
    const root = makeProject({ "a.ts": "const a = 1;" });
    const config = { ...defaultConfig(), max_file_size_bytes: 50 };
    const index = fullScan(root, config);
    expect(index.files["a.ts"]).toBeDefined();
    fs.writeFileSync(path.join(root, "a.ts"), "x".repeat(100));
    const result = refreshIndex(root, config, index, 5000);
    expect(result.index.files["a.ts"]).toBeUndefined();
    expect(result.removed).toBe(1);
  });

  test("zero budget marks partial", () => {
    const root = makeProject({ "a.ts": "const a = 1;" });
    const config = defaultConfig();
    const result = refreshIndex(root, config, { version: 1, meta: { lastScanned: null, fileCount: 0 }, files: {} }, -1);
    expect(result.partial).toBe(true);
    expect(result.index.meta.partial).toBe(true);
  });
});

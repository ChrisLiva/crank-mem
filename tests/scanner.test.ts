import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fullScan, refreshIndex, walkProject } from "../src/hooks/lib/scanner.ts";
import { defaultConfig } from "../src/hooks/lib/config.ts";

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
    });
    const files = walkProject(root, defaultConfig());
    expect(files.sort()).toEqual(["README.md", "src/a.ts"]);
  });

  test("caps at max_files", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${String(i).padStart(2, "0")}.ts`] = "x";
    const root = makeProject(files);
    const config = { ...defaultConfig(), max_files: 5 };
    expect(walkProject(root, config).length).toBe(5);
  });

  test("oversized files survive the stat-free walk but are not indexed", () => {
    const root = makeProject({ "big.ts": "x".repeat(100), "small.ts": "x" });
    const config = { ...defaultConfig(), max_file_size_bytes: 50 };
    expect(walkProject(root, config).sort()).toEqual(["big.ts", "small.ts"]);
    expect(Object.keys(fullScan(root, config).files)).toEqual(["small.ts"]);
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
    const before = index.files["a.ts"]!.updatedAt;
    const result = refreshIndex(root, config, index, 5000);
    expect(result.changed).toBe(0);
    expect(result.index.files["a.ts"]!.updatedAt).toBe(before);
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

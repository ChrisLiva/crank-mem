import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  emptyIndex, loadIndex, commitIndex, renderAnatomyMd, INDEX_FILE, ANATOMY_FILE,
  type FileEntry,
} from "../src/hooks/lib/store.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crank-store-"));
}

function entry(description: string): FileEntry {
  return {
    description, tokens: 100, size: 350, mtimeMs: 123,
    updatedAt: "2026-07-16T00:00:00Z", source: "scan",
  };
}

describe("index store", () => {
  test("missing index loads empty", () => {
    const idx = loadIndex(tmpDir());
    expect(idx.files).toEqual({});
    expect(idx.meta.fileCount).toBe(0);
  });

  test("corrupt index loads empty", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, INDEX_FILE), "{not json");
    expect(loadIndex(dir).files).toEqual({});
  });

  test("wrong-shape index loads empty", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify({ version: 999 }));
    expect(loadIndex(dir).files).toEqual({});
  });

  test("commitIndex persists index + anatomy.md, fileCount maintained", () => {
    const dir = tmpDir();
    const result = commitIndex(dir, 1_000, (current) => {
      expect(current.files).toEqual({});
      const idx = emptyIndex();
      idx.files["src/a.ts"] = entry("Alpha");
      return idx;
    });
    expect(result).not.toBeNull();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), "utf-8"));
    expect(onDisk.meta.fileCount).toBe(1);
    expect(onDisk.files["src/a.ts"].description).toBe("Alpha");
    expect(fs.readFileSync(path.join(dir, ANATOMY_FILE), "utf-8")).toContain("`src/a.ts` — Alpha");
    const loaded = loadIndex(dir);
    expect(loaded.meta.fileCount).toBe(1);
    expect(loaded.files["src/a.ts"]!.description).toBe("Alpha");
  });

  test("commitIndex hands build the current on-disk index", () => {
    const dir = tmpDir();
    commitIndex(dir, 1_000, () => {
      const idx = emptyIndex();
      idx.files["src/a.ts"] = entry("Alpha");
      return idx;
    });
    commitIndex(dir, 1_000, (current) => {
      current.files["src/b.ts"] = entry("Beta");
      return current;
    });
    const loaded = loadIndex(dir);
    expect(Object.keys(loaded.files).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(loaded.meta.fileCount).toBe(2);
  });

  test("build returning null skips the save", () => {
    const dir = tmpDir();
    expect(commitIndex(dir, 1_000, () => null)).toBeNull();
    expect(fs.existsSync(path.join(dir, INDEX_FILE))).toBe(false);
    expect(fs.existsSync(path.join(dir, ANATOMY_FILE))).toBe(false);
  });

  test("renderAnatomyMd includes files and symbol sub-bullets", () => {
    const idx = emptyIndex();
    idx.files["src/b.ts"] = {
      description: "Beta", tokens: 600, size: 2100, mtimeMs: 1,
      updatedAt: "2026-07-16T00:00:00Z", source: "scan",
      symbols: [{ name: "beta", kind: "fn", startLine: 1, endLine: 20, tokens: 550 }],
    };
    idx.meta.fileCount = 1;
    const md = renderAnatomyMd(idx);
    expect(md).toContain("- `src/b.ts` — Beta (~600 tok)");
    expect(md).toContain("  - beta (fn, L1–L20, ~550 tok)");
  });
});

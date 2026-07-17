import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyIndex, loadIndex, saveIndex, renderAnatomyMd, INDEX_FILE } from "../src/hooks/lib/store.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crank-store-"));
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

  test("save/load round-trip, fileCount maintained", () => {
    const dir = tmpDir();
    const idx = emptyIndex();
    idx.files["src/a.ts"] = {
      description: "Alpha", tokens: 100, size: 350, mtimeMs: 123,
      updatedAt: "2026-07-16T00:00:00Z", source: "scan",
    };
    saveIndex(dir, idx);
    const loaded = loadIndex(dir);
    expect(loaded.meta.fileCount).toBe(1);
    expect(loaded.files["src/a.ts"]!.description).toBe("Alpha");
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

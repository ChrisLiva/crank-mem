import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeFile, MAX_DESC_CHARS } from "../src/hooks/lib/describe.ts";

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crank-desc-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe("describeFile", () => {
  test("known filename wins", () => {
    expect(describeFile(tmpFile("tsconfig.json", "{}"))).toBe("TypeScript compiler configuration");
  });
  test("package.json uses its own description field", () => {
    expect(describeFile(tmpFile("package.json", '{"description":"My great tool"}'))).toBe("My great tool");
  });
  test("package.json without description falls back to label", () => {
    expect(describeFile(tmpFile("package.json", "{}"))).toBe("Package manifest");
  });
  test("markdown heading", () => {
    expect(describeFile(tmpFile("notes.md", "# Design Notes\n\nbody"))).toBe("Design Notes");
  });
  test("docblock summary", () => {
    expect(describeFile(tmpFile("a.ts", "/**\n * Parses widgets.\n * @param x\n */\nexport function p() {}"))).toBe("Parses widgets.");
  });
  test("python docstring", () => {
    expect(describeFile(tmpFile("a.py", '"""Frobnicates the baz."""\ndef f(): pass'))).toBe("Frobnicates the baz.");
  });
  test("header line comment", () => {
    expect(describeFile(tmpFile("b.ts", "// Widget registry.\nconst x = 1;"))).toBe("Widget registry.");
  });
  test("declaration fallback", () => {
    expect(describeFile(tmpFile("c.ts", "export class WidgetStore {}\n"))).toBe("Defines WidgetStore");
  });
  test("json description field", () => {
    expect(describeFile(tmpFile("thing.json", '{"description":"A config"}'))).toBe("A config");
  });
  test("caps at MAX_DESC_CHARS", () => {
    const d = describeFile(tmpFile("long.md", "# " + "x".repeat(400)));
    expect(d.length).toBeLessThanOrEqual(MAX_DESC_CHARS);
  });
  test("unreadable file returns empty", () => {
    expect(describeFile("/nonexistent/nope.ts")).toBe("");
  });
});

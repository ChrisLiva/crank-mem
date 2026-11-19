import { describe, expect, test } from "bun:test";
import { parseBlocks, parseBullets } from "../src/hooks/lib/bullets.ts";

const lines = (text: string): string[] => text.split("\n");

describe("parseBlocks", () => {
  test("a bullet absorbs wrapped prose, sub-bullets and blank separators", () => {
    const blocks = parseBlocks(
      lines(
        "- first bullet that wraps\n  across two physical lines\n  - a sub-bullet\n\n- second bullet",
      ),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["bullet", "bullet"]);
    expect(blocks[0]!.lines).toEqual([
      "- first bullet that wraps",
      "  across two physical lines",
      "  - a sub-bullet",
      "",
    ]);
    expect(blocks[1]!.lines).toEqual(["- second bullet"]);
  });

  test("a heading is a hard boundary: it closes the open bullet and never joins one", () => {
    const blocks = parseBlocks(lines("- a bullet\n### Nested heading\nloose prose\n- another"));
    expect(blocks.map((b) => b.kind)).toEqual(["bullet", "other", "bullet"]);
    expect(blocks[0]!.lines).toEqual(["- a bullet"]);
    expect(blocks[1]!.lines).toEqual(["### Nested heading", "loose prose"]);
  });

  // the cerebrum editor writes blocks back to disk, so the grouping must be lossless:
  // every line lands in exactly one block, in order.
  test("blocks round-trip the input verbatim, and a leading non-bullet preamble is its own block", () => {
    const text =
      "# Cerebrum\n\n## Memory\n\n- 中文 bullet — em dash, \ttab\n  continuation with 🚀\n" +
      "### Misfiled heading\n- trailing bullet with no newline after it";
    const roundTrip = (t: string): string =>
      parseBlocks(lines(t))
        .flatMap((b) => b.lines)
        .join("\n");
    expect(roundTrip(text)).toBe(text);
    expect(roundTrip("- one\n- two\n")).toBe("- one\n- two\n");

    const blocks = parseBlocks(lines("# Journal\n\nSession log, newest last.\n\n- entry one"));
    expect(blocks[0]!.kind).toBe("other");
    expect(blocks[0]!.lines).toEqual(["# Journal", "", "Session log, newest last.", ""]);
    expect(blocks[1]!.lines).toEqual(["- entry one"]);
  });
});

describe("parseBullets", () => {
  test("returns whole bullets, oldest first, with trailing blanks dropped", () => {
    expect(parseBullets(lines("preamble\n- one\n  wrapped\n\n- two\n\n"))).toEqual([
      "- one\n  wrapped",
      "- two",
    ]);
  });

  test("a lone dash is not a bullet", () => {
    // `- ` requires the space: a horizontal rule or a stray `-` is prose.
    expect(parseBullets(lines("-\n---\n-not a bullet"))).toEqual([]);
  });
});

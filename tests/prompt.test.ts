import { describe, expect, test } from "bun:test";
import { choose, decodeKey } from "../src/cli/prompt.ts";

describe("decodeKey", () => {
  test("arrows move with wrap-around", () => {
    expect(decodeKey("\x1b[B", 0, 3)).toEqual({ type: "move", index: 1 });
    expect(decodeKey("\x1b[B", 2, 3)).toEqual({ type: "move", index: 0 });
    expect(decodeKey("\x1b[A", 1, 3)).toEqual({ type: "move", index: 0 });
    expect(decodeKey("\x1b[A", 0, 3)).toEqual({ type: "move", index: 2 });
  });

  test("j/k move like arrows", () => {
    expect(decodeKey("j", 0, 2)).toEqual({ type: "move", index: 1 });
    expect(decodeKey("k", 0, 2)).toEqual({ type: "move", index: 1 });
  });

  test("enter submits, esc/ctrl-d cancel, ctrl-c interrupts", () => {
    expect(decodeKey("\r", 0, 2)).toEqual({ type: "submit" });
    expect(decodeKey("\n", 0, 2)).toEqual({ type: "submit" });
    expect(decodeKey("\x1b", 0, 2)).toEqual({ type: "cancel" });
    expect(decodeKey("\x04", 0, 2)).toEqual({ type: "cancel" });
    expect(decodeKey("\x03", 0, 2)).toEqual({ type: "interrupt" });
  });

  test("other keys are ignored", () => {
    expect(decodeKey("x", 0, 2)).toEqual({ type: "none" });
  });

  test("tolerates coalesced reads and pty \\r→\\n rewrite", () => {
    // A fast pty can deliver an arrow + enter in one read, with \r rewritten.
    expect(decodeKey("\x1b[B\n", 0, 3)).toEqual({ type: "submit" });
    expect(decodeKey("\x1b[B", 0, 3)).toEqual({ type: "move", index: 1 });
    // Enter is any chunk ending in a newline.
    expect(decodeKey("foo\r", 0, 2)).toEqual({ type: "submit" });
  });
});

describe("choose", () => {
  test("returns the default without a TTY", async () => {
    // Under the test runner stdin is a pipe, so choose must not block.
    expect(await choose("Pick one?", ["a", "b"], "b")).toBe("b");
  });
});

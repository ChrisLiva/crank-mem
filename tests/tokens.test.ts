import { describe, expect, test } from "bun:test";
import { estimateTokens } from "../src/hooks/lib/tokens.ts";

describe("estimateTokens", () => {
  test("code files use chars/3.5", () => {
    expect(estimateTokens("x".repeat(350), "a.ts")).toBe(100);
  });
  test("prose files use chars/4.0", () => {
    expect(estimateTokens("x".repeat(400), "a.md")).toBe(100);
  });
  test("other files use chars/3.75", () => {
    expect(estimateTokens("x".repeat(375), "a.weird")).toBe(100);
  });
  test("rounds up", () => {
    expect(estimateTokens("x", "a.ts")).toBe(1);
  });
});

import { expect, test } from "bun:test";
import { estimateTokens } from "../src/hooks/lib/tokens.ts";

test("estimateTokens divides characters by 3.5 for code, 4 for prose and 3.75 otherwise, rounding up", () => {
  expect(estimateTokens("x".repeat(350), "a.ts")).toBe(100);
  expect(estimateTokens("x".repeat(400), "a.md")).toBe(100);
  expect(estimateTokens("x".repeat(375), "a.weird")).toBe(100);
  expect(estimateTokens("x", "a.ts")).toBe(1);
});

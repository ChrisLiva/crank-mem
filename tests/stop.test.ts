import { describe, expect, test } from "bun:test";
import { runHook } from "./helpers.ts";

const HOOK = "src/hooks/stop.ts";

describe("stop hook (black-box)", () => {
  test("garbage stdin: exit 0", () => {
    expect(runHook(HOOK, "]]garbage").status).toBe(0);
  });

  test("empty stdin: exit 0", () => {
    expect(runHook(HOOK, "").status).toBe(0);
  });
});

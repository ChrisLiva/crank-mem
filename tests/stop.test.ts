import { describe, expect, test } from "bun:test";
import { runHook } from "./helpers.ts";

const HOOK = "src/hooks/stop.ts";

describe("stop hook (black-box)", () => {
  test("garbage or empty stdin: exit 0", () => {
    for (const stdin of ["]]garbage", ""]) expect(runHook(HOOK, stdin).status).toBe(0);
  });
});

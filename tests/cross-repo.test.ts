import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { claudePostWrite, claudeSessionStart } from "./fixtures/payloads.ts";
import { readUntouched } from "../src/hooks/lib/untouched.ts";
import { runHook, withEnv } from "./helpers.ts";
import { workspace } from "./workspace.ts";

const SESSION = "a46b6073-1111-2222-3333-444455556666";

describe("cross-repo memory", () => {
  test("journey 1: a session started in H captures across projects", () => {
    const ws = workspace();
    const hook = (name: string, payload: object) =>
      runHook(`src/hooks/${name}.ts`, JSON.stringify(payload), undefined, { CRANK_HOME: ws.home });
    const scratchSessions = () =>
      withEnv({ CRANK_HOME: ws.home }, readUntouched).find((r) => r.root === ws.scratch)?.sessions;

    expect(hook("session-start", claudeSessionStart(ws.H)).status).toBe(0);

    const storefrontFile = path.join(ws.storefront, "src/a.ts");
    expect(hook("post-write", claudePostWrite(ws.H, storefrontFile)).status).toBe(0);
    expect(fs.readFileSync(path.join(ws.storefront, ".crank/anatomy.md"), "utf-8")).toContain(
      "src/a.ts",
    );

    const scratchFile = path.join(ws.scratch, "a.ts");
    expect(hook("post-write", claudePostWrite(ws.H, scratchFile)).status).toBe(0);
    expect(scratchSessions()).toEqual([SESSION]);

    const numericId = { ...claudePostWrite(ws.H, scratchFile), session_id: 7 };
    expect(hook("post-write", numericId).status).toBe(0);
    expect(scratchSessions()).toEqual([SESSION]);
  });
});

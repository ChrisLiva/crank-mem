import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  crankHooks, mergeHooksIntoFile, removeCrankHooksFromFile,
  addIgnoreLines, removeIgnoreLines, ensureCodexFeatures, removeCodexFeatures,
} from "../src/cli/settings.ts";

function tmpFile(name = "settings.json"): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crank-set-")), name);
}

describe("mergeHooksIntoFile", () => {
  test("creates file with our hooks when absent", () => {
    const f = tmpFile();
    mergeHooksIntoFile(f, crankHooks("bun", "claude"));
    const parsed = JSON.parse(fs.readFileSync(f, "utf-8"));
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toContain("crank/hooks/session-start.ts");
    expect(parsed.hooks.PostToolUse[0].matcher).toBe("Write|Edit|MultiEdit");
  });

  test("preserves pre-existing settings byte-identical apart from appended entries", () => {
    const f = tmpFile();
    const preexisting = {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      },
    };
    fs.writeFileSync(f, JSON.stringify(preexisting, null, 2) + "\n");
    mergeHooksIntoFile(f, crankHooks("bun", "claude"));
    const parsed = JSON.parse(fs.readFileSync(f, "utf-8"));
    // user entries intact, ours appended after
    expect(parsed.permissions).toEqual(preexisting.permissions);
    expect(parsed.hooks.Stop).toEqual(preexisting.hooks.Stop);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe("echo mine");
    expect(parsed.hooks.SessionStart[1].hooks[0].command).toContain("crank/hooks/");
    // removal returns exactly the pre-existing bytes
    removeCrankHooksFromFile(f);
    expect(fs.readFileSync(f, "utf-8")).toBe(JSON.stringify(preexisting, null, 2) + "\n");
  });

  test("merge is idempotent (re-init does not duplicate)", () => {
    const f = tmpFile();
    mergeHooksIntoFile(f, crankHooks("bun", "claude"));
    mergeHooksIntoFile(f, crankHooks("bun", "claude"));
    const parsed = JSON.parse(fs.readFileSync(f, "utf-8"));
    expect(parsed.hooks.SessionStart.length).toBe(1);
  });

  test("codex hooks use apply_patch matcher and relative command", () => {
    const hooks = crankHooks("node", "codex");
    expect(hooks.PostToolUse![0]!.matcher).toBe("apply_patch");
    expect(hooks.SessionStart![0]!.hooks[0]!.command).toBe(
      "node --disable-warning=ExperimentalWarning crank/hooks/session-start.ts"
    );
  });
});

describe("removeCrankHooksFromFile", () => {
  test("missing file is a no-op", () => {
    expect(removeCrankHooksFromFile("/nonexistent/settings.json")).toBe(false);
  });
  test("drops empty hooks object entirely", () => {
    const f = tmpFile();
    mergeHooksIntoFile(f, crankHooks("bun", "claude"));
    removeCrankHooksFromFile(f);
    expect(JSON.parse(fs.readFileSync(f, "utf-8"))).toEqual({});
  });
});

describe("ignore lines", () => {
  test("add + remove round-trips existing content", () => {
    const f = tmpFile(".gitignore");
    fs.writeFileSync(f, "node_modules/\ndist/\n");
    addIgnoreLines(f);
    expect(fs.readFileSync(f, "utf-8")).toBe("node_modules/\ndist/\n# crank-mem\ncrank/\n");
    addIgnoreLines(f); // idempotent
    expect(fs.readFileSync(f, "utf-8")).toBe("node_modules/\ndist/\n# crank-mem\ncrank/\n");
    removeIgnoreLines(f);
    expect(fs.readFileSync(f, "utf-8")).toBe("node_modules/\ndist/\n");
  });
  test("handles file without trailing newline", () => {
    const f = tmpFile(".gitignore");
    fs.writeFileSync(f, "dist/");
    addIgnoreLines(f);
    expect(fs.readFileSync(f, "utf-8")).toBe("dist/\n# crank-mem\ncrank/\n");
  });
  test("user's own crank/ line survives add + remove untouched", () => {
    const f = tmpFile(".gitignore");
    const original = "crank/\ndist/";
    fs.writeFileSync(f, original);
    addIgnoreLines(f); // skips: crank/ already covered
    removeIgnoreLines(f); // must not strip the user's line
    expect(fs.readFileSync(f, "utf-8")).toBe(original);
  });
});

describe("codex features toml", () => {
  test("appends and removes exactly our snippet", () => {
    const f = tmpFile("config.toml");
    fs.writeFileSync(f, 'model = "gpt-5.6"\n');
    ensureCodexFeatures(f);
    expect(fs.readFileSync(f, "utf-8")).toContain("[features]\nhooks = true");
    ensureCodexFeatures(f); // idempotent
    expect(fs.readFileSync(f, "utf-8").match(/hooks = true/g)!.length).toBe(1);
    removeCodexFeatures(f);
    expect(fs.readFileSync(f, "utf-8")).toBe('model = "gpt-5.6"\n');
  });
  test("respects pre-existing hooks = true", () => {
    const f = tmpFile("config.toml");
    fs.writeFileSync(f, "[features]\nhooks = true\n");
    ensureCodexFeatures(f);
    expect(fs.readFileSync(f, "utf-8")).toBe("[features]\nhooks = true\n");
  });
});

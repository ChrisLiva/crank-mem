import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  crankHooks, mergeHooksIntoFile, removeCrankHooksFromFile,
  addIgnoreLines, removeIgnoreLines, ensureCodexFeatures, removeCodexFeatures,
} from "../src/cli/settings.ts";
import { vendorHooks } from "../src/cli/vendor.ts";
import { makeCrankProject } from "./helpers.ts";
import { claudeSessionStart } from "./fixtures/payloads.ts";

function tmpFile(name = "settings.json"): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crank-set-")), name);
}

describe("mergeHooksIntoFile", () => {
  test("creates file with our hooks when absent", () => {
    const f = tmpFile();
    mergeHooksIntoFile(f, crankHooks("bun", "claude"));
    const parsed = JSON.parse(fs.readFileSync(f, "utf-8"));
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toContain(".crank/hooks/session-start.ts");
    expect(parsed.hooks.PostToolUse[0].matcher).toBe("Write|Edit|MultiEdit");
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain(".crank/hooks/stop.ts");
  });

  test("Stop nudge is wired for Claude but not Codex", () => {
    expect(crankHooks("bun", "claude").Stop![0]!.hooks[0]!.command).toContain(".crank/hooks/stop.ts");
    expect(crankHooks("node", "codex").Stop).toBeUndefined();
  });

  test("SubagentStart is wired for Claude's four probed agent types only", () => {
    const [group] = crankHooks("bun", "claude").SubagentStart!;
    expect(group!.hooks[0]!.command).toContain(".crank/hooks/subagent-start.ts");
    const matcher = new RegExp(group!.matcher!);
    for (const type of ["general-purpose", "Explore", "Plan", "workflow-subagent"]) expect(matcher.test(type)).toBe(true);
    for (const type of ["my-reviewer", "Explorer", "general-purpose-2"]) expect(matcher.test(type)).toBe(false);
    expect(crankHooks("bun", "codex").SubagentStart).toBeUndefined();
  });

  test("preserves pre-existing settings byte-identical apart from appended entries", () => {
    const f = tmpFile();
    // UserPromptSubmit is an event crank never wires, so it must survive untouched.
    const preexisting = {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo prompt" }] }],
      },
    };
    fs.writeFileSync(f, JSON.stringify(preexisting, null, 2) + "\n");
    mergeHooksIntoFile(f, crankHooks("bun", "claude"));
    const parsed = JSON.parse(fs.readFileSync(f, "utf-8"));
    // user entries intact, ours appended after
    expect(parsed.permissions).toEqual(preexisting.permissions);
    expect(parsed.hooks.UserPromptSubmit).toEqual(preexisting.hooks.UserPromptSubmit);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe("echo mine");
    expect(parsed.hooks.SessionStart[1].hooks[0].command).toContain(".crank/hooks/");
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
      "[ ! -f .crank/hooks/session-start.ts ] || node --disable-warning=ExperimentalWarning .crank/hooks/session-start.ts"
    );
  });

  test("re-merge replaces bare and guarded crank commands without duplicating", () => {
    const bare = "bun .crank/hooks/session-start.ts";
    const guarded = "[ ! -f .crank/hooks/session-start.ts ] || bun .crank/hooks/session-start.ts";
    for (const old of [bare, guarded]) {
      const f = tmpFile("hooks.json");
      fs.writeFileSync(f, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: old }] }] } }));
      mergeHooksIntoFile(f, crankHooks("bun", "codex"));
      const parsed = JSON.parse(fs.readFileSync(f, "utf-8"));
      expect(parsed.hooks.SessionStart.length).toBe(1);
      expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe(guarded);
    }
  });

  test("refreshes crank's own forms in place and keeps a user-edited command", () => {
    const f = tmpFile();
    const userStop = 'test -f "$CLAUDE_PROJECT_DIR"/.crank/hooks/stop.ts && bun "$CLAUDE_PROJECT_DIR"/.crank/hooks/stop.ts';
    const bareStart = 'bun "$CLAUDE_PROJECT_DIR"/.crank/hooks/session-start.ts';
    fs.writeFileSync(f, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: bareStart }] },
          { hooks: [{ type: "command", command: "echo mine" }] },
          { hooks: [{ type: "command", command: bareStart }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: userStop }] }],
      },
    }));
    const want = crankHooks("bun", "claude");
    expect(mergeHooksIntoFile(f, want)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(f, "utf-8"));
    // First copy replaced where it stood, the second copy dropped.
    expect(parsed.hooks.SessionStart).toEqual([want.SessionStart![0], { hooks: [{ type: "command", command: "echo mine" }] }]);
    expect(parsed.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: userStop }] }]);
    // The event with no group for its script is appended.
    expect(parsed.hooks.PostToolUse).toEqual(want.PostToolUse);
  });

  test("an already-wired file is not rewritten", () => {
    const f = tmpFile();
    mergeHooksIntoFile(f, crankHooks("bun", "claude"));
    let called = false;
    expect(mergeHooksIntoFile(f, crankHooks("bun", "claude"), () => { called = true; })).toBe(false);
    expect(called).toBe(false);
  });
});

/** Run a wired command the way the agents do: through sh, in the project. */
function runWired(command: string, root: string, stdin = "{}") {
  const res = spawnSync("sh", ["-c", command], {
    cwd: root,
    input: stdin,
    encoding: "utf-8",
    timeout: 15_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return { status: res.status ?? -1, stdout: res.stdout };
}

describe("wired commands", () => {
  test("exit 0 with empty stdout when .crank/hooks is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-clean-checkout-"));
    for (const runtime of ["bun", "node"] as const) {
      for (const agent of ["claude", "codex"] as const) {
        for (const groups of Object.values(crankHooks(runtime, agent))) {
          const run = runWired(groups[0]!.hooks[0]!.command, root);
          expect(run.status).toBe(0);
          expect(run.stdout).toBe("");
        }
      }
    }
  });

  test("still run the vendored hook when it is present", () => {
    const root = makeCrankProject({ "app.ts": "export const app = 1;\n" });
    vendorHooks(path.join(root, ".crank"));
    const command = crankHooks("bun", "claude").SessionStart![0]!.hooks[0]!.command;
    const run = runWired(command, root, JSON.stringify(claudeSessionStart(root)));
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toContain("cerebrum");
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
    expect(fs.readFileSync(f, "utf-8")).toBe("node_modules/\ndist/\n# crank-mem\n.crank/\n");
    addIgnoreLines(f); // idempotent
    expect(fs.readFileSync(f, "utf-8")).toBe("node_modules/\ndist/\n# crank-mem\n.crank/\n");
    removeIgnoreLines(f);
    expect(fs.readFileSync(f, "utf-8")).toBe("node_modules/\ndist/\n");
  });
  test("handles file without trailing newline", () => {
    const f = tmpFile(".gitignore");
    fs.writeFileSync(f, "dist/");
    addIgnoreLines(f);
    expect(fs.readFileSync(f, "utf-8")).toBe("dist/\n# crank-mem\n.crank/\n");
  });
  test("user's own .crank/ line survives add + remove untouched", () => {
    const f = tmpFile(".gitignore");
    const original = ".crank/\ndist/";
    fs.writeFileSync(f, original);
    addIgnoreLines(f); // skips: .crank/ already covered
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

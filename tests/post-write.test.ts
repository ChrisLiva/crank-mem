import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeCrankProject, runHook } from "./helpers.ts";
import { claudePostWrite, claudePostEdit, codexApplyPatch, claudeSessionStart } from "./fixtures/payloads.ts";
import { parseApplyPatch } from "../src/hooks/lib/apply-patch.ts";
import { loadIndex } from "../src/hooks/lib/store.ts";

const HOOK = "src/hooks/post-write.ts";

function seedIndex(root: string): void {
  // Run session-start once to build the initial index.
  runHook("src/hooks/session-start.ts", JSON.stringify(claudeSessionStart(root)));
}

describe("parseApplyPatch", () => {
  test("parses Add, Update, Delete", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /abs/path/greeting.txt",
      "+hello",
      "*** Update File: src/main.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "*** Delete File: old.ts",
      "*** End Patch",
    ].join("\n");
    expect(parseApplyPatch(patch)).toEqual([
      { path: "/abs/path/greeting.txt", deleted: false },
      { path: "src/main.ts", deleted: false },
      { path: "old.ts", deleted: true },
    ]);
  });
  test("garbage patch yields no ops", () => {
    expect(parseApplyPatch("not a patch")).toEqual([]);
  });
  test("Move to: old path dropped, new path indexed", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old-name.ts",
      "*** Move to: src/new-name.ts",
      "*** End Patch",
    ].join("\n");
    expect(parseApplyPatch(patch)).toEqual([
      { path: "src/old-name.ts", deleted: true },
      { path: "src/new-name.ts", deleted: false },
    ]);
  });
});

describe("post-write hook (black-box)", () => {
  test("Claude Write: new file gets indexed, stdout silent", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    seedIndex(root);
    const newFile = path.join(root, "src/new.ts");
    fs.mkdirSync(path.dirname(newFile), { recursive: true });
    fs.writeFileSync(newFile, "/** Brand new module. */\nexport const n = 1;\n");

    const run = runHook(HOOK, JSON.stringify(claudePostWrite(root, newFile)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    const index = loadIndex(path.join(root, ".crank"));
    expect(index.files["src/new.ts"]!.description).toBe("Brand new module.");
    expect(index.files["src/new.ts"]!.source).toBe("hook");
  });

  test("Claude Edit: existing file re-indexed", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    seedIndex(root);
    fs.writeFileSync(path.join(root, "a.ts"), "/** Updated alpha. */\nconst a = 2;\n");
    const run = runHook(HOOK, JSON.stringify(claudePostEdit(root, path.join(root, "a.ts"))));
    expect(run.status).toBe(0);
    expect(loadIndex(path.join(root, ".crank")).files["a.ts"]!.description).toBe("Updated alpha.");
  });

  test("Codex apply_patch: Add and Update re-indexed, Delete dropped", () => {
    const root = makeCrankProject({ "keep.ts": "const k = 1;", "gone.ts": "const g = 1;" });
    seedIndex(root);
    expect(loadIndex(path.join(root, ".crank")).files["gone.ts"]).toBeDefined();

    fs.writeFileSync(path.join(root, "added.ts"), "/** Added by codex. */\nexport const x = 1;\n");
    fs.writeFileSync(path.join(root, "keep.ts"), "/** Keep updated. */\nconst k = 2;\n");
    fs.unlinkSync(path.join(root, "gone.ts"));

    const patch = [
      "*** Begin Patch",
      `*** Add File: ${path.join(root, "added.ts")}`,
      "+x",
      "*** Update File: keep.ts",
      "+k",
      "*** Delete File: gone.ts",
      "*** End Patch",
    ].join("\n");
    const run = runHook(HOOK, JSON.stringify(codexApplyPatch(root, patch)));
    expect(run.status).toBe(0);
    const index = loadIndex(path.join(root, ".crank"));
    expect(index.files["added.ts"]!.description).toBe("Added by codex.");
    expect(index.files["keep.ts"]!.description).toBe("Keep updated.");
    expect(index.files["gone.ts"]).toBeUndefined();
  });

  test("crank-internal and sensitive files are not indexed", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    seedIndex(root);
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
    runHook(HOOK, JSON.stringify(claudePostWrite(root, path.join(root, ".env"))));
    runHook(HOOK, JSON.stringify(claudePostWrite(root, path.join(root, ".crank/cerebrum.md"))));
    const index = loadIndex(path.join(root, ".crank"));
    expect(index.files[".env"]).toBeUndefined();
    expect(index.files[".crank/cerebrum.md"]).toBeUndefined();
  });

  test("relative apply_patch path resolves against session cwd, not project root", () => {
    const root = makeCrankProject({ "sub/dir/a.ts": "const a = 1;" });
    seedIndex(root);
    fs.writeFileSync(path.join(root, "sub/dir/fresh.ts"), "/** Fresh in subdir. */\nexport const f = 1;\n");
    const payload = {
      ...(codexApplyPatch(root, "*** Begin Patch\n*** Add File: fresh.ts\n+x\n*** End Patch") as object),
      cwd: path.join(root, "sub/dir"),
    };
    const run = runHook(HOOK, JSON.stringify(payload));
    expect(run.status).toBe(0);
    expect(loadIndex(path.join(root, ".crank")).files["sub/dir/fresh.ts"]!.description).toBe("Fresh in subdir.");
  });

  test("oversized file is skipped", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    seedIndex(root);
    fs.writeFileSync(path.join(root, "huge.ts"), "x".repeat(1024 * 1024 + 1));
    runHook(HOOK, JSON.stringify(claudePostWrite(root, path.join(root, "huge.ts"))));
    expect(loadIndex(path.join(root, ".crank")).files["huge.ts"]).toBeUndefined();
  });

  test("path outside project is ignored", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    seedIndex(root);
    const before = JSON.stringify(loadIndex(path.join(root, ".crank")).files);
    runHook(HOOK, JSON.stringify(claudePostWrite(root, "/etc/hosts")));
    expect(JSON.stringify(loadIndex(path.join(root, ".crank")).files)).toBe(before);
  });

  test("unrelated tool: exit 0, no change", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    seedIndex(root);
    const payload = { ...(claudePostWrite(root, path.join(root, "a.ts")) as object), tool_name: "Bash", tool_input: { command: "ls" } };
    const run = runHook(HOOK, JSON.stringify(payload));
    expect(run.status).toBe(0);
  });

  test("garbage stdin: exit 0", () => {
    expect(runHook(HOOK, "]]garbage").status).toBe(0);
  });

  test("empty stdin: exit 0", () => {
    expect(runHook(HOOK, "").status).toBe(0);
  });
});

describe("post-write cerebrum nudge (Codex only)", () => {
  const STALE = 1000; // epoch before the files existed → every file is "changed"
  const FRESH = Date.now() + 1_000_000_000;
  const THREE = { "a.ts": "const a = 1;", "b.ts": "const b = 2;", "c.ts": "const c = 3;" };
  const setMtime = (p: string, ms: number) => fs.utimesSync(p, new Date(ms), new Date(ms));
  const cerebrum = (root: string) => path.join(root, ".crank/cerebrum.md");
  const nudge = (stdout: string): string | undefined => {
    try {
      return JSON.parse(stdout)?.hookSpecificOutput?.additionalContext;
    } catch {
      return undefined;
    }
  };
  const UPDATE_A = "*** Begin Patch\n*** Update File: a.ts\n+x\n*** End Patch";

  test("apply_patch nudges when files changed since cerebrum was updated", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);
    const run = runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A)));
    expect(run.status).toBe(0);
    const ctx = nudge(run.stdout);
    expect(ctx).toContain("crank-mem");
    expect(ctx).toContain("cerebrum");
  });

  test("Claude Edit never nudges here (Stop hook owns Claude's nudge)", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), STALE); // stale, but still silent for Claude
    const run = runHook(HOOK, JSON.stringify(claudePostEdit(root, path.join(root, "a.ts"))));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("apply_patch stays silent when cerebrum is fresher than every file", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    const run = runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("apply_patch debounces: a second write with no new changes is silent", () => {
    const root = makeCrankProject(THREE);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);
    expect(nudge(runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A))).stdout)).toContain("crank-mem");
    const second = runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A)));
    expect(second.status).toBe(0);
    expect(second.stdout).toBe("");
  });
});

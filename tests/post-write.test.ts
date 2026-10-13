import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { git, gitCommit, makeCrankProject, runHook } from "./helpers.ts";
import { claudePostWrite, claudePostEdit, codexApplyPatch, claudeSessionStart } from "./fixtures/payloads.ts";
import { parseApplyPatch } from "../src/hooks/lib/apply-patch.ts";
import { loadIndex } from "../src/hooks/lib/store.ts";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";
import { NUDGE_STEP } from "../src/hooks/lib/cerebrum-nudge.ts";

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
  });

  test("a written file past max_files stays indexed at the next session start", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;", "b.ts": "const b = 1;" });
    saveConfig(path.join(root, ".crank"), { ...defaultConfig(), max_files: 2 });
    seedIndex(root);
    fs.writeFileSync(path.join(root, "z.ts"), "/** Zed. */\n");
    expect(runHook(HOOK, JSON.stringify(claudePostWrite(root, path.join(root, "z.ts")))).status).toBe(0);
    runHook(HOOK, JSON.stringify(claudePostEdit(root, path.join(root, "z.ts"))));
    expect(loadIndex(path.join(root, ".crank")).files["z.ts"]!.writeCount).toBe(2);
    seedIndex(root);
    const index = loadIndex(path.join(root, ".crank"));
    expect(Object.keys(index.files).sort()).toEqual(["a.ts", "z.ts"]);
    expect(fs.readFileSync(path.join(root, ".crank/anatomy.md"), "utf-8")).toContain("## Most active files\n\n- `z.ts` — Zed.");
  });

  test("a write pin clears once the file is in the churn list", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    git(root, "init", "-q");
    seedIndex(root);
    fs.writeFileSync(path.join(root, "z.ts"), "export const z = 1;\n");
    runHook(HOOK, JSON.stringify(claudePostWrite(root, path.join(root, "z.ts"))));
    expect(loadIndex(path.join(root, ".crank")).files["z.ts"]!.writeCount).toBe(1);
    gitCommit(root, "z");
    seedIndex(root);
    const index = loadIndex(path.join(root, ".crank"));
    expect(index.meta.churn!.paths).toContain("z.ts");
    expect(index.files["z.ts"]!.writeCount).toBeUndefined();
    // Later writes to a churned file add no pin either.
    runHook(HOOK, JSON.stringify(claudePostEdit(root, path.join(root, "z.ts"))));
    expect(loadIndex(path.join(root, ".crank")).files["z.ts"]!.writeCount).toBeUndefined();
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

  test("overwriting an indexed file past the size cap drops its entry", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;", "grows.ts": "const g = 1;" });
    seedIndex(root);
    const crankDir = path.join(root, ".crank");
    const before = loadIndex(crankDir);
    expect(before.files["grows.ts"]).toBeDefined();

    fs.writeFileSync(path.join(root, "grows.ts"), "x".repeat(1024 * 1024 + 1));
    const run = runHook(HOOK, JSON.stringify(claudePostWrite(root, path.join(root, "grows.ts"))));
    expect(run.status).toBe(0);
    const after = loadIndex(crankDir);
    expect(after.files["grows.ts"]).toBeUndefined();
    expect(after.meta.fileCount).toBe(before.meta.fileCount - 1);
  });

  test("binary content under an unlisted extension is skipped", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    seedIndex(root);
    fs.writeFileSync(path.join(root, "model.weights"), Buffer.from([0x93, 0x4e, 0x55, 0x00, 0x01]));
    const run = runHook(HOOK, JSON.stringify(claudePostWrite(root, path.join(root, "model.weights"))));
    expect(run.status).toBe(0);
    expect(loadIndex(path.join(root, ".crank")).files["model.weights"]).toBeUndefined();
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
  // NUDGE_STEP files, so a stale cerebrum is over the threshold. a.ts is the
  // one UPDATE_A patches.
  const ENOUGH = {
    "a.ts": "const a = 1;",
    ...Object.fromEntries(
      Array.from({ length: NUDGE_STEP - 1 }, (_, i) => [`f${i}.ts`, `const x${i} = 1;`])
    ),
  };
  const setMtime = (p: string, ms: number) => fs.utimesSync(p, new Date(ms), new Date(ms));
  const cerebrum = (root: string) => path.join(root, ".crank/cerebrum.md");
  const nudge = (stdout: string): string | undefined =>
    stdout ? JSON.parse(stdout).hookSpecificOutput.additionalContext : undefined;
  const UPDATE_A = "*** Begin Patch\n*** Update File: a.ts\n+x\n*** End Patch";

  test("apply_patch nudges when files changed since cerebrum was updated", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);
    const run = runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A)));
    expect(run.status).toBe(0);
    const ctx = nudge(run.stdout);
    expect(ctx).toContain("crank-mem");
    expect(ctx).toContain("cerebrum");
  });

  test("Claude Edit never nudges here (Stop hook owns Claude's nudge)", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), STALE); // stale, but still silent for Claude
    const run = runHook(HOOK, JSON.stringify(claudePostEdit(root, path.join(root, "a.ts"))));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("apply_patch stays silent when cerebrum is fresher than every file", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), FRESH);
    const run = runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("apply_patch debounces: a second write with no new changes is silent", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);
    expect(nudge(runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A))).stdout)).toContain("crank-mem");
    const second = runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A)));
    expect(second.status).toBe(0);
    expect(second.stdout).toBe("");
  });

  // A nudge that fires while cerebrum is under both limits must not stamp a
  // prune floor: a later regrowth with fewer tokens would read as a prune.
  test("a record nudge under the limits leaves no prune floor behind", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    const lines = (n: number, pad: string) =>
      Array.from({ length: n }, (_, i) => `- entry ${i} ${pad}`).join("\n");
    fs.writeFileSync(cerebrum(root), lines(103, "x".repeat(60))); // ~1850 tokens
    setMtime(cerebrum(root), STALE);
    const record = nudge(runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A))).stdout);
    expect(record).toContain("file(s) have changed");
    expect(record).not.toContain("Prune");

    // Regrowth past the line limit with fewer tokens than at the record nudge.
    fs.writeFileSync(cerebrum(root), lines(157, ""));
    setMtime(cerebrum(root), FRESH);
    const regrown = runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A)));
    expect(regrown.status).toBe(0);
    expect(nudge(regrown.stdout)).toContain("157 lines");
  });

  test("apply_patch prune nudge backs cerebrum up and names the copy", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    const body = Array.from({ length: 160 }, (_, i) => `- entry ${i}`).join("\n");
    fs.writeFileSync(cerebrum(root), body);
    setMtime(cerebrum(root), FRESH);
    const ctx = nudge(runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A))).stdout);
    const dir = path.join(root, ".crank/backups/cerebrum");
    const [copy] = fs.readdirSync(dir);
    expect(fs.readFileSync(path.join(dir, copy!), "utf-8")).toBe(body);
    expect(ctx).toContain(`.crank/backups/cerebrum/${copy}`);
    expect(ctx).toContain(".crank/cerebrum-archive.md");
    // Codex reads AGENTS.md, not CLAUDE.md.
    expect(ctx).toContain("delete only what AGENTS.md or the code already states");
    expect(ctx).not.toContain("CLAUDE.md");
  });

  test("apply_patch prune nudge exits 0 when backups cannot be written", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    fs.writeFileSync(path.join(root, ".crank/backups"), "not a directory");
    fs.writeFileSync(cerebrum(root), Array.from({ length: 160 }, (_, i) => `- entry ${i}`).join("\n"));
    setMtime(cerebrum(root), FRESH);
    const run = runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A)));
    expect(run.status).toBe(0);
    expect(nudge(run.stdout)).toContain("160 lines");
    expect(nudge(run.stdout)).not.toContain("A copy of the current file");
  });

  // Codex reads skills from .agents/skills/ and invokes them with `$`.
  test("apply_patch nudge suggests the audit when the skill is in .agents/skills", () => {
    const root = makeCrankProject(ENOUGH);
    seedIndex(root);
    setMtime(cerebrum(root), STALE);
    fs.mkdirSync(path.join(root, ".claude/skills/crank-mem-audit"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude/skills/crank-mem-audit/SKILL.md"), "");
    expect(nudge(runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A))).stdout)).not.toContain("crank-mem-audit");

    fs.mkdirSync(path.join(root, ".agents/skills/crank-mem-audit"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agents/skills/crank-mem-audit/SKILL.md"), "");
    setMtime(cerebrum(root), STALE - 1); // a new cerebrum version re-arms the record part
    const ctx = nudge(runHook(HOOK, JSON.stringify(codexApplyPatch(root, UPDATE_A))).stdout);
    expect(ctx).toContain("Suggest the user run the crank-mem-audit skill (`$crank-mem-audit`)");
  });

  // Codex appends to cerebrum with a patch that touches nothing else, and that
  // patch takes the early return for .crank/-only writes.
  const CEREBRUM_PATCH = "*** Begin Patch\n*** Update File: .crank/cerebrum.md\n+x\n*** End Patch";
  const OLD = "- Fresh build dir fails: `OpenGL.framework` hits `-Werror=unguarded-availability-new` (2026-09-27).";
  const NEW = "- GUI compile fails: OpenGL.framework, -Werror=unguarded-availability-new; use CMAKE_PROJECT_INCLUDE.";
  const memory = (...bullets: string[]) => ["# Cerebrum", "", "## Memory", ...bullets].join("\n");

  test("a cerebrum-only apply_patch flags an overlapping new bullet after a silent seed", () => {
    const root = makeCrankProject();
    fs.writeFileSync(cerebrum(root), memory(OLD));
    setMtime(cerebrum(root), FRESH);
    const seed = runHook(HOOK, JSON.stringify(codexApplyPatch(root, CEREBRUM_PATCH)));
    expect(seed.status).toBe(0);
    expect(seed.stdout).toBe("");

    fs.writeFileSync(cerebrum(root), memory(OLD, NEW));
    setMtime(cerebrum(root), FRESH + 5000);
    const run = runHook(HOOK, JSON.stringify(codexApplyPatch(root, CEREBRUM_PATCH)));
    expect(run.status).toBe(0);
    expect(nudge(run.stdout)).toContain("bullet at line 5 overlaps line 4");
  });

  test("Claude writes to cerebrum never run the overlap check here", () => {
    const root = makeCrankProject();
    for (const [text, ms] of [[memory(OLD), FRESH], [memory(OLD, NEW), FRESH + 5000]] as const) {
      fs.writeFileSync(cerebrum(root), text);
      setMtime(cerebrum(root), ms);
      const run = runHook(HOOK, JSON.stringify(claudePostEdit(root, cerebrum(root))));
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("");
    }
    expect(fs.existsSync(path.join(root, ".crank/cerebrum-dedup.json"))).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  REPO_ROOT,
  enableDebugConfig,
  fakeCloneRoot,
  git,
  gitCommit,
  killDaemon,
  makeCrankHome,
  makeCrankProject,
  readDaemon,
  readDebugLog,
  runCli,
  runHook,
  stopDigests,
  withReadOnlyCodeDb,
} from "./helpers.ts";
import {
  claudePostWrite,
  claudePostEdit,
  codexApplyPatch,
  claudeSessionStart,
} from "./fixtures/payloads.ts";
import { parseApplyPatch } from "../src/hooks/lib/apply-patch.ts";
import { openCodeDb } from "../src/hooks/lib/code-db.ts";
import { defaultConfig, saveConfig } from "../src/hooks/lib/config.ts";

const HOOK = "src/hooks/post-write.ts";

function seedIndex(root: string): void {
  // Run session-start once to build the initial file facts in code.db.
  runHook("src/hooks/session-start.ts", JSON.stringify(claudeSessionStart(root)));
}

interface FileRow {
  description: string;
  write_count: number;
  churn_rank: number | null;
}

/** The project's code.db `files` rows by path, as the hooks left them. */
function graphFiles(root: string): Record<string, FileRow> {
  const opened = openCodeDb(root, "read");
  expect(opened.status).toBe("open");
  try {
    const rows = opened
      .db!.prepare("SELECT path, description, write_count, churn_rank FROM files")
      .all() as unknown as (FileRow & { path: string })[];
    return Object.fromEntries(rows.map((row) => [row.path, row]));
  } finally {
    opened.db!.close();
  }
}

/** The repo imports code.db holds for `rel`, in source order. */
function graphImports(root: string, rel: string): string[] {
  const opened = openCodeDb(root, "read");
  expect(opened.status).toBe("open");
  try {
    const rows = opened
      .db!.prepare("SELECT to_path FROM imports WHERE from_path = ? ORDER BY rowid")
      .all(rel) as { to_path: string }[];
    return rows.map((row) => row.to_path);
  } finally {
    opened.db!.close();
  }
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
    expect(graphFiles(root)["src/new.ts"]!.description).toBe("Brand new module.");
  });

  test("each write to a file counts once, and a session start keeps the count", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;", "b.ts": "const b = 1;" });
    seedIndex(root);
    fs.writeFileSync(path.join(root, "z.ts"), "/** Zed. */\n");
    expect(
      runHook(HOOK, JSON.stringify(claudePostWrite(root, path.join(root, "z.ts")))).status,
    ).toBe(0);
    runHook(HOOK, JSON.stringify(claudePostEdit(root, path.join(root, "z.ts"))));
    expect(graphFiles(root)["z.ts"]!.write_count).toBe(2);
    seedIndex(root);
    expect(Object.keys(graphFiles(root)).sort()).toEqual(["a.ts", "b.ts", "z.ts"]);
    expect(graphFiles(root)["z.ts"]!.write_count).toBe(2);
  });

  test("a write pin clears once the file is in the churn list", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    git(root, "init", "-q");
    seedIndex(root);
    fs.writeFileSync(path.join(root, "z.ts"), "export const z = 1;\n");
    runHook(HOOK, JSON.stringify(claudePostWrite(root, path.join(root, "z.ts"))));
    expect(graphFiles(root)["z.ts"]!.write_count).toBe(1);
    gitCommit(root, "z");
    seedIndex(root);
    expect(graphFiles(root)["z.ts"]).toMatchObject({ write_count: 0 });
    expect(graphFiles(root)["z.ts"]!.churn_rank).not.toBeNull();
    // Later writes to a churned file add no pin either.
    runHook(HOOK, JSON.stringify(claudePostEdit(root, path.join(root, "z.ts"))));
    expect(graphFiles(root)["z.ts"]!.write_count).toBe(0);
  });

  test("Claude Edit: existing file re-indexed", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    seedIndex(root);
    fs.writeFileSync(path.join(root, "a.ts"), "/** Updated alpha. */\nconst a = 2;\n");
    const run = runHook(HOOK, JSON.stringify(claudePostEdit(root, path.join(root, "a.ts"))));
    expect(run.status).toBe(0);
    expect(graphFiles(root)["a.ts"]!.description).toBe("Updated alpha.");
  });

  test("Codex apply_patch: Add and Update re-indexed, Delete dropped", () => {
    const root = makeCrankProject({ "keep.ts": "const k = 1;", "gone.ts": "const g = 1;" });
    seedIndex(root);
    expect(graphFiles(root)["gone.ts"]).toBeDefined();

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
      "*** Update File: .crank/cerebrum.md",
      "+x",
      "*** End Patch",
    ].join("\n");
    const run = runHook(HOOK, JSON.stringify(codexApplyPatch(root, patch)));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    const files = graphFiles(root);
    expect(files["added.ts"]!.description).toBe("Added by codex.");
    expect(files["keep.ts"]!.description).toBe("Keep updated.");
    expect(files["gone.ts"]).toBeUndefined();
  });

  test("a write leaves the file to the next parse, which refreshes its imports, from Claude and from Codex apply_patch", () => {
    const root = makeCrankProject({
      "src/a.ts": 'import "./b";\n',
      "src/b.ts": "export const b = 1;\n",
      "src/c.ts": "export const c = 1;\n",
    });
    expect(runCli(root, ["scan"]).status).toBe(0);
    const imports = () => graphImports(root, "src/a.ts");
    expect(imports()).toEqual(["src/b.ts"]);

    fs.writeFileSync(path.join(root, "src/a.ts"), 'import "./c";\n');
    const claude = runHook(
      HOOK,
      JSON.stringify(claudePostWrite(root, path.join(root, "src/a.ts"))),
    );
    expect(claude.status).toBe(0);
    expect(claude.stdout).toBe("");
    expect(imports()).toEqual(["src/b.ts"]);
    expect(runCli(root, ["scan"]).status).toBe(0);
    expect(imports()).toEqual(["src/c.ts"]);

    fs.writeFileSync(path.join(root, "src/a.ts"), 'import "./b";\n');
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      '-import "./c";',
      '+import "./b";',
      "*** End Patch",
    ].join("\n");
    const codex = runHook(HOOK, JSON.stringify(codexApplyPatch(root, patch)));
    expect(codex.status).toBe(0);
    expect(codex.stdout).toBe("");
    expect(imports()).toEqual(["src/c.ts"]);
    expect(runCli(root, ["scan"]).status).toBe(0);
    expect(imports()).toEqual(["src/b.ts"]);
  });

  test("relative apply_patch path resolves against session cwd, not project root", () => {
    const root = makeCrankProject({ "sub/dir/a.ts": "const a = 1;" });
    seedIndex(root);
    fs.writeFileSync(
      path.join(root, "sub/dir/fresh.ts"),
      "/** Fresh in subdir. */\nexport const f = 1;\n",
    );
    const payload = {
      ...(codexApplyPatch(
        root,
        "*** Begin Patch\n*** Add File: fresh.ts\n+x\n*** End Patch",
      ) as object),
      cwd: path.join(root, "sub/dir"),
    };
    const run = runHook(HOOK, JSON.stringify(payload));
    expect(run.status).toBe(0);
    expect(graphFiles(root)["sub/dir/fresh.ts"]!.description).toBe("Fresh in subdir.");
  });

  test("overwriting an indexed file past the size cap drops its entry", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;", "grows.ts": "const g = 1;" });
    seedIndex(root);
    const before = graphFiles(root);
    expect(before["grows.ts"]).toBeDefined();

    fs.writeFileSync(path.join(root, "grows.ts"), "x".repeat(1024 * 1024 + 1));
    const run = runHook(HOOK, JSON.stringify(claudePostWrite(root, path.join(root, "grows.ts"))));
    expect(run.status).toBe(0);
    const after = graphFiles(root);
    expect(after["grows.ts"]).toBeUndefined();
    expect(Object.keys(after)).toHaveLength(Object.keys(before).length - 1);

    // A new file past the cap is never indexed.
    fs.writeFileSync(path.join(root, "huge.ts"), "x".repeat(1024 * 1024 + 1));
    runHook(HOOK, JSON.stringify(claudePostWrite(root, path.join(root, "huge.ts"))));
    expect(graphFiles(root)["huge.ts"]).toBeUndefined();
  });

  test("binary content under an unlisted extension is skipped", () => {
    const root = makeCrankProject({ "a.ts": "const a = 1;" });
    seedIndex(root);
    fs.writeFileSync(path.join(root, "model.weights"), Buffer.from([0x93, 0x4e, 0x55, 0x00, 0x01]));
    const run = runHook(
      HOOK,
      JSON.stringify(claudePostWrite(root, path.join(root, "model.weights"))),
    );
    expect(run.status).toBe(0);
    expect(graphFiles(root)["model.weights"]).toBeUndefined();
  });

  test("garbage stdin: exit 0", () => {
    expect(runHook(HOOK, "]]garbage").status).toBe(0);
  });

  test("empty stdin: exit 0", () => {
    expect(runHook(HOOK, "").status).toBe(0);
  });
});

describe("post-write writes code.db", () => {
  const write = (root: string, rel: string, content: string, env: Record<string, string> = {}) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
    return runHook(
      HOOK,
      JSON.stringify(claudePostWrite(root, path.join(root, rel))),
      undefined,
      env,
    );
  };
  const anatomy = (root: string) => withReadOnlyCodeDb(root, () => runCli(root, ["anatomy"]));
  const listed = (stdout: string) => [...stdout.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!);

  test("a file written three times tops Most active files, and a deleted caller leaves the graph", () => {
    const root = makeCrankProject({
      "src/a.ts": "export const a = 1;\n",
      "src/lib.ts": "export function target() {\n  return 1;\n}\n",
      "src/caller.ts":
        'import { target } from "./lib";\nexport function run() {\n  return target();\n}\n',
    });
    seedIndex(root);
    for (let n = 1; n <= 3; n++) {
      expect(write(root, "src/new.ts", `export const n = ${n};\n`).status).toBe(0);
    }
    // A read-only store makes `anatomy` answer without refreshing, so what it lists was written by the hook.
    const active = anatomy(root);
    expect(active.status).toBe(0);
    expect(active.stdout.startsWith("## Most active files\n\n- `src/new.ts`")).toBe(true);
    expect(listed(active.stdout).slice(0, 2)).toEqual(["src/new.ts", "src/a.ts"]);

    // `callers` parses every file, so caller.ts has a call site in the graph before it is deleted.
    expect(runCli(root, ["callers", "target"]).stdout).toContain("src/caller.ts");
    fs.rmSync(path.join(root, "src/caller.ts"));
    const patch = [
      "*** Begin Patch",
      `*** Delete File: ${path.join(root, "src/caller.ts")}`,
      "*** End Patch",
    ].join("\n");
    expect(runHook(HOOK, JSON.stringify(codexApplyPatch(root, patch))).status).toBe(0);
    withReadOnlyCodeDb(root, () => {
      expect(listed(runCli(root, ["anatomy"]).stdout)).not.toContain("src/caller.ts");
      expect(runCli(root, ["callers", "target"]).stdout).not.toContain("caller.ts");
    });
  });

  test("a code.db at another schema version is left byte-identical", () => {
    const root = makeCrankProject({ "a.ts": "export const a = 1;\n" });
    enableDebugConfig(root);
    const file = path.join(root, ".crank/code.db");
    const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE files (x); PRAGMA user_version = 99");
    db.close();
    const before = fs.readFileSync(file);
    expect(write(root, "b.ts", "export const b = 1;\n").status).toBe(0);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    const graph = readDebugLog(root)
      .flatMap((r) => r.events as Array<Record<string, unknown>>)
      .filter((e) => String(e.event).startsWith("graph"));
    expect(graph).toEqual([{ event: "graph-skip", root: null, status: "rebuild" }]);
  });

  test("a parseable write starts the daemon unless a stop state is set", async () => {
    const root = makeCrankProject({ "a.ts": "export const a = 1;\n" });
    saveConfig(path.join(root, ".crank"), { ...defaultConfig(), clone_root: REPO_ROOT });
    // Each run has its own crank home: a daemon the first started would satisfy the second's ensureDaemon.
    const started = makeCrankHome();
    try {
      expect(write(root, "b.ts", "export const b = 1;\n", { CRANK_HOME: started }).status).toBe(0);
      let alive = false;
      for (let waited = 0; !alive && waited < 5000; waited += 100) {
        alive = typeof readDaemon(started)?.heartbeatMs === "number";
        if (!alive) await Bun.sleep(100);
      }
      expect(alive).toBe(true);
    } finally {
      killDaemon(started);
    }

    // A daemon that starts under a stop state exits without a trace, so a recording clone_root stands in.
    const fake = fakeCloneRoot();
    saveConfig(path.join(root, ".crank"), { ...defaultConfig(), clone_root: fake.root });
    const stopped = makeCrankHome();
    stopDigests(stopped);
    expect(write(root, "c.ts", "export const c = 1;\n", { CRANK_HOME: stopped }).status).toBe(0);
    await Bun.sleep(1500);
    expect(fake.starts()).toBe(0);
    expect(readDaemon(stopped)).toBeNull();
  });
});

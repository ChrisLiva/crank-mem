import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { memoryPaths } from "../src/hooks/lib/hook-io.ts";
import { git, gitCommit, plantMemory, runCli, seedMemory } from "./helpers.ts";
import { MEMORY_NEWER_NOTE, MEMORY_UNREADABLE_NOTE } from "../src/hooks/lib/memory.ts";
import { NO_MEMORY_NOTE } from "../src/cli/recall.ts";

describe("memoryPaths", () => {
  test("keeps repo-relative, non-sensitive paths inside the root, deduped in input order", () => {
    expect(memoryPaths("/r", "/r/src", ["a.ts", "/r/src/a.ts", "/elsewhere/x.ts", ".env", "/r"])).toEqual(["src/a.ts"]);
    expect(memoryPaths("/r", "/r", [])).toEqual([]);
  });
});

function initedProject(files: Record<string, string> = { "a.ts": "export const a = 1;\n" }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crank-recall-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  expect(runCli(root, ["init", "--yes", "--codex", "skip"]).status).toBe(0);
  return root;
}

describe("search", () => {
  test("prints one formatLine per hit and finds a row by an exact identifier", () => {
    const root = initedProject();
    seedMemory(root, [{ type: "bugfix", title: "Lock file writes retry on EEXIST" }, { title: "Unrelated note" }]);
    const run = runCli(root, ["search", "EEXIST"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^#1 \d{4}-\d{2}-\d{2} bugfix Lock file writes retry on EEXIST\n$/);
  });

  test("each hit is dated in the local zone", () => {
    const root = initedProject();
    seedMemory(root, [{ title: "Gizmo today" }]);
    for (const TZ of ZONES) {
      expect(runCli(root, ["search", "gizmo"], { TZ }).stdout).toBe(`#1 ${localDate(0, TZ)} discovery Gizmo today\n`);
    }
  });

  test("zero hits print nothing and exit 0", () => {
    const root = initedProject();
    seedMemory(root, [{ title: "Lock file writes retry" }]);
    const run = runCli(root, ["search", "zebra"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });
});

describe("store placement", () => {
  test("a commit-mode linked worktree reads its main checkout's store, from a subdirectory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crank-recall-git-"));
    const root = path.join(tmp, "main");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
    git(root, "init", "-q");
    expect(runCli(root, ["init", "--git", "commit", "--yes", "--codex", "skip"]).status).toBe(0);
    gitCommit(root, "init");
    const worktree = path.join(tmp, "wt");
    git(root, "worktree", "add", "-q", worktree);
    seedMemory(root, [{ title: "Worktrees share the main store" }]);
    const run = runCli(path.join(worktree, "src"), ["search", "worktrees"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^#1 \S+ discovery Worktrees share the main store\n$/);
  });

  test("a project outside git keeps its store at .crank/memory.db", () => {
    const root = initedProject();
    seedMemory(root, [{ title: "Plain projects own their store" }]);
    expect(fs.existsSync(path.join(root, ".crank/memory.db"))).toBe(true);
    expect(runCli(root, ["search", "plain"]).stdout).toMatch(/^#1 \S+ discovery Plain projects own their store\n$/);
  });
});

// bun test runs this process in UTC, so each CLI child gets a pinned zone and dates are computed in it.
// Zones on both sides of UTC make a UTC-midnight reading fail at any hour in one of them.
const ZONES = ["Pacific/Kiritimati", "Pacific/Pago_Pago"];

function localDate(offsetDays: number, timeZone: string): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone });
}

const SEARCH_USAGE = "Usage: crank-mem search <query> [--limit n] [--type t] [--since YYYY-MM-DD] [--file path]";

describe("search flags", () => {
  test("--limit defaults to 10 and clamps at 50", () => {
    const root = initedProject();
    seedMemory(root, Array.from({ length: 60 }, (_, i) => ({ title: `Widget note ${i}` })));
    const lines = (run: { stdout: string }) => run.stdout.split("\n").filter(Boolean).length;
    expect(lines(runCli(root, ["search", "widget"]))).toBe(10);
    expect(lines(runCli(root, ["search", "widget", "--limit", "99"]))).toBe(50);
    expect(lines(runCli(root, ["search", "widget", "--limit", "3"]))).toBe(3);
  });

  test("--file resolves against the shell's directory", () => {
    const root = initedProject({ "src/a.ts": "export const a = 1;\n" });
    seedMemory(root, [{ title: "Gadget lives in src", filesModified: ["src/a.ts"] }]);
    const src = path.join(root, "src");
    expect(runCli(src, ["search", "gadget", "--file", "src/a.ts"]).stdout).toBe("");
    expect(runCli(src, ["search", "gadget", "--file", "a.ts"]).stdout).toMatch(/Gadget lives in src\n$/);
    const outside = runCli(src, ["search", "gadget", "--file", "/elsewhere/a.ts"]);
    expect(outside.status).toBe(0);
    expect(outside.stdout).toBe("");
  });

  test("--type keeps only that type", () => {
    const root = initedProject();
    seedMemory(root, [{ type: "decision", title: "Sprocket decision" }, { type: "bugfix", title: "Sprocket bugfix" }]);
    const run = runCli(root, ["search", "sprocket", "--type", "decision"]);
    expect(run.stdout).toMatch(/^#\d+ \S+ decision Sprocket decision\n$/);
  });

  test("--since is local midnight", () => {
    const root = initedProject();
    seedMemory(root, [{ title: "Gizmo today" }]);
    for (const TZ of ZONES) {
      expect(runCli(root, ["search", "gizmo", "--since", localDate(1, TZ)], { TZ }).stdout).toBe("");
      expect(runCli(root, ["search", "gizmo", "--since", localDate(0, TZ)], { TZ }).stdout).toMatch(/Gizmo today\n$/);
    }
  });

  test("a malformed flag value or an empty query prints usage and exits 1", () => {
    const root = initedProject();
    seedMemory(root, [{ title: "Gizmo" }]);
    for (const args of [
      ["search"],
      ["search", "gizmo", "--limit"],
      ["search", "gizmo", "--limit", "0"],
      ["search", "gizmo", "--limit", "-1"],
      ["search", "gizmo", "--limit", "abc"],
      ["search", "gizmo", "--type", "idea"],
      ["search", "gizmo", "--since", "yesterday"],
      ["search", "gizmo", "--since", "2026-13-45"],
      ["search", "gizmo", "--since", "2026-02-31"],
      ["search", "gizmo", "--file"],
    ]) {
      const run = runCli(root, args);
      expect(run.status, args.join(" ")).toBe(1);
      expect(run.stderr).toContain(SEARCH_USAGE);
      expect(run.stdout).toBe("");
    }
  });
});

describe("search query text", () => {
  test("an unknown flag key is searched as text", () => {
    const root = initedProject();
    seedMemory(root, [{ title: "Digest runs pass max turns 2" }, { title: "Other note" }]);
    const run = runCli(root, ["search", "--max-turns"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^#1 \S+ discovery Digest runs pass max turns 2\n$/);
  });

  test("FTS syntax in the query raises no error", () => {
    const root = initedProject();
    seedMemory(root, [{ title: "Plain note" }]);
    for (const q of ['"', "*", "-", "AND", "NEAR("]) {
      const run = runCli(root, ["search", q]);
      expect(run.status, q).toBe(0);
      expect(run.stderr).toBe("crank-mem: keyword search only; run `crank-mem setup` for search by meaning.\n");
    }
    expect(runCli(root, ["search", '"']).stdout).toBe("");
  });
});

describe("store states", () => {
  const COMMANDS = [["search", "anything"], ["timeline", "1"], ["get", "1"]];

  test("no store: search prints the note on stdout and exits 0; timeline and get print it on stderr and exit 1", () => {
    const root = initedProject();
    const searched = runCli(root, COMMANDS[0]!);
    expect(searched).toMatchObject({ status: 0, stdout: `${NO_MEMORY_NOTE}\n`, stderr: "" });
    for (const args of COMMANDS.slice(1)) {
      expect(runCli(root, args), args[0]).toMatchObject({ status: 1, stdout: "", stderr: `${NO_MEMORY_NOTE}\n` });
    }
  });

  for (const [state, note] of [["newer", MEMORY_NEWER_NOTE], ["unreadable", MEMORY_UNREADABLE_NOTE]] as const) {
    test(`a ${state} store: every command prints its note on stderr and exits 1`, () => {
      const root = initedProject();
      plantMemory(root, state);
      for (const args of COMMANDS) {
        expect(runCli(root, args), args[0]).toMatchObject({ status: 1, stdout: "", stderr: `${note}\n` });
      }
    });
  }
});

const ids = (stdout: string) => stdout.split("\n").filter(Boolean).map((line) => Number(/^#(\d+) /.exec(line)![1]));

describe("timeline", () => {
  test("prints 5 either side of the id, oldest first, and --depth changes the span", () => {
    const root = initedProject();
    seedMemory(root, Array.from({ length: 12 }, () => ({})));
    const run = runCli(root, ["timeline", "6"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^#1 \d{4}-\d{2}-\d{2} discovery Observation 0\n/);
    expect(ids(run.stdout)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(ids(runCli(root, ["timeline", "6", "--depth", "1"]).stdout)).toEqual([5, 6, 7]);
  });

  test("an unknown id exits 1 and names it", () => {
    const root = initedProject();
    seedMemory(root, [{}]);
    expect(runCli(root, ["timeline", "99"])).toMatchObject({ status: 1, stdout: "", stderr: "crank-mem: no observation #99.\n" });
  });

  test("a non-numeric id or depth prints usage and exits 1", () => {
    const root = initedProject();
    seedMemory(root, [{}]);
    for (const args of [["timeline"], ["timeline", "abc"], ["timeline", "1", "--depth", "x"], ["timeline", "1", "--depth"]]) {
      const run = runCli(root, args);
      expect(run.status, args.join(" ")).toBe(1);
      expect(run.stderr).toContain("Usage: crank-mem timeline <id> [--depth n]");
    }
  });
});

describe("get", () => {
  test("a row seeded with defaults prints (none) for empty facts and file lists", () => {
    const root = initedProject();
    seedMemory(root, [{}]);
    const run = runCli(root, ["get", "1"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(
      /^#1 \d{4}-\d{2}-\d{2} discovery Observation 0\nsession: seed-\d+\nnarrative: Narrative 0\nfacts: \(none\)\nfiles read: \(none\)\nfiles modified: \(none\)\n$/
    );
  });

  test("a row with values prints every field literally", () => {
    const root = initedProject();
    seedMemory(root, [{
      type: "decision", title: "Use WAL — für Läufer", narrative: "Readers never block the writer.",
      facts: ["WAL is per file", "busy timeout 200 ms"], filesRead: ["src/b.ts", "src/a.ts"], filesModified: ["src/c.ts"],
    }]);
    const run = runCli(root, ["get", "1"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(new RegExp(
      "^#1 \\d{4}-\\d{2}-\\d{2} decision Use WAL — für Läufer\nsession: seed-\\d+\nnarrative: Readers never block the writer\\.\n" +
      "facts:\n- WAL is per file\n- busy timeout 200 ms\nfiles read: src/a.ts, src/b.ts\nfiles modified: src/c.ts\n$"
    ));
  });

  test("prints the first 20 ids given, blocks separated by a blank line", () => {
    const root = initedProject();
    seedMemory(root, Array.from({ length: 25 }, () => ({})));
    const run = runCli(root, ["get", ...Array.from({ length: 25 }, (_, i) => String(i + 1))]);
    expect(run.status).toBe(0);
    const blocks = run.stdout.trimEnd().split("\n\n");
    expect(blocks.length).toBe(20);
    expect(blocks.map((b) => Number(/^#(\d+) /.exec(b)![1]))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test("exits 1 when no id is found, and prints usage for a non-numeric id", () => {
    const root = initedProject();
    seedMemory(root, [{}]);
    expect(runCli(root, ["get", "999"]).status).toBe(1);
    for (const args of [["get"], ["get", "abc"], ["get", "1", "abc"]]) {
      const run = runCli(root, args);
      expect(run.status, args.join(" ")).toBe(1);
      expect(run.stderr).toContain("Usage: crank-mem get <id...>");
    }
  });
});

describe("where the commands run", () => {
  const COMMANDS = [["search", "anchor"], ["timeline", "1"], ["get", "1"]];

  test("each command works from a project subdirectory", () => {
    const root = initedProject({ "src/a.ts": "export const a = 1;\n" });
    seedMemory(root, [{ title: "Anchor row" }]);
    for (const args of COMMANDS) {
      const run = runCli(path.join(root, "src"), args);
      expect(run.status, args[0]).toBe(0);
      expect(run.stdout).toMatch(/^#1 \S+ discovery Anchor row\n/);
    }
  });

  test("outside any project each command prints the init hint and exits 1", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "crank-recall-bare-"));
    for (const args of COMMANDS) {
      const run = runCli(bare, args);
      expect(run.status, args[0]).toBe(1);
      expect(run.stderr).toContain("not initialized here");
      expect(fs.existsSync(path.join(bare, ".crank"))).toBe(false);
    }
  });
});

describe("help", () => {
  test("--help lists search, timeline and get, and hides --model-host", () => {
    const run = runCli(os.tmpdir(), ["--help"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("  search     Search stored memory by meaning or keyword\n");
    expect(run.stdout).toContain("  timeline   Show the observations around one id\n");
    expect(run.stdout).toContain("  get        Print stored observations in full\n");
    expect(run.stdout).not.toContain("--model-host");
  });
});

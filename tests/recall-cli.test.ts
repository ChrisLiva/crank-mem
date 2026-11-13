import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { memoryPaths } from "../src/hooks/lib/hook-io.ts";
import {
  git,
  gitCommit,
  initedCopy,
  makeCrankProject,
  plantMemory,
  runCli,
  seedMemory,
  tempDir,
  ZONES,
} from "./helpers.ts";
import {
  MEMORY_NEWER_NOTE,
  MEMORY_UNREADABLE_NOTE,
  NO_MEMORY_NOTE,
} from "../src/hooks/lib/memory.ts";
import { COMMANDS as CLI_COMMANDS } from "../src/cli/commands.ts";

describe("memoryPaths", () => {
  test("keeps repo-relative, non-sensitive paths inside the root, deduped in input order", () => {
    const r = makeCrankProject({
      "src/a.ts": "export const a = 1;\n",
      "clones/u/y.ts": "export const y = 1;\n",
    });
    fs.mkdirSync(path.join(r, "clones/u/.git"));
    expect(
      memoryPaths(r, path.join(r, "src"), [
        "a.ts",
        path.join(r, "src/a.ts"),
        "/elsewhere/x.ts",
        ".env",
        r,
        path.join(r, "clones/u/y.ts"),
      ]),
    ).toEqual(["src/a.ts"]);
    expect(memoryPaths(r, r, [])).toEqual([]);
  });
});

describe("search", () => {
  test("each hit is dated in the local zone", () => {
    const root = initedCopy();
    seedMemory(root, [{ title: "Gizmo today" }]);
    for (const TZ of ZONES) {
      expect(runCli(root, ["search", "gizmo"], { TZ }).stdout).toBe(
        `#1 ${localDate(0, TZ)} discovery Gizmo today\n`,
      );
    }
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
});

describe("graph search", () => {
  test("a query naming a file surfaces observations linked to its import neighbour", () => {
    const root = initedCopy({
      "src/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
      "src/b.ts": "export const b = 1;\n",
    });
    const [o1] = seedMemory(root, [
      { title: "Lock budget raised", narrative: "budget", filesModified: ["src/b.ts"] },
    ]) as [number];
    const neighbourOnly = runCli(root, ["search", "src/a.ts"]);
    expect(neighbourOnly.status).toBe(0);
    expect(neighbourOnly.stdout).toMatch(
      new RegExp(`^#${o1} \\d{4}-\\d{2}-\\d{2} discovery Lock budget raised\\n$`),
    );

    const [o2] = seedMemory(root, [{ title: "Alpha src/a.ts notes", narrative: "plain" }]) as [
      number,
    ];
    const ids = (stdout: string) => [...stdout.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
    expect(ids(runCli(root, ["search", "src/a.ts"]).stdout)).toEqual([o2, o1]);

    fs.writeFileSync(path.join(root, ".crank", "anatomy-index.json"), "{not json");
    const corrupt = runCli(root, ["search", "src/a.ts"]);
    expect(corrupt.status).toBe(0);
    expect(ids(corrupt.stdout)).toEqual([o2]);
  });
});

function localDate(offsetDays: number, timeZone: string): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone });
}

const SEARCH_USAGE =
  "Usage: crank-mem search <query> [--limit n] [--type t] [--since YYYY-MM-DD] [--file path]";

describe("search flags", () => {
  test("--limit defaults to 10 and clamps at 50", () => {
    const root = initedCopy();
    seedMemory(
      root,
      Array.from({ length: 60 }, (_, i) => ({ title: `Widget note ${i}` })),
    );
    const lines = (run: { stdout: string }) => run.stdout.split("\n").filter(Boolean).length;
    expect(lines(runCli(root, ["search", "widget"]))).toBe(10);
    expect(lines(runCli(root, ["search", "widget", "--limit", "99"]))).toBe(50);
    expect(lines(runCli(root, ["search", "widget", "--limit", "3"]))).toBe(3);
  });

  test("--file resolves against the shell's directory", () => {
    const root = initedCopy({ "src/a.ts": "export const a = 1;\n" });
    seedMemory(root, [{ title: "Gadget lives in src", filesModified: ["src/a.ts"] }]);
    const src = path.join(root, "src");
    expect(runCli(src, ["search", "gadget", "--file", "src/a.ts"]).stdout).toBe("");
    expect(runCli(src, ["search", "gadget", "--file", "a.ts"]).stdout).toMatch(
      /Gadget lives in src\n$/,
    );
    const outside = runCli(src, ["search", "gadget", "--file", "/elsewhere/a.ts"]);
    expect(outside.status).toBe(0);
    expect(outside.stdout).toBe("");
  });

  test("--type keeps only that type", () => {
    const root = initedCopy();
    seedMemory(root, [
      { type: "decision", title: "Sprocket decision" },
      { type: "bugfix", title: "Sprocket bugfix" },
    ]);
    const run = runCli(root, ["search", "sprocket", "--type", "decision"]);
    expect(run.stdout).toMatch(/^#\d+ \S+ decision Sprocket decision\n$/);
  });

  test("--since is local midnight", () => {
    const root = initedCopy();
    seedMemory(root, [{ title: "Gizmo today" }]);
    for (const TZ of ZONES) {
      expect(runCli(root, ["search", "gizmo", "--since", localDate(1, TZ)], { TZ }).stdout).toBe(
        "",
      );
      expect(runCli(root, ["search", "gizmo", "--since", localDate(0, TZ)], { TZ }).stdout).toMatch(
        /Gizmo today\n$/,
      );
    }
  });

  test("a malformed flag value or an empty query prints usage and exits 1", () => {
    const root = initedCopy();
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

describe("stale rows", () => {
  const TZ = "America/New_York";

  /** Rows A and B, with A flagged stale. */
  function staleProject(files: Record<string, string> = { "a.ts": "export const a = 1;\n" }) {
    const root = initedCopy(files);
    const [a, b] = seedMemory(root, [
      { title: "Lock retry is two seconds", filesRead: ["a.ts"] },
      { title: "Lock files live in .crank", filesRead: ["a.ts"] },
    ]) as [number, number];
    seedMemory(root, [], { stale: [{ id: a, reason: "retry is 5 s now" }] });
    return {
      root,
      a,
      b,
      staleLine: `#${a} ${localDate(0, TZ)} discovery [stale] Lock retry is two seconds`,
    };
  }

  test("search hides a stale row unless --stale asks for it", () => {
    const { root, b, staleLine } = staleProject();
    const plain = runCli(root, ["search", "Lock"], { TZ });
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain(
      `#${b} ${localDate(0, TZ)} discovery Lock files live in .crank\n`,
    );
    expect(plain.stdout).not.toContain("Lock retry is two seconds");
    const all = runCli(root, ["search", "Lock", "--stale"], { TZ });
    expect(all.status).toBe(0);
    expect(all.stdout.split("\n")).toContain(staleLine);
    expect(all.stdout).toContain(`#${b} ${localDate(0, TZ)} discovery Lock files live in .crank\n`);
    expect(runCli(root, ["search", "--stale"], { TZ })).toMatchObject({
      status: 1,
      stdout: "",
      stderr: `${CLI_COMMANDS.search.usage}\n`,
    });
    expect(runCli(root, ["search", "--help"], { TZ }).stdout.split("\n")[0]).toBe(
      "Usage: crank-mem search <query> [--limit n] [--type t] [--since YYYY-MM-DD] [--file path] [--project name] [--stale]",
    );
  });

  test("timeline keeps a stale row and tags it", () => {
    const { root, a, staleLine } = staleProject();
    const run = runCli(root, ["timeline", String(a)], { TZ });
    expect(run.status).toBe(0);
    expect(run.stdout.split("\n")).toContain(staleLine);
  });

  test("get prints the flag's local date and reason after the session", () => {
    const { root, a } = staleProject();
    const run = runCli(root, ["get", String(a)], { TZ });
    expect(run.status).toBe(0);
    const lines = run.stdout.split("\n");
    expect(lines[1]).toMatch(/^session: seed-\d+$/);
    expect(lines[2]).toBe(`stale: ${localDate(0, TZ)} retry is 5 s now`);
  });
});

describe("search query text", () => {
  test("an unknown flag key is searched as text", () => {
    const root = initedCopy();
    seedMemory(root, [{ title: "Digest runs pass max turns 2" }, { title: "Other note" }]);
    const run = runCli(root, ["search", "--max-turns"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^#1 \S+ discovery Digest runs pass max turns 2\n$/);
  });

  test("FTS syntax in the query raises no error", () => {
    const root = initedCopy();
    seedMemory(root, [{ title: "Plain note" }]);
    for (const q of ['"', "*", "-", "AND", "NEAR("]) {
      const run = runCli(root, ["search", q]);
      expect(run.status, q).toBe(0);
      expect(run.stderr).toBe(
        "crank-mem: keyword search only; run `crank-mem setup` for search by meaning.\n",
      );
    }
    expect(runCli(root, ["search", '"']).stdout).toBe("");
  });
});

describe("store states", () => {
  const COMMANDS = [
    ["search", "anything"],
    ["timeline", "1"],
    ["get", "1"],
  ];

  test("no store: search prints the note on stdout and exits 0; timeline and get print it on stderr and exit 1", () => {
    const root = initedCopy();
    const searched = runCli(root, COMMANDS[0]!);
    expect(searched).toMatchObject({ status: 0, stdout: `${NO_MEMORY_NOTE}\n`, stderr: "" });
    for (const args of COMMANDS.slice(1)) {
      expect(runCli(root, args), args[0]).toMatchObject({
        status: 1,
        stdout: "",
        stderr: `${NO_MEMORY_NOTE}\n`,
      });
    }
  });

  for (const [state, note] of [
    ["newer", MEMORY_NEWER_NOTE],
    ["unreadable", MEMORY_UNREADABLE_NOTE],
  ] as const) {
    test(`a ${state} store: every command prints its note on stderr and exits 1`, () => {
      const root = initedCopy();
      plantMemory(root, state);
      for (const args of COMMANDS) {
        expect(runCli(root, args), args[0]).toMatchObject({
          status: 1,
          stdout: "",
          stderr: `${note}\n`,
        });
      }
    });
  }
});

const ids = (stdout: string) =>
  stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => Number(/^#(\d+) /.exec(line)![1]));

describe("timeline", () => {
  test("prints 5 either side of the id, oldest first, and --depth changes the span", () => {
    const root = initedCopy();
    seedMemory(
      root,
      Array.from({ length: 12 }, () => ({})),
    );
    const run = runCli(root, ["timeline", "6"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^#1 \d{4}-\d{2}-\d{2} discovery Observation 0\n/);
    expect(ids(run.stdout)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(ids(runCli(root, ["timeline", "6", "--depth", "1"]).stdout)).toEqual([5, 6, 7]);
  });

  test("an unknown id exits 1 and names it", () => {
    const root = initedCopy();
    seedMemory(root, [{}]);
    expect(runCli(root, ["timeline", "99"])).toMatchObject({
      status: 1,
      stdout: "",
      stderr: "crank-mem: no observation #99.\n",
    });
  });

  test("a non-numeric id or depth prints usage and exits 1", () => {
    const root = initedCopy();
    seedMemory(root, [{}]);
    for (const args of [
      ["timeline"],
      ["timeline", "abc"],
      ["timeline", "1", "--depth", "x"],
      ["timeline", "1", "--depth"],
    ]) {
      const run = runCli(root, args);
      expect(run.status, args.join(" ")).toBe(1);
      expect(run.stderr).toContain("Usage: crank-mem timeline <id> [--depth n]");
    }
  });
});

describe("get", () => {
  test("a row seeded with defaults prints (none) for empty facts and file lists", () => {
    const root = initedCopy();
    seedMemory(root, [{}]);
    const run = runCli(root, ["get", "1"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(
      /^#1 \d{4}-\d{2}-\d{2} discovery Observation 0\nsession: seed-\d+\nnarrative: Narrative 0\nfacts: \(none\)\nfiles read: \(none\)\nfiles modified: \(none\)\n$/,
    );
  });

  test("a row with values prints every field literally", () => {
    const root = initedCopy();
    seedMemory(root, [
      {
        type: "decision",
        title: "Use WAL — für Läufer",
        narrative: "Readers never block the writer.",
        facts: ["WAL is per file", "busy timeout 200 ms"],
        filesRead: ["src/b.ts", "src/a.ts"],
        filesModified: ["src/c.ts"],
      },
    ]);
    const run = runCli(root, ["get", "1"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(
      new RegExp(
        "^#1 \\d{4}-\\d{2}-\\d{2} decision Use WAL — für Läufer\nsession: seed-\\d+\nnarrative: Readers never block the writer\\.\n" +
          "facts:\n- WAL is per file\n- busy timeout 200 ms\nfiles read: src/a.ts, src/b.ts\nfiles modified: src/c.ts\n$",
      ),
    );
  });

  test("prints the first 20 ids given, blocks separated by a blank line", () => {
    const root = initedCopy();
    seedMemory(
      root,
      Array.from({ length: 25 }, () => ({})),
    );
    const run = runCli(root, ["get", ...Array.from({ length: 25 }, (_, i) => String(i + 1))]);
    expect(run.status).toBe(0);
    const blocks = run.stdout.trimEnd().split("\n\n");
    expect(blocks.length).toBe(20);
    expect(blocks.map((b) => Number(/^#(\d+) /.exec(b)![1]))).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  test("exits 1 when no id is found, and prints usage for a non-numeric id", () => {
    const root = initedCopy();
    seedMemory(root, [{}]);
    expect(runCli(root, ["get", "999"]).status).toBe(1);
    for (const args of [["get"], ["get", "abc"], ["get", "1", "abc"]]) {
      const run = runCli(root, args);
      expect(run.status, args.join(" ")).toBe(1);
      expect(run.stderr).toContain("Usage: crank-mem get <id...>");
    }
  });

  test("an unknown project name exits 1", () => {
    const root = initedCopy();
    seedMemory(root, [{}]);
    for (const command of ["get", "timeline"]) {
      expect(runCli(root, [command, "nowhere#1"]), command).toMatchObject({
        status: 1,
        stdout: "",
        stderr: "crank-mem: no project nowhere.\n",
      });
    }
    const run = runCli(root, ["get", "#x"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Usage: crank-mem get <id...>");
  });

  test("ids may carry a # prefix", () => {
    const root = initedCopy();
    const [id] = seedMemory(root, [{}]);
    for (const command of ["get", "timeline"]) {
      const bare = runCli(root, [command, String(id)]);
      expect(bare.status, command).toBe(0);
      expect(runCli(root, [command, `#${id}`]), command).toMatchObject({
        status: 0,
        stdout: bare.stdout,
      });
    }
  });
});

describe("where the commands run", () => {
  const COMMANDS = [
    ["search", "anchor"],
    ["timeline", "1"],
    ["get", "1"],
  ];

  test("each command works from a project subdirectory", () => {
    const root = initedCopy({ "src/a.ts": "export const a = 1;\n" });
    seedMemory(root, [{ title: "Anchor row" }]);
    expect(fs.existsSync(path.join(root, ".crank/memory.db"))).toBe(true);
    for (const args of COMMANDS) {
      const run = runCli(path.join(root, "src"), args);
      expect(run.status, args[0]).toBe(0);
      expect(run.stdout).toMatch(/^#1 \S+ discovery Anchor row\n/);
    }
    expect(runCli(path.join(root, "src"), ["outline", "a.ts"])).toMatchObject({
      status: 0,
      stdout: "a.ts\n",
    });
    const abs = path.join(root, "src/a.ts");
    expect(runCli(root, ["outline", abs])).toMatchObject({ status: 0, stdout: `${abs}\n` });
    const alias = path.join(tempDir("crank-alias-"), "root");
    fs.symlinkSync(root, alias);
    const aliased = path.join(alias, "src/a.ts");
    expect(runCli(root, ["outline", aliased])).toMatchObject({ status: 0, stdout: `${aliased}\n` });
  }, 20_000);

  test("outside any project each command prints the init hint and exits 1", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "crank-recall-bare-"));
    for (const args of [...COMMANDS, ["digest", "on"], ["digest", "off"]]) {
      const run = runCli(bare, args);
      expect(run.status, args[0]).toBe(1);
      expect(run.stderr).toContain("not initialized here");
      expect(fs.existsSync(path.join(bare, ".crank"))).toBe(false);
    }
    for (const args of [
      ["outline", "a.ts"],
      ["unfold", "a.ts", "f"],
    ]) {
      expect([args, runCli(bare, args)]).toEqual([
        args,
        { status: 1, stdout: "", stderr: "crank-mem: a.ts is outside every installed project.\n" },
      ]);
      expect(fs.existsSync(path.join(bare, ".crank"))).toBe(false);
    }
  }, 20_000);
});

describe("help", () => {
  test("--help lists the recall and code commands, and hides --model-host", () => {
    const run = runCli(os.tmpdir(), ["--help"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("  search          Search stored memory by meaning or keyword\n");
    expect(run.stdout).toContain("  timeline        Show the observations around one id\n");
    expect(run.stdout).toContain(
      "  get             Print stored observations in full\n  outline         Print a source file's symbols with their bodies folded\n",
    );
    expect(run.stdout).toContain(
      "  outline         Print a source file's symbols with their bodies folded\n  unfold          Print one symbol's full source\n",
    );
    expect(run.stdout).toContain("  restore-memory  Put a memory.db snapshot back\n");
    expect(run.stdout).toContain(
      "  digest          Turn background digests on or off, or resume them\n",
    );
    expect(run.stdout).not.toContain("--model-host");
    expect(runCli(os.tmpdir(), ["outline", "--help"]).stdout).toBe(
      "Usage: crank-mem outline <file> [--from <line>]\n\nPrint a source file's symbols with their bodies folded.\n",
    );
    expect(runCli(os.tmpdir(), ["unfold", "--help"]).stdout).toBe(
      "Usage: crank-mem unfold <file> <symbol|line>\n\nPrint one symbol's full source.\n",
    );
  }, 20_000);
});

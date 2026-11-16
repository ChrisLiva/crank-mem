import { expect, test } from "bun:test";
import { openCodeDb } from "../src/hooks/lib/code-db.ts";
import { relatedFiles } from "../src/hooks/lib/related-files.ts";
import { graphProject } from "./helpers.ts";

/** relatedFiles over `root`'s code.db, with each neighbour's weight dropped for order-only checks. */
const rel = (root: string, text: string) => {
  const r = weighted(root, text);
  return { seeds: r.seeds, neighbours: r.neighbours.map((n) => n.path) };
};

function weighted(root: string, text: string) {
  const opened = openCodeDb(root, "read");
  expect(opened.status).toBe("open");
  try {
    return relatedFiles(opened.db!, text);
  } finally {
    opened.db!.close();
  }
}

const E = { seeds: [], neighbours: [] };

/** A project of TypeScript files named by path: `imports` become import lines, `declares` exported functions. */
function project(files: Record<string, { imports?: string[]; declares?: string[] }>): string {
  const sources: Record<string, string> = {};
  for (const [file, { imports = [], declares = [] }] of Object.entries(files)) {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    const lines = imports.map((target) => `import "${relativeTo(dir, target)}";`);
    for (const name of declares) lines.push(`export function ${name}() {}`);
    sources[file] = `${lines.join("\n")}\n// ${file}\n`;
  }
  return graphProject(sources);
}

/** `target` as an import specifier from a file in `dir`. */
function relativeTo(dir: string, target: string): string {
  const from = dir === "." ? [] : dir.split("/");
  const to = target.split("/");
  while (from.length > 0 && to.length > 1 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return [...(from.length === 0 ? ["."] : from.map(() => "..")), ...to].join("/");
}

const G = project({
  "src/lock.ts": { declares: ["withLock"] },
  "src/a.ts": { imports: ["src/lock.ts", "src/gone.ts"] },
  "src/b.ts": { imports: ["src/lock.ts", "src/c.ts"] },
  "src/c.ts": {},
  "src/d.ts": { imports: ["src/a.ts"] },
  "src/lib/foo.test.ts": {},
  "src/lib/foo.ts": {},
});

test("terms match a file by path, path suffix, basename, stem or symbol", () => {
  const lock = { seeds: ["src/lock.ts"], neighbours: ["src/a.ts", "src/b.ts"] };
  for (const q of [
    "why did lock.ts?!. change",
    "withLock",
    "LOCK.TS",
    "(lock.ts),",
    "SRC/LOCK.TS",
    ["`lock.ts`", "[lock.ts]:", "{lock.ts};", '"lock.ts"', "'lock.ts'", "lock.ts."].join(" "),
    "src/lock.ts",
  ]) {
    expect(rel(G, q)).toEqual(lock);
  }
  expect(rel(G, "lib/foo.test.ts").seeds).toEqual(["src/lib/foo.test.ts"]);
  expect(rel(G, "LIB/FOO.TEST.TS").seeds).toEqual(["src/lib/foo.test.ts"]);
  expect(rel(G, "lib/foo.test").seeds).toEqual([]);
  expect(rel(G, "foo.test").seeds).toEqual(["src/lib/foo.test.ts"]);
  expect(rel(G, "foo.ts").seeds).toEqual(["src/lib/foo.ts"]);
  const short = project({ "x/ab.ts": {}, "x/abc.ts": {} });
  expect(rel(short, "ab")).toEqual(E);
  expect(rel(short, "abc")).toEqual(E);
  expect(rel(short, "aB")).toEqual(E);
  expect(rel(short, "aBc")).toEqual({ seeds: ["x/abc.ts"], neighbours: [] });
});

test("neighbours run both ways, heaviest first, never a seed or a missing path", () => {
  expect(rel(G, "src/a.ts src/b.ts")).toEqual({
    seeds: ["src/a.ts", "src/b.ts"],
    neighbours: ["src/lock.ts", "src/c.ts", "src/d.ts"],
  });
  expect(rel(G, "src/d.ts src/a.ts")).toEqual({
    seeds: ["src/d.ts", "src/a.ts"],
    neighbours: ["src/lock.ts"],
  });
  const i = project({
    "p.ts": { imports: ["a/q.ts"] },
    "a/q.ts": { imports: ["p.ts"] },
    "r.ts": { imports: ["b/z.ts"] },
    "s.ts": { imports: ["b/z.ts"] },
    "b/z.ts": {},
  });
  expect(rel(i, "p.ts r.ts s.ts")).toEqual({
    seeds: ["p.ts", "r.ts", "s.ts"],
    neighbours: ["b/z.ts", "a/q.ts"],
  });
});

test("each seed splits 1/seeds evenly over all its neighbours", () => {
  expect(weighted(G, "src/a.ts src/b.ts").neighbours).toEqual([
    { path: "src/lock.ts", weight: 0.5 },
    { path: "src/c.ts", weight: 0.25 },
    { path: "src/d.ts", weight: 0.25 },
  ]);
  const i = project({
    "hub.ts": { imports: ["x1.ts", "x2.ts", "x3.ts", "x4.ts"] },
    "x1.ts": {},
    "x2.ts": {},
    "x3.ts": {},
    "x4.ts": {},
    "one.ts": { imports: ["y.ts", "hub.ts"] },
    "y.ts": {},
  });
  expect(weighted(i, "hub.ts one.ts").neighbours).toEqual([
    { path: "y.ts", weight: 0.25 },
    { path: "x1.ts", weight: 0.1 },
    { path: "x2.ts", weight: 0.1 },
    { path: "x3.ts", weight: 0.1 },
    { path: "x4.ts", weight: 0.1 },
  ]);
});

test("seeds follow query-term order, without duplicates", () => {
  expect(rel(G, "c.ts lock.ts c.ts").seeds).toEqual(["src/c.ts", "src/lock.ts"]);
});

test("path order within a term is code-unit order", () => {
  const i = project({ "x/a/util.ts": {}, "x/B/util.ts": {} });
  expect(rel(i, "util.ts").seeds).toEqual(["x/B/util.ts", "x/a/util.ts"]);
});

test("a term matching more than 5 files seeds nothing", () => {
  const utils = (n: number) =>
    project(Object.fromEntries(Array.from({ length: n }, (_, k) => [`x/${k + 1}/util.ts`, {}])));
  expect(rel(utils(6), "util.ts").seeds).toEqual([]);
  expect(rel(utils(5), "util.ts").seeds).toEqual([
    "x/1/util.ts",
    "x/2/util.ts",
    "x/3/util.ts",
    "x/4/util.ts",
    "x/5/util.ts",
  ]);
});

test("seeds stop at 20 and neighbours at 100", () => {
  const grid: Record<string, object> = {};
  for (let j = 1; j <= 5; j++) for (let k = 1; k <= 5; k++) grid[`d${j}/p${k}.ts`] = {};
  const seeds = rel(project(grid), "p1.ts p2.ts p3.ts p4.ts p5.ts").seeds;
  expect(seeds.length).toBe(20);
  expect(seeds[0]).toBe("d1/p1.ts");
  expect(seeds[19]).toBe("d5/p4.ts");

  const hub: Record<string, { imports?: string[] }> = { "hub.ts": {} };
  for (let n = 0; n < 120; n++)
    hub[`n/f${String(n).padStart(3, "0")}.ts`] = { imports: ["hub.ts"] };
  const neighbours = rel(project(hub), "hub.ts").neighbours;
  expect(neighbours.length).toBe(100);
  expect(neighbours[0]).toBe("n/f000.ts");
  expect(neighbours[99]).toBe("n/f099.ts");
});

test("a C# using links to the other files declaring it, up to 10 declaring files", () => {
  const cs = (declaring: number) => {
    const files: Record<string, string> = {
      "src/Use.cs": "using App.Core;\nnamespace App.Core { class Use {} }\n",
    };
    for (let n = 0; n < declaring - 1; n++)
      files[`src/C${n}.cs`] = `namespace App.Core { class C${n} {} }\n`;
    return graphProject(files);
  };
  const i = cs(10);
  expect(rel(i, "Use.cs").neighbours).toEqual(Array.from({ length: 9 }, (_, n) => `src/C${n}.cs`));
  expect(rel(i, "C0.cs").neighbours).toEqual(["src/Use.cs"]);
  expect(rel(cs(11), "Use.cs").neighbours).toEqual([]);
});

test("without a code.db there are no seeds, and a query naming nothing seeds nothing", () => {
  expect(relatedFiles(null, "src/lock.ts withLock")).toEqual(E);
  expect(rel(G, "constructor __proto__ toString hasOwnProperty")).toEqual(E);
});

test("only path-like and identifier-shaped terms seed", () => {
  const B = graphProject({
    "bin/crank-mem": "#!/bin/sh\n",
    "src/cli/main.ts": "export const x = 1;\n",
    "src/cli/recall.ts": "export function search() {}\n",
  });
  for (const t of ["WITHLOCK", "withlock", "lock", "foo", "foo."]) {
    expect(rel(G, t)).toEqual(E);
  }
  for (const t of ["crank-mem", "main", "search"]) {
    expect(rel(B, t)).toEqual(E);
  }
  expect(rel(B, "bin/crank-mem")).toEqual({ seeds: ["bin/crank-mem"], neighbours: [] });
  expect(rel(B, "main.ts")).toEqual({ seeds: ["src/cli/main.ts"], neighbours: [] });

  expect(rel(G, "withLock")).toEqual({
    seeds: ["src/lock.ts"],
    neighbours: ["src/a.ts", "src/b.ts"],
  });
  const U = graphProject({
    "src/cfg.py": "def read_config():\n    pass\n",
    "x/my_mod.ts": "export const m = 1;\n",
    "x/my_mod.test.ts": "export const t = 1;\n",
  });
  expect(rel(U, "read_config")).toEqual({ seeds: ["src/cfg.py"], neighbours: [] });
  expect(rel(U, "READ_CONFIG")).toEqual({ seeds: ["src/cfg.py"], neighbours: [] });
  expect(rel(U, "my_mod")).toEqual({ seeds: ["x/my_mod.ts"], neighbours: [] });
  expect(rel(U, "my_mod.test")).toEqual({ seeds: ["x/my_mod.test.ts"], neighbours: [] });
});

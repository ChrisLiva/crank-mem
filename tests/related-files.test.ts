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

test("terms match a file by path, path suffix, basename, stem or symbol, in term order and code-unit path order", () => {
  const lock = { seeds: ["src/lock.ts"], neighbours: ["src/a.ts", "src/b.ts"] };
  expect(rel(G, "withLock")).toEqual({ seeds: ["src/lock.ts"], neighbours: [] });
  for (const q of [
    "why did lock.ts?!. change",
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
  expect(rel(G, "c.ts lock.ts c.ts").seeds).toEqual(["src/c.ts", "src/lock.ts"]);
  const cased = project({ "x/a/util.ts": {}, "x/B/util.ts": {} });
  expect(rel(cased, "util.ts").seeds).toEqual(["x/B/util.ts", "x/a/util.ts"]);
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
  // A seed splits its weight over all its neighbours: hub's four dilute below one's single y.
  const split = project({
    "hub.ts": { imports: ["x1.ts", "x2.ts", "x3.ts", "x4.ts"] },
    "x1.ts": {},
    "x2.ts": {},
    "x3.ts": {},
    "x4.ts": {},
    "one.ts": { imports: ["y.ts", "hub.ts"] },
    "y.ts": {},
  });
  expect(rel(split, "hub.ts one.ts").neighbours).toEqual([
    "y.ts",
    "x1.ts",
    "x2.ts",
    "x3.ts",
    "x4.ts",
  ]);
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

test("a symbol seeds its defining file and reaches only its resolved callers and callees", () => {
  const C = graphProject({
    "src/store.ts":
      'import { audit } from "./audit";\nexport class Store {\n  save() { audit(); }\n  load() {}\n}\n',
    "src/audit.ts": "export function audit() {}\n",
    "src/user.ts": 'import { Store } from "./store";\nexport function go(s: Store) { s.save(); }\n',
    "src/reader.ts":
      'import { Store } from "./store";\nexport function read(s: Store) { s.load(); }\n',
    "src/idle.ts": 'import { Store } from "./store";\nexport const idle = Store;\n',
  });
  expect(rel(C, "Store.save")).toEqual({
    seeds: ["src/store.ts"],
    neighbours: ["src/audit.ts", "src/user.ts"],
  });
  expect(rel(C, "store.SAVE")).toEqual(rel(C, "Store.save"));
  expect(rel(C, "store.ts").neighbours).toEqual([
    "src/audit.ts",
    "src/idle.ts",
    "src/reader.ts",
    "src/user.ts",
  ]);

  const TWO = graphProject({
    "src/a.ts": "export class Repo {\n  fetchAll() {}\n}\n",
    "src/b.ts": "export class Repo {\n  fetchAll() {}\n}\n",
    "src/c.ts": "export class Other {\n  fetchAll() {}\n}\n",
  });
  expect(rel(TWO, "Repo.fetchAll").seeds).toEqual(["src/a.ts", "src/b.ts"]);
  expect(rel(TWO, "fetchAll").seeds).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("a file seed adds the files whose calls reach it or that it calls, when nothing imports", () => {
  const J = graphProject({
    "src/A.java": "class A {\n  void run(B b) { b.go(); }\n}\n",
    "src/B.java": "class B {\n  void go() { C.help(); }\n}\n",
    "src/C.java": "class C {\n  static void help() {}\n}\n",
    "src/D.java": "class D {\n  void other() {}\n}\n",
  });
  expect(rel(J, "src/B.java")).toEqual({
    seeds: ["src/B.java"],
    neighbours: ["src/A.java", "src/C.java"],
  });
  expect(rel(J, "src/D.java")).toEqual({ seeds: ["src/D.java"], neighbours: [] });
  expect(weighted(J, "src/B.java").neighbours.map((n) => n.weight)).toEqual([0.5, 0.5]);

  const M = graphProject({
    "src/a.ts": 'import "./b";\nimport { z } from "./c";\nexport function a() { z(); }\n',
    "src/b.ts": "export const b = 1;\n",
    "src/c.ts": "export function z() {}\n",
  });
  expect(weighted(M, "src/a.ts").neighbours).toEqual([
    { path: "src/b.ts", weight: 0.5 },
    { path: "src/c.ts", weight: 0.5 },
  ]);
});

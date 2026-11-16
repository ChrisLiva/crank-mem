import { expect, test } from "bun:test";
import { relatedFiles } from "../src/hooks/lib/related-files.ts";
import { emptyIndex, type AnatomyIndex, type FileEntry } from "../src/hooks/lib/store.ts";
import { idx } from "./helpers.ts";

/** relatedFiles with each neighbour's weight dropped, for order-only checks. */
const rel = (index: AnatomyIndex, text: string) => {
  const r = relatedFiles(index, text);
  return { seeds: r.seeds, neighbours: r.neighbours.map((n) => n.path) };
};

const G = idx({
  "src/lock.ts": {
    symbols: [{ name: "withLock", kind: "fn", startLine: 1, endLine: 1, tokens: 1 }],
  },
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
  const short = idx({ "x/ab.ts": {}, "x/abc.ts": {} });
  expect(rel(short, "ab")).toEqual({ seeds: [], neighbours: [] });
  expect(rel(short, "abc")).toEqual({ seeds: [], neighbours: [] });
  expect(rel(short, "aB")).toEqual({ seeds: [], neighbours: [] });
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
  const i = idx({
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
  expect(relatedFiles(G, "src/a.ts src/b.ts").neighbours).toEqual([
    { path: "src/lock.ts", weight: 0.5 },
    { path: "src/c.ts", weight: 0.25 },
    { path: "src/d.ts", weight: 0.25 },
  ]);
  const i = idx({
    "hub.ts": { imports: ["x1.ts", "x2.ts", "x3.ts", "x4.ts"] },
    "x1.ts": {},
    "x2.ts": {},
    "x3.ts": {},
    "x4.ts": {},
    "one.ts": { imports: ["y.ts", "hub.ts"] },
    "y.ts": {},
  });
  expect(relatedFiles(i, "hub.ts one.ts").neighbours).toEqual([
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
  const i = idx({ "x/a/util.ts": {}, "x/B/util.ts": {} });
  expect(rel(i, "util.ts").seeds).toEqual(["x/B/util.ts", "x/a/util.ts"]);
});

test("a term matching more than 5 files seeds nothing", () => {
  const utils = (n: number) =>
    idx(Object.fromEntries(Array.from({ length: n }, (_, k) => [`x/${k + 1}/util.ts`, {}])));
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
  const grid: Record<string, Partial<FileEntry>> = {};
  for (let j = 1; j <= 5; j++) for (let k = 1; k <= 5; k++) grid[`d${j}/p${k}.ts`] = {};
  const seeds = rel(idx(grid), "p1.ts p2.ts p3.ts p4.ts p5.ts").seeds;
  expect(seeds.length).toBe(20);
  expect(seeds[0]).toBe("d1/p1.ts");
  expect(seeds[19]).toBe("d5/p4.ts");

  const hub: Record<string, Partial<FileEntry>> = { "hub.ts": {} };
  for (let n = 0; n < 120; n++)
    hub[`n/f${String(n).padStart(3, "0")}.ts`] = { imports: ["hub.ts"] };
  const neighbours = rel(idx(hub), "hub.ts").neighbours;
  expect(neighbours.length).toBe(100);
  expect(neighbours[0]).toBe("n/f000.ts");
  expect(neighbours[99]).toBe("n/f099.ts");
});

test("a C# using links to the other files declaring it, up to 10 declaring files", () => {
  const cs = (declaring: number) => {
    const files: Record<string, Partial<FileEntry>> = {
      "src/Use.cs": { namespaces: { uses: ["App.Core"], declares: ["App.Core"] } },
    };
    for (let n = 0; n < declaring - 1; n++)
      files[`src/C${n}.cs`] = { namespaces: { declares: ["App.Core"] } };
    return idx(files);
  };
  const i = cs(10);
  expect(rel(i, "Use.cs").neighbours).toEqual(Array.from({ length: 9 }, (_, n) => `src/C${n}.cs`));
  expect(rel(i, "C0.cs").neighbours).toEqual(["src/Use.cs"]);
  expect(rel(cs(11), "Use.cs").neighbours).toEqual([]);
});

test("malformed entries contribute nothing and never throw", () => {
  const i = idx({
    "src/x.ts": {
      imports: 7 as unknown as string[],
      symbols: [1, { name: 2 }, null] as unknown as FileEntry["symbols"],
      namespaces: null as unknown as FileEntry["namespaces"],
    },
    "src/y.ts": {
      imports: [3, "src/x.ts"] as unknown as string[],
      namespaces: { uses: 7 } as unknown as FileEntry["namespaces"],
    },
    "src/w.ts": { imports: ["src/arr.ts"] },
  });
  const files = i.files as Record<string, unknown>;
  files["src/z.ts"] = null;
  files["src/m.ts"] = 7;
  files["src/arr.ts"] = [];
  expect(rel(i, "arr.ts")).toEqual({ seeds: [], neighbours: [] });
  expect(rel(i, "w.ts")).toEqual({ seeds: ["src/w.ts"], neighbours: [] });
  expect(rel(i, "src/y.ts")).toEqual({ seeds: ["src/y.ts"], neighbours: ["src/x.ts"] });
  expect(rel(i, "x.ts")).toEqual({ seeds: ["src/x.ts"], neighbours: ["src/y.ts"] });
  expect(rel(i, "z.ts m.ts src/z.ts src/m.ts")).toEqual({ seeds: [], neighbours: [] });
  expect(rel(emptyIndex(), "anything")).toEqual({ seeds: [], neighbours: [] });
  expect(rel(G, "constructor __proto__ toString hasOwnProperty")).toEqual({
    seeds: [],
    neighbours: [],
  });
});

test("only path-like and identifier-shaped terms seed", () => {
  const E = { seeds: [], neighbours: [] };
  const B = idx({
    "bin/crank-mem": {},
    "src/cli/main.ts": {},
    "src/cli/recall.ts": {
      symbols: [{ name: "search", kind: "fn", startLine: 1, endLine: 1, tokens: 1 }],
    },
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
  const U = idx({
    "src/cfg.py": {
      symbols: [{ name: "read_config", kind: "fn", startLine: 1, endLine: 1, tokens: 1 }],
    },
    "x/my_mod.ts": {},
    "x/my_mod.test.ts": {},
  });
  expect(rel(U, "read_config")).toEqual({ seeds: ["src/cfg.py"], neighbours: [] });
  expect(rel(U, "READ_CONFIG")).toEqual({ seeds: ["src/cfg.py"], neighbours: [] });
  expect(rel(U, "my_mod")).toEqual({ seeds: ["x/my_mod.ts"], neighbours: [] });
  expect(rel(U, "my_mod.test")).toEqual({ seeds: ["x/my_mod.test.ts"], neighbours: [] });
});

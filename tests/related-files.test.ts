import { expect, test } from "bun:test";
import { relatedFiles } from "../src/hooks/lib/related-files.ts";
import { emptyIndex, type FileEntry } from "../src/hooks/lib/store.ts";
import { idx } from "./helpers.ts";

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
    expect(relatedFiles(G, q)).toEqual(lock);
  }
  expect(relatedFiles(G, "lib/foo.test.ts").seeds).toEqual(["src/lib/foo.test.ts"]);
  expect(relatedFiles(G, "LIB/FOO.TEST.TS").seeds).toEqual(["src/lib/foo.test.ts"]);
  expect(relatedFiles(G, "lib/foo.test").seeds).toEqual([]);
  expect(relatedFiles(G, "foo.test").seeds).toEqual(["src/lib/foo.test.ts"]);
  expect(relatedFiles(G, "foo.ts").seeds).toEqual(["src/lib/foo.ts"]);
  const short = idx({ "x/ab.ts": {}, "x/abc.ts": {} });
  expect(relatedFiles(short, "ab")).toEqual({ seeds: [], neighbours: [] });
  expect(relatedFiles(short, "abc")).toEqual({ seeds: [], neighbours: [] });
  expect(relatedFiles(short, "aB")).toEqual({ seeds: [], neighbours: [] });
  expect(relatedFiles(short, "aBc")).toEqual({ seeds: ["x/abc.ts"], neighbours: [] });
});

test("neighbours run both ways, most-touched first, never a seed or a missing path", () => {
  expect(relatedFiles(G, "src/a.ts src/b.ts")).toEqual({
    seeds: ["src/a.ts", "src/b.ts"],
    neighbours: ["src/lock.ts", "src/c.ts", "src/d.ts"],
  });
  expect(relatedFiles(G, "src/d.ts src/a.ts")).toEqual({
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
  expect(relatedFiles(i, "p.ts r.ts s.ts")).toEqual({
    seeds: ["p.ts", "r.ts", "s.ts"],
    neighbours: ["b/z.ts", "a/q.ts"],
  });
});

test("seeds follow query-term order, without duplicates", () => {
  expect(relatedFiles(G, "c.ts lock.ts c.ts").seeds).toEqual(["src/c.ts", "src/lock.ts"]);
});

test("path order within a term is code-unit order", () => {
  const i = idx({ "x/a/util.ts": {}, "x/B/util.ts": {} });
  expect(relatedFiles(i, "util.ts").seeds).toEqual(["x/B/util.ts", "x/a/util.ts"]);
});

test("a term matching more than 5 files seeds nothing", () => {
  const utils = (n: number) =>
    idx(Object.fromEntries(Array.from({ length: n }, (_, k) => [`x/${k + 1}/util.ts`, {}])));
  expect(relatedFiles(utils(6), "util.ts").seeds).toEqual([]);
  expect(relatedFiles(utils(5), "util.ts").seeds).toEqual([
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
  const seeds = relatedFiles(idx(grid), "p1.ts p2.ts p3.ts p4.ts p5.ts").seeds;
  expect(seeds.length).toBe(20);
  expect(seeds[0]).toBe("d1/p1.ts");
  expect(seeds[19]).toBe("d5/p4.ts");

  const hub: Record<string, Partial<FileEntry>> = { "hub.ts": {} };
  for (let n = 0; n < 120; n++)
    hub[`n/f${String(n).padStart(3, "0")}.ts`] = { imports: ["hub.ts"] };
  const neighbours = relatedFiles(idx(hub), "hub.ts").neighbours;
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
  expect(relatedFiles(i, "Use.cs").neighbours).toEqual(
    Array.from({ length: 9 }, (_, n) => `src/C${n}.cs`),
  );
  expect(relatedFiles(i, "C0.cs").neighbours).toEqual(["src/Use.cs"]);
  expect(relatedFiles(cs(11), "Use.cs").neighbours).toEqual([]);
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
  expect(relatedFiles(i, "arr.ts")).toEqual({ seeds: [], neighbours: [] });
  expect(relatedFiles(i, "w.ts")).toEqual({ seeds: ["src/w.ts"], neighbours: [] });
  expect(relatedFiles(i, "src/y.ts")).toEqual({ seeds: ["src/y.ts"], neighbours: ["src/x.ts"] });
  expect(relatedFiles(i, "x.ts")).toEqual({ seeds: ["src/x.ts"], neighbours: ["src/y.ts"] });
  expect(relatedFiles(i, "z.ts m.ts src/z.ts src/m.ts")).toEqual({ seeds: [], neighbours: [] });
  expect(relatedFiles(emptyIndex(), "anything")).toEqual({ seeds: [], neighbours: [] });
  expect(relatedFiles(G, "constructor __proto__ toString hasOwnProperty")).toEqual({
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
    expect(relatedFiles(G, t)).toEqual(E);
  }
  for (const t of ["crank-mem", "main", "search"]) {
    expect(relatedFiles(B, t)).toEqual(E);
  }
  expect(relatedFiles(B, "bin/crank-mem")).toEqual({ seeds: ["bin/crank-mem"], neighbours: [] });
  expect(relatedFiles(B, "main.ts")).toEqual({ seeds: ["src/cli/main.ts"], neighbours: [] });

  expect(relatedFiles(G, "withLock")).toEqual({
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
  expect(relatedFiles(U, "read_config")).toEqual({ seeds: ["src/cfg.py"], neighbours: [] });
  expect(relatedFiles(U, "READ_CONFIG")).toEqual({ seeds: ["src/cfg.py"], neighbours: [] });
  expect(relatedFiles(U, "my_mod")).toEqual({ seeds: ["x/my_mod.ts"], neighbours: [] });
  expect(relatedFiles(U, "my_mod.test")).toEqual({ seeds: ["x/my_mod.test.ts"], neighbours: [] });
});

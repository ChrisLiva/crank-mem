import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { citationCheck, fileCitations, storeLinks } from "../src/hooks/lib/citations.ts";
import { projectName } from "../src/hooks/lib/owner.ts";
import { registerProject } from "../src/hooks/lib/registry.ts";
import { type AnatomyIndex, type FileEntry } from "../src/hooks/lib/store.ts";
import { inZone, makeCrankProject, plantMemory, seedMemory, ZONES } from "./helpers.ts";

function idx(files: Record<string, Partial<FileEntry>>): AnatomyIndex {
  const entries: Record<string, FileEntry> = {};
  for (const [p, f] of Object.entries(files)) {
    entries[p] = { description: "", tokens: 1, size: 1, mtimeMs: 0, ...f };
  }
  return {
    version: 2,
    files: entries,
    meta: { lastScanned: null, fileCount: Object.keys(entries).length },
  };
}

function write(root: string, rel: string, text = "x\n"): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

const HOME_INDEX = {
  "src/a.ts": { mtimeMs: 2000 },
  "src/ghost.ts": { mtimeMs: 2000 },
  "lib/deep/widget.ts": { mtimeMs: 2000 },
  "a/shared/dup.ts": { mtimeMs: 2000 },
  "b/shared/dup.ts": { mtimeMs: 2000 },
  "vendored/x.ts": { mtimeMs: 2000 },
};

/** A home root, a linked `pay` with an anatomy, a linked `broken` without one, and a counted `links`. */
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crank-citations-"));
  const home = path.join(tmp, "home");
  const payRoot = path.join(tmp, "pay");
  const brokenRoot = path.join(tmp, "broken");
  for (const rel of ["src/a.ts", "lib/deep/widget.ts", "docs/onDisk.md", "vendored/x.ts"])
    write(home, rel);
  for (const rel of ["src/p.ts", "notes/raw.md"]) write(payRoot, rel);
  write(brokenRoot, "src/k.ts");
  const payIndex = path.join(payRoot, ".crank", "anatomy-index.json");
  write(
    payRoot,
    ".crank/anatomy-index.json",
    JSON.stringify(idx({ "src/p.ts": { mtimeMs: 2000 }, "lib/q/r.ts": { mtimeMs: 2000 } })),
  );
  let calls = 0;
  const links = () => {
    calls++;
    return [
      { name: "pay", root: payRoot },
      { name: "broken", root: brokenRoot },
      { name: "vendored", root: payRoot },
    ];
  };
  const homeIndex = idx(HOME_INDEX);
  return {
    home,
    payIndex,
    brokenRoot,
    links,
    calls: () => calls,
    resolve: (index = homeIndex) => citationCheck({ root: home, index }, { resolve: links }),
    ignore: () => citationCheck({ root: home, index: homeIndex }, { ignore: links }),
  };
}

const none = { missing: [], modified: [] };
const missing = (...m: string[]) => ({ missing: m, modified: [] });
const modified = (...d: string[]) => ({ missing: [], modified: d });

test("fileCitations keeps paths and basenames with an extension, minus ./ and :line", () => {
  expect(
    fileCitations(
      "`src/a.ts` `./lib/b.py:12` `c.md:3-9` `--force` `/abs/x.ts` `~/n.py` `src/*.py` `K=v.ts` `two words.ts` `fs.statSync` `noext`",
    ),
  ).toEqual(["src/a.ts", "lib/b.py", "c.md", "fs.statSync"]);
});

describe("a home citation", () => {
  test.each([
    ["`src/a.ts`", 1000, modified("src/a.ts")],
    ["`src/a.ts`", 2000, none],
    ["`src/ghost.ts`", 5000, none],
    ["`deep/widget.ts`", 1000, modified("deep/widget.ts")],
    ["`deep/widget.ts`", 5000, none],
    ["`widget.ts`", 1000, modified("widget.ts")],
    ["`shared/dup.ts`", 1000, none],
    ["`src/gone.ts`", 1000, missing("src/gone.ts")],
    ["`gone.ts`", 1000, none],
    ["`docs/onDisk.md`", 1000, none],
    ["`ep/widget.ts`", 1000, missing("ep/widget.ts")],
  ])("%s past %d", (text, sinceMs, expected) => {
    expect(fixture().resolve().status(text, sinceMs)).toEqual(expected);
  });

  test("each file is listed once, as cited", () => {
    const text = "`./src/gone.ts:12` and `src/gone.ts` and `src/a.ts:3-9` and `src/a.ts`";
    expect(fixture().resolve().status(text, 1000)).toEqual({
      missing: ["src/gone.ts"],
      modified: ["src/a.ts"],
    });
  });
});

describe("with no cutoff, a citation is modified past the end of the text's latest date", () => {
  for (const zone of ZONES) {
    test(zone, () => {
      inZone(zone, () => {
        const f = fixture();
        const noon = new Date(2020, 0, 1, 12).getTime();
        const nextDay = new Date(2020, 0, 2).getTime();
        const at = (mtimeMs: number) => f.resolve(idx({ "src/a.ts": { mtimeMs } }));
        expect(at(noon).status("`src/a.ts` (2020-01-01)", null)).toEqual(none);
        expect(at(nextDay + 1).status("`src/a.ts` (2020-01-01)", null)).toEqual(
          modified("src/a.ts"),
        );
        expect(at(noon).status("`src/a.ts` (2019-06-01), revised (2020-01-01)", null)).toEqual(
          none,
        );
        expect(at(nextDay + 1).status("`src/a.ts`", null)).toEqual(none);
        expect(at(noon).status("`src/a.ts` (2020-01-01)", noon - 1)).toEqual(modified("src/a.ts"));
      });
    });
  }
});

describe("a citation whose first segment names a linked project", () => {
  test.each([
    ["`pay/src/p.ts`", modified("pay/src/p.ts")],
    ["`pay/q/r.ts`", modified("pay/q/r.ts")],
    ["`pay/src/none.ts`", missing("pay/src/none.ts")],
    ["`pay/notes/raw.md`", none],
    ["`pay/zzz.ts`", none],
  ])("resolves %s in that project", (text, expected) => {
    expect(fixture().resolve().status(text, 1000)).toEqual(expected);
  });

  for (const policy of ["resolve", "ignore"] as const) {
    test.each([
      ["`vendored/x.ts`", modified("vendored/x.ts")],
      ["`vendored/nope.ts`", missing("vendored/nope.ts")],
      ["`other/src/x.ts`", missing("other/src/x.ts")],
    ])(
      `under ${policy}, resolves %s at home when home holds the entry or no link names it`,
      (text, expected) => {
        expect(fixture()[policy]().status(text, 1000)).toEqual(expected);
      },
    );
  }

  test("is skipped under ignore", () => {
    expect(fixture().ignore().status("`pay/src/p.ts` and `pay/src/none.ts`", 1000)).toEqual(none);
  });

  test("lists the links at most once per checker, and only when a citation needs them", () => {
    const home = fixture();
    const homeOnly = home.resolve();
    homeOnly.status("`a.ts` and `src/a.ts` and `vendored/x.ts`", 1000);
    homeOnly.status("`a.ts` and `src/a.ts` and `vendored/x.ts`", 1000);
    expect(home.calls()).toBe(0);

    for (const policy of ["resolve", "ignore"] as const) {
      const f = fixture();
      const check = f[policy]();
      check.status("`pay/src/p.ts`", 1000);
      check.status("`pay/src/p.ts`", 1000);
      if (policy === "resolve") check.status("`other/src/x.ts`", 1000);
      expect(f.calls()).toBe(1);
    }
  });

  test("reads the linked anatomy once per checker and never writes it", () => {
    const f = fixture();
    const before = fs.readFileSync(f.payIndex);
    const check = f.resolve();
    expect(check.status("`pay/src/p.ts`", 1000)).toEqual(modified("pay/src/p.ts"));
    expect(fs.readFileSync(f.payIndex).equals(before)).toBe(true);
    fs.writeFileSync(f.payIndex, JSON.stringify(idx({})));
    expect(check.status("`pay/src/p.ts`", 1000)).toEqual(modified("pay/src/p.ts"));
    expect(f.resolve().status("`pay/src/p.ts`", 1000)).toEqual(none);
  });

  test("resolves at home when no project is linked", () => {
    const f = fixture();
    const check = citationCheck({ root: f.home, index: idx(HOME_INDEX) }, { resolve: () => [] });
    expect(check.status("`pay/src/p.ts`", 1000)).toEqual(missing("pay/src/p.ts"));
  });

  test("checks the disk alone when the linked anatomy is absent or corrupt", () => {
    const f = fixture();
    const rows = () => {
      const check = f.resolve();
      return [
        check.status("`broken/src/k.ts`", 1000),
        check.status("`broken/src/none.ts`", 1000),
        check.status("`broken/none.ts`", 1000),
      ];
    };
    const expected = [none, missing("broken/src/none.ts"), none];
    expect(rows()).toEqual(expected);
    write(f.brokenRoot, ".crank/anatomy-index.json", "not json");
    expect(rows()).toEqual(expected);
  });
});

test("storeLinks lists a store's linked projects, and none when the store cannot be read", () => {
  const linked = makeCrankProject();
  registerProject(linked);
  const root = makeCrankProject();
  seedMemory(root, [], { links: [projectName(linked)] });
  expect(storeLinks(root)).toEqual([{ name: projectName(linked), root: linked }]);
  expect(storeLinks(makeCrankProject())).toEqual([]);
  for (const state of ["newer", "unreadable"] as const) {
    const r = makeCrankProject();
    plantMemory(r, state);
    expect(storeLinks(r)).toEqual([]);
  }
});

import { describe, expect, test } from "bun:test";
import { applyEdits, numberBullets, type CerebrumEdit } from "../src/daemon/cerebrum-edit.ts";

const M = "# Cerebrum\n\nIntro line.\n\n## User Preferences\n\n- **Plans**: as files (2026-10-01)\n\n## Memory\n\n" +
  "- **Lock**: `src/lock.ts` → `withLock` retries 2 s (2026-10-01)\n  continued line\n\n### Sub\n\n- **Deep**: under sub (2026-10-02)\n";

const TODAY = "2026-11-04";

describe("numberBullets", () => {
  test("numbers the bullets under ## sections, folding ### bullets into the enclosing section", () => {
    expect(numberBullets(M)).toEqual({
      headings: ["User Preferences", "Memory"],
      bullets: [
        { id: 1, heading: "User Preferences", text: "**Plans**: as files (2026-10-01)" },
        { id: 2, heading: "Memory", text: "**Lock**: `src/lock.ts` → `withLock` retries 2 s (2026-10-01) continued line" },
        { id: 3, heading: "Memory", text: "**Deep**: under sub (2026-10-02)" },
      ],
    });
    expect(numberBullets("# Cerebrum\n\n- stray\n\n## Memory\n- a\n").bullets)
      .toEqual([{ id: 1, heading: "Memory", text: "a" }]);
    expect(numberBullets("")).toEqual({ headings: [], bullets: [] });
  });
});

describe("applyEdits", () => {
  test("a replace, a remove and an add change only their own lines", () => {
    expect(applyEdits(M, [
      { op: "replace", bulletId: 2, bullet: "**Lock**: `src/lock.ts` → `withLock` retries 5 s (2026-11-04)", reason: "retry changed", proposal: null },
      { op: "remove", bulletId: 3, reason: "gone" },
      { op: "add", heading: " user preferences ", bullet: "**Tabs**: user wants tabs", proposal: 7 },
    ], TODAY)).toEqual({
      md: "# Cerebrum\n\nIntro line.\n\n## User Preferences\n\n- **Plans**: as files (2026-10-01)\n- **Tabs**: user wants tabs (2026-11-04)\n\n" +
        "## Memory\n\n- **Lock**: `src/lock.ts` → `withLock` retries 5 s (2026-11-04)\n\n### Sub\n\n",
      archived: [
        "- **Lock**: `src/lock.ts` → `withLock` retries 2 s (2026-10-01)\n  continued line\n  - archived 2026-11-04: retry changed",
        "- **Deep**: under sub (2026-10-02)\n  - archived 2026-11-04: gone",
      ],
      skipped: [],
    });
  });

  test("skips an edit on an unknown or already changed bullet, an empty bullet, and an unknown heading", () => {
    const edits: CerebrumEdit[] = [
      { op: "remove", bulletId: 1, reason: "r" },
      { op: "replace", bulletId: 1, bullet: "x", reason: "r", proposal: null },
      { op: "remove", bulletId: 99, reason: "r" },
      { op: "replace", bulletId: 2, bullet: "  \n  ", reason: "r", proposal: null },
      { op: "add", heading: "Nope", bullet: "y", proposal: null },
    ];
    expect(applyEdits(M, edits, TODAY)).toEqual({
      md: M.replace("- **Plans**: as files (2026-10-01)\n", ""),
      archived: ["- **Plans**: as files (2026-10-01)\n  - archived 2026-11-04: r"],
      skipped: edits.slice(1),
    });
    const add: CerebrumEdit = { op: "add", heading: "Memory", bullet: "z", proposal: null };
    expect(applyEdits("", [add], TODAY)).toEqual({ md: "", archived: [], skipped: [add] });
  });

  test("a written bullet is one redacted line with a leading - and exactly one date", () => {
    const lineOf = (md: string, prefix: string): string | undefined => md.split("\n").find((l) => l.startsWith(prefix));
    const replace1 = (bullet: string): string =>
      applyEdits(M, [{ op: "replace", bulletId: 1, bullet, reason: "r", proposal: null }], TODAY).md;

    expect(lineOf(replace1("- **Multi**\n   line two  "), "- **Multi**")).toBe("- **Multi** line two (2026-11-04)");
    expect(lineOf(replace1("**Dated** (2026-09-09)"), "- **Dated**")).toBe("- **Dated** (2026-09-09)");

    const both = applyEdits(M, [
      { op: "replace", bulletId: 1, bullet: "**One** (2026-01-01)", reason: "r", proposal: null },
      { op: "replace", bulletId: 2, bullet: "**Two** (2026-02-02)", reason: "r", proposal: null },
    ], TODAY).md;
    expect(lineOf(both, "- **One**")).toBe("- **One** (2026-01-01)");
    expect(lineOf(both, "- **Two**")).toBe("- **Two** (2026-02-02)");

    const token = "ghp_" + "a1".repeat(18);
    const secret = replace1(`**Key** ${token}`);
    expect(secret).not.toContain(token);
    expect(lineOf(secret, "- **Key**")).toBe("- **Key** [redacted] (2026-11-04)");

    const removed = applyEdits(M, [{ op: "remove", bulletId: 1, reason: `leaked ${token}` }], TODAY);
    expect(removed.archived).toEqual(["- **Plans**: as files (2026-10-01)\n  - archived 2026-11-04: leaked [redacted]"]);
  });

  test("the line and token limits skip adds only, each add measured after the edits before it", () => {
    const L = "## Memory\n" + Array.from({ length: 148 }, (_, i) => `- b${i}`).join("\n") + "\n";
    expect(L.split("\n").length).toBe(150);
    const addNew: CerebrumEdit = { op: "add", heading: "Memory", bullet: "**New**", proposal: null };
    expect(applyEdits(L, [addNew], TODAY)).toEqual({ md: L, archived: [], skipped: [addNew] });
    const longer = applyEdits(L, [{ op: "replace", bulletId: 1, bullet: "**Longer** text", reason: "r", proposal: null }], TODAY);
    expect(longer.skipped).toEqual([]);
    expect(longer.md.split("\n")[1]).toBe("- **Longer** text (2026-11-04)");

    const T = "## Memory\n- " + "x".repeat(11_940) + "\n";
    expect(T.length).toBe(11_953);
    const addA: CerebrumEdit = { op: "add", heading: "Memory", bullet: "**A** (2026-11-04)", proposal: null };
    const addB: CerebrumEdit = { op: "add", heading: "Memory", bullet: "**B** " + "y".repeat(60) + " (2026-11-04)", proposal: null };
    const result = applyEdits(T, [addA, addB], TODAY);
    expect(result.md.length).toBe(11_974);
    expect(result.md).toContain("\n- **A** (2026-11-04)\n");
    expect(result.skipped).toEqual([addB]);
  });

  test("an add lands after its section's last bullet, or under the ## line when the section has none", () => {
    expect(applyEdits("## User Preferences\n\n## Memory\n",
      [{ op: "add", heading: "user preferences", bullet: "**P**", proposal: null }], TODAY).md)
      .toBe("## User Preferences\n- **P** (2026-11-04)\n\n## Memory\n");
    const lines = applyEdits(M, [{ op: "add", heading: "Memory", bullet: "**Z**", proposal: null }], TODAY).md.split("\n");
    expect(lines[lines.indexOf("- **Deep**: under sub (2026-10-02)") + 1]).toBe("- **Z** (2026-11-04)");
  });
});

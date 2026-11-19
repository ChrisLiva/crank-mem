import { describe, expect, test } from "bun:test";
import {
  composeInjection,
  excerptOf,
  ADR_RECENT_COUNT,
  INDEX_ENTRY_CHARS,
  MEMORY_RECENT_COUNT,
  PREFS_TOKEN_CAP,
} from "../src/hooks/lib/injection.ts";
import { estimateProseTokens } from "../src/hooks/lib/tokens.ts";

const CEREBRUM = `# Cerebrum

## User Preferences

- Prefers pnpm over npm
- Two-space indent

## Memory

${Array.from({ length: 15 }, (_, i) => `- Mistake number ${i}`).join("\n")}
`;

/** No budget pressure — isolates the excerpt's own rules from the byte cap. */
const excerpt = (md: string): string => excerptOf(md, 1_000_000).text;

/** The excerpt's lines from the `### <name>` heading up to the next heading. */
const section = (ex: string, name: string): string[] => {
  const lines = ex.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`### ${name}`));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith("#"));
  return lines.slice(start, end < 0 ? undefined : end);
};

describe("excerptOf", () => {
  test("prefs in full, plus the most recent memory bullets, and every bullet left out is listed after", () => {
    const ex = excerpt(CEREBRUM);
    expect(ex).toContain("Prefers pnpm over npm");
    expect(ex).toContain("Mistake number 14");
    // The newest MEMORY_RECENT_COUNT of 15 bullets stay: 8 through 14.
    const memory = section(ex, "Memory");
    expect(memory).toContain("- Mistake number 8");
    expect(memory).not.toContain("- Mistake number 7");
    expect(section(ex, "Not shown")).toEqual([
      "### Not shown (8 of 17; grep .crank/cerebrum.md)",
      ...Array.from({ length: 8 }, (_, i) => `- Mistake number ${i}`),
    ]);
    // Nothing hidden, no index.
    expect(excerpt("# Cerebrum\n\n## Memory\n\n- only one\n")).not.toContain("Not shown");
  });

  test("an index entry is the bullet's opening words, cut at a word boundary", () => {
    const md =
      "# Cerebrum\n\n## Memory\n\n" +
      "- **Build dir**: fresh worktree configure fails on the SDK\n  headers unless DEVELOPER_DIR is set\n" +
      Array.from({ length: MEMORY_RECENT_COUNT }, (_, i) => `- recent ${i}`).join("\n");
    const [, entry] = section(excerpt(md), "Not shown");
    expect(entry).toBe("- **Build dir**: fresh worktree configure fails on…");
    expect(entry!.length - "- …".length).toBeLessThanOrEqual(INDEX_ENTRY_CHARS);
  });

  test("a cut inside a code span closes the span", () => {
    const md =
      "# Cerebrum\n\n## Memory\n\n" +
      "- `test_fates.test_every_vocabulary_entry_has_a_meaning` is red\n" +
      Array.from({ length: MEMORY_RECENT_COUNT }, (_, i) => `- recent ${i}`).join("\n");
    const [, entry] = section(excerpt(md), "Not shown");
    expect(entry).toBe("- `test_fates.test_every_vocabulary_entry_has_a_me`…");
  });

  test("sub-bullets ride along with the bullet they belong to", () => {
    const ex = excerpt("# Cerebrum\n\n## Memory\n\n- Parent learning\n  - the qualifying detail\n");
    expect(ex).toContain("- Parent learning\n  - the qualifying detail");
  });

  // A misfiled `### Key Learnings` nested inside `## Do-Not-Repeat` must close
  // the bullet above it, not join it or evict the section's first bullet.
  test("a nested heading neither joins a bullet nor appears in the excerpt", () => {
    const ex = excerpt(
      "# Cerebrum\n\n## Do-Not-Repeat\n\n- never run the migration twice\n" +
        "### Key Learnings\n- PIPELINE rounds before FIXTURE does\n",
    );
    expect(ex).toContain("- never run the migration twice");
    expect(ex).toContain("- PIPELINE rounds before FIXTURE does");
    expect(ex).not.toContain("### Key Learnings");
    expect(ex.split("\n").filter((l) => l.startsWith("-"))).toHaveLength(2);
  });

  // The excerpt reads `## Key Learnings`, `## Do-Not-Repeat` and `## Memory` as
  // one section, so an install that predates `## Memory` needs no rewrite.
  test("an unmigrated three-section file injects all three under one Memory label", () => {
    const ex = excerpt(
      "# Cerebrum\n\n## User Preferences\n\n- Prefers pnpm\n\n" +
        "## Key Learnings\n\n- The API rate-limits at 100 rps\n\n" +
        "## Do-Not-Repeat\n\n- Never force-push main\n\n" +
        "## Memory\n\n- Appended after the rename\n",
    );
    expect(ex).toContain("The API rate-limits at 100 rps");
    expect(ex).toContain("Never force-push main");
    expect(ex).toContain("Appended after the rename");
    expect(ex.split("\n")).toContain("### Memory");
    expect(ex).not.toContain("### Key Learnings");
    expect(ex).not.toContain("### Do-Not-Repeat");
    // Document order: an agent appending a fresh `## Memory` at the bottom of
    // an unmigrated file must not have its newest bullets sorted to the front.
    expect(ex.indexOf("rate-limits")).toBeLessThan(ex.indexOf("Appended after the rename"));
  });

  test("sections outside the union are never injected", () => {
    const ex = excerpt(
      "# Cerebrum\n\n## Scratch\n\n- a scratch note\n\n## Memory\n\n- a real one\n",
    );
    expect(ex).toContain("a real one");
    expect(ex).not.toContain("a scratch note");
  });

  test("User Preferences is capped, oldest first", () => {
    const md =
      "# Cerebrum\n\n## User Preferences\n\n" +
      Array.from(
        { length: 30 },
        (_, i) => `- Preference ${i}: ${"spelled out at length ".repeat(5)}`,
      ).join("\n") +
      "\n\n## Memory\n\n- a learning\n";
    const ex = excerpt(md);
    const prefs = section(ex, "User Preferences").filter((l) => l.startsWith("- "));
    expect(estimateProseTokens(prefs.join("\n"))).toBeLessThanOrEqual(PREFS_TOKEN_CAP);
    expect(prefs.join("\n")).toContain("Preference 29:"); // newest survives
    expect(prefs.join("\n")).not.toContain("Preference 0:"); // oldest evicted first
    expect(ex).toContain("a learning"); // prefs never crowd memory out
    // The evicted ones are listed first in the index.
    const index = section(ex, "Not shown");
    expect(ex.split("\n").some((l) => l.startsWith("prefs:"))).toBe(false);
    expect(index[1]).toStartWith("- Preference 0:");
  });

  // Past its allowance the index outranks no bullet, and a preference outranks both.
  test("over budget, an index past its allowance sheds its oldest memory entries before any bullet", () => {
    const md =
      "# Cerebrum\n\n## User Preferences\n\n" +
      Array.from(
        { length: 12 },
        (_, i) => `- Preference ${i}: ${"spelled out at length ".repeat(8)}`,
      ).join("\n") +
      "\n\n## Memory\n\n" +
      Array.from({ length: 30 }, (_, i) => `- Learning ${i}: ${"detail ".repeat(10)}`).join("\n") +
      "\n";
    const full = excerpt(md);
    const ex = excerptOf(md, Buffer.byteLength(full, "utf-8") - 60).text;
    const index = section(ex, "Not shown").join("\n");
    expect(index).not.toContain("Learning 0:");
    expect(index).toContain("Learning 22:");
    expect(index).toContain("- Preference 0:");
    expect(section(ex, "Memory")).toHaveLength(1 + MEMORY_RECENT_COUNT);
    // Every recent memory bullet and every index entry gone, preferences stay.
    const starved = excerptOf(
      md,
      Buffer.byteLength(section(full, "User Preferences").join("\n")) + 200,
    ).text;
    expect(starved).not.toContain("### Memory");
    expect(starved).not.toContain("- Preference 0:");
    expect(starved).toContain("Preference 11:");
    expect(section(starved, "Not shown")[0]).toMatch(
      /^### Not shown \(\d+ of 42; grep \.crank\/cerebrum\.md\)$/,
    );
  });

  test("over budget, the oldest memory bullets go first and are listed in the index", () => {
    const md =
      "# Cerebrum\n\n## Memory\n\n" +
      Array.from({ length: 10 }, (_, i) => `- Learning ${i}: ${"detail ".repeat(30).trim()}`).join(
        "\n",
      ) +
      "\n";
    const ex = excerptOf(md, 900).text;
    expect(Buffer.byteLength(ex, "utf-8")).toBeLessThanOrEqual(900);
    const memory = section(ex, "Memory").slice(1);
    expect(memory.at(-1)).toStartWith("- Learning 9:");
    expect(memory.join("\n")).not.toContain("Learning 0:");
    // Whole bullets only — a trim never cuts one mid-sentence.
    for (const line of memory) expect(line).toEndWith("detail");
    const index = section(ex, "Not shown");
    expect(index[0]).toBe(`### Not shown (${10 - memory.length} of 10; grep .crank/cerebrum.md)`);
    expect(index.slice(1)).toHaveLength(10 - memory.length);
    expect(index[1]).toStartWith("- Learning 0:");
    // A budget too small for even one bullet yields nothing rather than a fragment.
    expect(excerptOf(CEREBRUM, 10).text).toBe("");
  });
});

describe("composeInjection", () => {
  const sources = {
    cerebrumMd: CEREBRUM,
    adrFilenames: Array.from(
      { length: 25 },
      (_, i) => `${String(i + 1).padStart(4, "0")}-decision-${i + 1}.md`,
    ),
    graph: { files: 30, pending: 0, gaps: [] as string[] },
    adrPath: "docs/adr",
  };

  test("caps ADR list at most recent 20", () => {
    const out = composeInjection(sources, 8192).text;
    expect(out).toContain("0025-decision-25.md");
    expect(out).toContain("0006-decision-6.md");
    expect(out).not.toContain("0005-decision-5.md");
    expect((out.match(/^- \d{4}-/gm) ?? []).length).toBe(ADR_RECENT_COUNT);
  });

  test("the pointer adds the parsing clause, then the gap clause for the three biggest gaps", () => {
    const graph = { files: 9, pending: 4, gaps: [".lua", ".dart", ".zig", ".sql"] };
    const out = composeInjection({ ...sources, graph }, 8192).text;
    expect(out).toContain(
      "symbol line ranges (symbols for 4 files are still being parsed) (no symbol ranges for .lua, .dart, .zig files); use it before",
    );
    expect(out).not.toContain(".sql");
    const settled = composeInjection(sources, 8192).text;
    expect(settled).not.toContain("still being parsed");
    expect(settled).not.toContain("no symbol ranges");
  });

  test("the drift note sits below the staleness note", () => {
    const out = composeInjection(
      {
        ...sources,
        notes: [
          "index refresh skipped (lock busy)",
          "crank-mem hooks are at 0.3.2, crank-mem is at 0.5.0 — run `crank-mem upgrade`.",
        ],
      },
      8192,
    ).text;
    expect(out).toContain(
      "_Note: crank-mem hooks are at 0.3.2, crank-mem is at 0.5.0 — run `crank-mem upgrade`._",
    );
    expect(out).toContain("index refresh skipped");
    expect(out.indexOf("refresh skipped")).toBeLessThan(out.indexOf("hooks are at 0.3.2"));
    expect(out.indexOf("hooks are at 0.3.2")).toBeLessThan(out.indexOf("## Cerebrum"));
  });

  // Bytes are the budget that binds: Claude Code caps additionalContext characters, not tokens.
  describe("byte budget", () => {
    // This cerebrum of about 9 KB of wrapped bullets, 5 preferences and 11 memory
    // bullets, is big enough that the byte budget binds before the token cap.
    const wrapped = (label: string, n: number, lines: number): string =>
      Array.from(
        { length: n },
        (_, i) =>
          `- ${label} ${i}: ` +
          Array.from(
            { length: lines },
            (_, l) => `${"a reasonably wordy clause carrying real detail ".repeat(2)}${l}`,
          ).join("\n  "),
      ).join("\n");
    const fat = {
      ...sources,
      cerebrumMd:
        `# Cerebrum\n\n## User Preferences\n\n${wrapped("Preference", 5, 3)}\n\n` +
        `## Memory\n\n${wrapped("Learning", 11, 7)}\n`,
    };

    test("the ADR section survives a full cerebrum", () => {
      // The fixture must be big enough that bytes, not the token cap, bind; otherwise the
      // ceiling below would pass without the byte trim ever running.
      const size = Buffer.byteLength(fat.cerebrumMd, "utf-8");
      expect(size).toBeGreaterThan(9_000);
      expect(size).toBeLessThan(10_000);
      const free =
        8192 -
        Buffer.byteLength(composeInjection({ ...fat, cerebrumMd: null }, 8192).text, "utf-8");
      expect(estimateProseTokens(excerptOf(fat.cerebrumMd, free).text)).toBeLessThan(1500);

      const out = composeInjection(fat, 8192).text;
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(8192);
      expect(out).toContain("## ADRs");
      expect(out).toContain("0025-decision-25.md");
      expect(out).toContain("## Cerebrum");
      expect(out).toContain("Learning 10:"); // the newest memory bullet
    });

    test("a section that cannot fit is dropped, not truncated mid-way", () => {
      const out = composeInjection(sources, 1200).text;
      expect(out).toContain("crank-mem (project memory)");
      expect(out).not.toContain("## ADRs"); // dropped whole — no half-list
    });

    // The ADR reservation must not hold back bytes it cannot spend: an ADR list
    // too long to fit is dropped anyway, and reserving for it would take the
    // cerebrum down with it.
    test("a budget too tight for the ADRs still spends it on the cerebrum", () => {
      const out = composeInjection(sources, 1230).text;
      expect(out).not.toContain("## ADRs");
      expect(out).toContain("## Cerebrum");
      expect(out).toContain("Mistake number 14");
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(1230);
    });
  });

  test("no cerebrum / no ADRs still yields instructions and the pointer", () => {
    const out = composeInjection(
      {
        cerebrumMd: null,
        adrFilenames: [],
        graph: { files: 3, pending: 0, gaps: [] },
        adrPath: "docs/adr",
      },
      8192,
    ).text;
    expect(out).toContain("crank-mem (project memory)");
    expect(out).toContain("`crank-mem anatomy [<dir>]` lists the project's 3 file(s)");
    expect(out).not.toContain("## Cerebrum");
    expect(out).not.toContain("## ADRs");
  });
});

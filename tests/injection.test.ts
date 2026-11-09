import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  composeInjection,
  excerptOf,
  subagentInjection,
  ADR_RECENT_COUNT,
  CODE_BULLET,
  INDEX_ENTRY_CHARS,
  INJECTION_HEADING,
  MEMORY_RECENT_COUNT,
  PREFS_TOKEN_CAP,
  RECALL_BULLET,
} from "../src/hooks/lib/injection.ts";
import { loadConfig } from "../src/hooks/lib/config.ts";
import { makeCrankProject, seedMemory } from "./helpers.ts";
import { emptyIndex, type AnatomyIndex } from "../src/hooks/lib/store.ts";
import { estimateProseTokens } from "../src/hooks/lib/tokens.ts";

function fixtureIndex(fileCount: number): AnatomyIndex {
  const idx = emptyIndex();
  for (let i = 0; i < fileCount; i++) {
    idx.files[`src/dir${i % 5}/file${i}.ts`] = {
      description: `Module ${i} that does a reasonably descriptive thing`,
      tokens: 100 + i,
      size: 400,
      mtimeMs: 1,
      symbols: [{ name: `f${i}`, kind: "fn", startLine: 1, endLine: 10, tokens: 90 }],
    };
  }
  idx.meta.fileCount = fileCount;
  return idx;
}

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
  test("prefs in full, plus the most recent memory bullets", () => {
    const ex = excerpt(CEREBRUM);
    expect(ex).toContain("Prefers pnpm over npm");
    expect(ex).toContain("Mistake number 14");
    const memory = section(ex, "Memory");
    expect(memory).toContain(`- Mistake number ${15 - MEMORY_RECENT_COUNT}`);
    expect(memory).not.toContain(`- Mistake number ${15 - MEMORY_RECENT_COUNT - 1}`);
  });

  test("every bullet the excerpt leaves out is listed after it", () => {
    const ex = excerpt(CEREBRUM);
    const hidden = 15 - MEMORY_RECENT_COUNT;
    expect(section(ex, "Not shown")).toEqual([
      `### Not shown (${hidden} of 17; grep .crank/cerebrum.md)`,
      ...Array.from({ length: hidden }, (_, i) => `- Mistake number ${i}`),
    ]);
  });

  test("nothing hidden, no index", () => {
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

  test("empty template yields empty excerpt", () => {
    expect(excerpt("# Cerebrum\n\n## User Preferences\n\n## Memory\n")).toBe("");
  });

  // The protocol asks for prose bullets, which wrap, so the excerpt keeps every
  // physical line of a bullet.
  test("a bullet spanning several physical lines arrives whole", () => {
    const ex = excerpt(
      "# Cerebrum\n\n## Memory\n\n" +
        "- The blur dies when the container gets `position: fixed` or above a\n" +
        "  z-index of 10 — it becomes a backdrop root, killing the overlay blur.\n",
    );
    expect(ex).toContain("z-index of 10 — it becomes a backdrop root, killing the overlay blur.");
    expect(ex).toContain(
      "- The blur dies when the container gets `position: fixed` or above a\n" +
        "  z-index of 10 — it becomes a backdrop root, killing the overlay blur.",
    );
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
  });

  test("a budget too small for even one bullet yields nothing rather than a fragment", () => {
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
    index: fixtureIndex(30),
    adrPath: "docs/adr",
  };

  test("contains all sections in order", () => {
    const out = composeInjection(sources, 8192).text;
    const iInstr = out.indexOf("crank-mem (project memory)");
    const iCer = out.indexOf("## Cerebrum");
    const iAdr = out.indexOf("## ADRs");
    expect(iInstr).toBeGreaterThanOrEqual(0);
    expect(iCer).toBeGreaterThan(iInstr);
    expect(iAdr).toBeGreaterThan(iCer);
  });

  test("caps ADR list at most recent 20", () => {
    const out = composeInjection(sources, 8192).text;
    expect(out).toContain("0025-decision-25.md");
    expect(out).toContain("0006-decision-6.md");
    expect(out).not.toContain("0005-decision-5.md");
    expect((out.match(/^- \d{4}-/gm) ?? []).length).toBe(ADR_RECENT_COUNT);
  });

  test("points at anatomy.md with a file count instead of listing files", () => {
    const out = composeInjection({ ...sources, index: fixtureIndex(200) }, 8192).text;
    expect(out).toContain("`.crank/anatomy.md` indexes 200 file(s)");
    expect(out).toContain("That is every indexable file in the project.");
    expect(out).toContain("symbol line ranges before slice-reading a large");
    // The map itself must not be recited — no indexed filename, no token annotation.
    expect(out).not.toContain("file7.ts");
    expect(out).not.toMatch(/~\d+ tok/);
  });

  // The reason the map is a pointer: Claude Code swaps an injection past 10,000
  // characters of additionalContext for a 2,000-character preview (ADR 0005),
  // so size must not track file count.
  test("stays small and near-constant as the project grows", () => {
    const small = composeInjection({ ...sources, index: fixtureIndex(3) }, 8192).text;
    const large = composeInjection({ ...sources, index: fixtureIndex(5000) }, 8192).text;
    expect(Buffer.byteLength(large, "utf-8")).toBeLessThan(4096);
    expect(Buffer.byteLength(large) - Buffer.byteLength(small)).toBeLessThan(64);
  });

  test("symbols never appear in injection", () => {
    const out = composeInjection(sources, 8192).text;
    expect(out).not.toContain("(fn, L");
  });

  test("staleness note is included when set", () => {
    const out = composeInjection(
      { ...sources, stalenessNote: "index refresh skipped (lock busy)" },
      8192,
    ).text;
    expect(out).toContain("index refresh skipped");
  });

  test("the drift note sits directly below the staleness note", () => {
    const out = composeInjection(
      {
        ...sources,
        stalenessNote: "index refresh skipped (lock busy)",
        driftNote: "crank-mem hooks are at 0.3.2, clone is at 0.5.0 — run `crank-mem upgrade`.",
      },
      8192,
    ).text;
    expect(out).toContain(
      "_Note: crank-mem hooks are at 0.3.2, clone is at 0.5.0 — run `crank-mem upgrade`._",
    );
    expect(out.indexOf("refresh skipped")).toBeLessThan(out.indexOf("hooks are at 0.3.2"));
    expect(out.indexOf("hooks are at 0.3.2")).toBeLessThan(out.indexOf("## Cerebrum"));
  });

  // Bytes are the budget that binds: Claude Code caps additionalContext characters, not tokens.
  describe("byte budget", () => {
    // This 9,264-byte cerebrum of wrapped bullets, 5 preferences and 11 memory
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

    test("the fixture is big enough that bytes, not the token cap, bind", () => {
      const size = Buffer.byteLength(fat.cerebrumMd, "utf-8");
      expect(size).toBeGreaterThan(9_000);
      expect(size).toBeLessThan(10_000);
      // Big enough that bytes, not the token cap, are what bind — otherwise the
      // ceiling below would pass without the byte trim ever running.
      const free =
        8192 -
        Buffer.byteLength(composeInjection({ ...fat, cerebrumMd: null }, 8192).text, "utf-8");
      expect(estimateProseTokens(excerptOf(fat.cerebrumMd, free).text)).toBeLessThan(1500);
    });

    test("a full cerebrum stays inside the byte budget", () => {
      const out = composeInjection(fat, 8192).text;
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(8192);
    });

    test("the ADR section survives a full cerebrum", () => {
      const out = composeInjection(fat, 8192).text;
      expect(out).toContain("## ADRs");
      expect(out).toContain("0025-decision-25.md");
      expect(out).toContain("## Cerebrum");
      expect(out).toContain("Learning 10:"); // the newest memory bullet
    });

    // Under real pressure the whole excerpt gives way in one direction: oldest
    // memory first, and only once memory is gone does the oldest preference
    // go. A user-stated preference outranks anything the agent inferred.
    test("a starved budget sheds memory before preferences, oldest first", () => {
      const out = composeInjection(fat, 2560).text;
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(2560);
      expect(out).toContain("Preference 4:"); // newest preference survives
      expect(out).not.toContain("Preference 0:"); // oldest goes first
      expect(out).not.toContain("### Memory"); // memory yields entirely before prefs do
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

    test("instructions survive a budget too small to hold them", () => {
      const out = composeInjection(sources, 10).text;
      expect(out).toContain("symbol line ranges before slice-reading a large");
    });
  });

  test("no cerebrum / no ADRs still yields instructions and the pointer", () => {
    const out = composeInjection(
      { cerebrumMd: null, adrFilenames: [], index: fixtureIndex(3), adrPath: "docs/adr" },
      8192,
    ).text;
    expect(out).toContain("crank-mem (project memory)");
    expect(out).toContain("`.crank/anatomy.md` indexes 3 file(s)");
    expect(out).not.toContain("## Cerebrum");
    expect(out).not.toContain("## ADRs");
  });
});

describe("subagentInjection", () => {
  test("a balanced 2 KB excerpt carries memory under the label and the code pointer, then degrades to the pointers", () => {
    const root = makeCrankProject();
    const crankDir = path.join(root, ".crank");
    const clause = "`Support.cpp` caps pillar reach at 3.7 mm, so retries from the head fail ";
    const bullet = (s: string, i: number): string =>
      `- **${s} ${i}**: ${clause.repeat(4).trim()} (2026-09-${10 + i}).`;
    const prefs = Array.from({ length: 7 }, (_, i) => bullet("Pref", i));
    const memory = Array.from({ length: 21 }, (_, i) => bullet("Gotcha", i));
    const md = `# Cerebrum\n\n## User Preferences\n${prefs.join("\n")}\n\n## Memory\n${memory.join("\n")}\n`;
    const cerebrum = path.join(crankDir, "cerebrum.md");
    fs.writeFileSync(cerebrum, md);
    const run = () =>
      subagentInjection(root, crankDir, loadConfig(crankDir), { agentType: "Explore" });

    const { text, usage } = run();
    const excerpt = text.slice(text.indexOf("\n\n") + 2);
    expect(Buffer.byteLength(excerpt, "utf-8")).toBeLessThanOrEqual(2048);
    expect(excerpt).toMatch(/^### Memory\n- /m);
    // Unbalanced, the same budget spends every byte on preferences.
    expect(excerptOf(md, 2048).text).not.toMatch(/^### Memory$/m);
    expect(text.split("\n").slice(0, 3)).toEqual([
      INJECTION_HEADING,
      "- Excerpt of `.crank/cerebrum.md`, this project's memory; grep it for more. Memory is not proof: verify a claim against the cited file before relying on it.",
      CODE_BULLET,
    ]);
    expect(text.includes(RECALL_BULLET)).toBe(false);
    expect(usage).toEqual({
      channel: "subagent-start",
      agentType: "Explore",
      excerptBytes: Buffer.byteLength(excerpt, "utf-8"),
      recallPointer: false,
    });

    const bare: ReturnType<typeof subagentInjection> = {
      text: `${INJECTION_HEADING}\n${CODE_BULLET}`,
      usage: {
        channel: "subagent-start",
        agentType: "Explore",
        excerptBytes: 0,
        recallPointer: false,
      },
    };
    fs.rmSync(cerebrum);
    expect(run()).toEqual(bare);
    fs.mkdirSync(cerebrum); // the read now fails with EISDIR
    expect(run()).toEqual(bare);

    seedMemory(root, [{ title: "a stored observation" }]);
    const recalled = run();
    expect(recalled.text).toBe(`${INJECTION_HEADING}\n${CODE_BULLET}\n${RECALL_BULLET}`);
    expect(recalled.usage.recallPointer).toBe(true);
  });
});

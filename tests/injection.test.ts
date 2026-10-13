import { describe, expect, test } from "bun:test";
import {
  buildInjection, cerebrumExcerpt, ADR_RECENT_COUNT, INDEX_ENTRY_CHARS, MEMORY_RECENT_COUNT, PREFS_TOKEN_CAP,
} from "../src/hooks/lib/injection.ts";
import { emptyIndex, type AnatomyIndex } from "../src/hooks/lib/store.ts";
import { estimateProseTokens } from "../src/hooks/lib/tokens.ts";

function fixtureIndex(fileCount: number): AnatomyIndex {
  const idx = emptyIndex();
  for (let i = 0; i < fileCount; i++) {
    idx.files[`src/dir${i % 5}/file${i}.ts`] = {
      description: `Module ${i} that does a reasonably descriptive thing`,
      tokens: 100 + i, size: 400, mtimeMs: 1,
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
const excerpt = (md: string): string => cerebrumExcerpt(md, 1_000_000);

/** The excerpt's lines from the `### <name>` heading up to the next heading. */
const section = (ex: string, name: string): string[] => {
  const lines = ex.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`### ${name}`));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith("#"));
  return lines.slice(start, end < 0 ? undefined : end);
};

describe("cerebrumExcerpt", () => {
  test("prefs in full, plus the most recent memory bullets", () => {
    const ex = excerpt(CEREBRUM);
    expect(ex).toContain("Prefers pnpm over npm");
    expect(ex).toContain("Mistake number 14");
    const memory = section(ex, "Memory");
    expect(memory).toContain(`- Mistake number ${15 - MEMORY_RECENT_COUNT}`);
    expect(memory).not.toContain(`- Mistake number ${15 - MEMORY_RECENT_COUNT - 1}`);
  });

  // A warning that rotated out of the recency slice used to vanish from every
  // later session while still in the file; now it is listed by its first words.
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

  // The defect this whole change exists to fix: `injection.ts` asks agents for
  // prose bullets, and every well-formed one wraps — so keeping only the first
  // physical line delivered a fragment and dropped the payload.
  test("a bullet spanning several physical lines arrives whole", () => {
    const ex = excerpt(
      "# Cerebrum\n\n## Memory\n\n" +
        "- The blur dies when the container gets `position: fixed` or above a\n" +
        "  z-index of 10 — it becomes a backdrop root, killing the overlay blur.\n"
    );
    expect(ex).toContain("z-index of 10 — it becomes a backdrop root, killing the overlay blur.");
    expect(ex).toContain(
      "- The blur dies when the container gets `position: fixed` or above a\n" +
        "  z-index of 10 — it becomes a backdrop root, killing the overlay blur."
    );
  });

  test("sub-bullets ride along with the bullet they belong to", () => {
    const ex = excerpt("# Cerebrum\n\n## Memory\n\n- Parent learning\n  - the qualifying detail\n");
    expect(ex).toContain("- Parent learning\n  - the qualifying detail");
  });

  // A misfiled `### Key Learnings` nested inside `## Do-Not-Repeat` is real
  // (takeoff-poc); under a line filter it evicted the section's first bullet.
  test("a nested heading neither joins a bullet nor appears in the excerpt", () => {
    const ex = excerpt(
      "# Cerebrum\n\n## Do-Not-Repeat\n\n- never run the migration twice\n" +
        "### Key Learnings\n- PIPELINE rounds before FIXTURE does\n"
    );
    expect(ex).toContain("- never run the migration twice");
    expect(ex).toContain("- PIPELINE rounds before FIXTURE does");
    expect(ex).not.toContain("### Key Learnings");
    expect(ex.split("\n").filter((l) => l.startsWith("-"))).toHaveLength(2);
  });

  // No cerebrum is rewritten by this change: the excerpt reads the union
  // instead, so an install that predates `## Memory` keeps working.
  test("an unmigrated three-section file injects all three under one Memory label", () => {
    const ex = excerpt(
      "# Cerebrum\n\n## User Preferences\n\n- Prefers pnpm\n\n" +
        "## Key Learnings\n\n- The API rate-limits at 100 rps\n\n" +
        "## Do-Not-Repeat\n\n- Never force-push main\n\n" +
        "## Memory\n\n- Appended after the rename\n"
    );
    expect(ex).toContain("The API rate-limits at 100 rps");
    expect(ex).toContain("Never force-push main");
    expect(ex).toContain("Appended after the rename");
    // The label names the last memory heading, where an append lands newest-last.
    expect(ex).toContain("### Memory (in file: ## Memory, append at its end)");
    expect(ex).not.toContain("### Key Learnings");
    expect(ex).not.toContain("### Do-Not-Repeat");
    // Document order: an agent appending a fresh `## Memory` at the bottom of
    // an unmigrated file must not have its newest bullets sorted to the front.
    expect(ex.indexOf("rate-limits")).toBeLessThan(ex.indexOf("Appended after the rename"));
  });

  // Agents anchor edits on the label: a label naming a heading the file lacks
  // sent 9 audited edits to a missing anchor, and one learning was lost.
  test("labels name the file's literal headings, not the canonical ones", () => {
    const ex = excerpt(
      "# Cerebrum\n\n## user preferences\n\n- Prefers pnpm\n\n" +
        "## Key Learnings\n\n- The API rate-limits at 100 rps\n\n" +
        "## Do-Not-Repeat\n\n- Never force-push main\n"
    );
    expect(ex).toContain("### User Preferences (in file: ## user preferences, append at its end)");
    expect(ex).toContain("### Memory (in file: ## Do-Not-Repeat, append at its end)");
    expect(ex).not.toContain("## Memory,");
  });

  test("sections outside the union are never injected", () => {
    const ex = excerpt("# Cerebrum\n\n## Scratch\n\n- a scratch note\n\n## Memory\n\n- a real one\n");
    expect(ex).toContain("a real one");
    expect(ex).not.toContain("a scratch note");
  });

  test("User Preferences is capped, oldest first", () => {
    const md =
      "# Cerebrum\n\n## User Preferences\n\n" +
      Array.from({ length: 30 }, (_, i) => `- Preference ${i}: ${"spelled out at length ".repeat(5)}`).join("\n") +
      "\n\n## Memory\n\n- a learning\n";
    const ex = excerpt(md);
    const prefs = section(ex, "User Preferences").filter((l) => l.startsWith("- "));
    expect(estimateProseTokens(prefs.join("\n"))).toBeLessThanOrEqual(PREFS_TOKEN_CAP);
    expect(prefs.join("\n")).toContain("Preference 29:"); // newest survives
    expect(prefs.join("\n")).not.toContain("Preference 0:"); // oldest evicted first
    expect(ex).toContain("a learning"); // prefs never crowd memory out
    // The evicted ones are listed first in the index, with a nudge to merge them.
    const index = section(ex, "Not shown");
    expect(index[1]).toBe(`prefs: ${prefs.length} of 30 shown, consolidate`);
    expect(index[2]).toStartWith("- Preference 0:");
  });

  // Recent bullets outrank the index, and a preference outranks both.
  test("over budget, the index sheds its oldest memory entries before any bullet", () => {
    const md =
      "# Cerebrum\n\n## User Preferences\n\n" +
      Array.from({ length: 12 }, (_, i) => `- Preference ${i}: ${"spelled out at length ".repeat(8)}`).join("\n") +
      "\n\n## Memory\n\n" +
      Array.from({ length: 12 }, (_, i) => `- Learning ${i}: ${"detail ".repeat(10)}`).join("\n") +
      "\n";
    const full = excerpt(md);
    const ex = cerebrumExcerpt(md, Buffer.byteLength(full, "utf-8") - 60);
    const index = section(ex, "Not shown").join("\n");
    expect(index).not.toContain("Learning 0:");
    expect(index).toContain("Learning 4:");
    expect(index).toContain("- Preference 0:");
    expect(section(ex, "Memory")).toHaveLength(1 + MEMORY_RECENT_COUNT);
    // Every recent memory bullet and every index entry gone, preferences stay.
    const starved = cerebrumExcerpt(md, Buffer.byteLength(section(full, "User Preferences").join("\n")) + 200);
    expect(starved).not.toContain("### Memory");
    expect(starved).not.toContain("- Preference 0:");
    expect(starved).toContain("Preference 11:");
    expect(section(starved, "Not shown")[0]).toMatch(/^### Not shown \(\d+ of 24; grep \.crank\/cerebrum\.md\)$/);
  });

  test("over budget, the oldest memory bullets go first", () => {
    const md =
      "# Cerebrum\n\n## Memory\n\n" +
      Array.from({ length: 10 }, (_, i) => `- Learning ${i}: ${"detail ".repeat(30)}`).join("\n") +
      "\n";
    const ex = cerebrumExcerpt(md, 900);
    expect(Buffer.byteLength(ex, "utf-8")).toBeLessThanOrEqual(900);
    expect(ex).toContain("Learning 9:");
    expect(ex).not.toContain("Learning 0:");
    // Whole bullets only — a trim never cuts one mid-sentence.
    expect(ex.endsWith("…")).toBe(false);
  });

  test("a budget too small for even one bullet yields nothing rather than a fragment", () => {
    expect(cerebrumExcerpt(CEREBRUM, 10)).toBe("");
  });
});

describe("buildInjection", () => {
  const sources = {
    cerebrumMd: CEREBRUM,
    adrFilenames: Array.from({ length: 25 }, (_, i) => `${String(i + 1).padStart(4, "0")}-decision-${i + 1}.md`),
    index: fixtureIndex(30),
    adrPath: "docs/adr",
  };

  test("contains all sections in order", () => {
    const out = buildInjection(sources, 8192);
    const iInstr = out.indexOf("crank-mem (project memory)");
    const iCer = out.indexOf("## Cerebrum");
    const iAdr = out.indexOf("## ADRs");
    expect(iInstr).toBeGreaterThanOrEqual(0);
    expect(iCer).toBeGreaterThan(iInstr);
    expect(iAdr).toBeGreaterThan(iCer);
  });

  test("caps ADR list at most recent 20", () => {
    const out = buildInjection(sources, 8192);
    expect(out).toContain("0025-decision-25.md");
    expect(out).toContain("0006-decision-6.md");
    expect(out).not.toContain("0005-decision-5.md");
    expect((out.match(/^- \d{4}-/gm) ?? []).length).toBe(ADR_RECENT_COUNT);
  });

  test("points at anatomy.md with a file count instead of listing files", () => {
    const out = buildInjection({ ...sources, index: fixtureIndex(200) }, 8192);
    expect(out).toContain("`.crank/anatomy.md` indexes 200 file(s)");
    expect(out).toContain("That is every indexable file in the project.");
    expect(out).toContain("symbol line ranges before slice-reading a large");
    // The map itself must not be recited — no indexed filename, no token annotation.
    expect(out).not.toContain("file7.ts");
    expect(out).not.toMatch(/~\d+ tok/);
  });

  // The reason the map is a pointer: Claude Code swaps the whole injection for
  // a 2KB preview past ~10KiB of hook stdout (ADR 0005), so size must not
  // track file count.
  test("stays small and near-constant as the project grows", () => {
    const small = buildInjection({ ...sources, index: fixtureIndex(3) }, 8192);
    const large = buildInjection({ ...sources, index: fixtureIndex(5000) }, 8192);
    expect(Buffer.byteLength(large, "utf-8")).toBeLessThan(4096);
    expect(Buffer.byteLength(large) - Buffer.byteLength(small)).toBeLessThan(64);
  });

  test("symbols never appear in injection", () => {
    const out = buildInjection(sources, 8192);
    expect(out).not.toContain("(fn, L");
  });

  test("instructions route memory writes to the two canonical sections", () => {
    const out = buildInjection(sources, 8192);
    expect(out).toContain("Cerebrum protocol");
    expect(out).toContain("`## User Preferences`");
    expect(out).toContain("`## Memory`");
    expect(out).toContain("Do NOT record");
    expect(out).not.toContain("Key Learnings"); // the protocol names one target
    expect(out).toContain("append new bullets at the end of the section, newest last");
  });

  test("instructions carry the journal protocol and the telegraphic style rule", () => {
    const out = buildInjection(sources, 8192);
    expect(out).toContain("Journal protocol");
    expect(out).toContain("- YYYY-MM-DD: what you did; where you left off; NEXT: next step");
    expect(out).toContain("shown what the last three entries did, plus the newest one's");
    expect(out).toContain("put the handoff there, last");
    expect(out).toContain("telegram-style");
    expect(out).toContain("Keep each\n  cerebrum bullet to about 200 characters at most");
    expect(out).toContain("start it with a short\n  **subject**");
  });

  test("journal sits between the staleness note and the cerebrum", () => {
    const out = buildInjection(
      { ...sources, stalenessNote: "index refresh skipped (lock busy)", journalBullets: ["- 2026-07-29 — NEXT: wire the trim"] },
      8192
    );
    expect(out.indexOf("refresh skipped")).toBeLessThan(out.indexOf("## Journal"));
    expect(out.indexOf("## Journal")).toBeLessThan(out.indexOf("## Cerebrum"));
    expect(out).toContain("- 2026-07-29 — NEXT: wire the trim");
  });

  test("staleness note is included when set", () => {
    const out = buildInjection({ ...sources, stalenessNote: "index refresh skipped (lock busy)" }, 8192);
    expect(out).toContain("index refresh skipped");
  });

  test("the drift note sits directly below the staleness note", () => {
    const out = buildInjection(
      {
        ...sources,
        stalenessNote: "index refresh skipped (lock busy)",
        driftNote: "crank-mem hooks are at 0.3.2, clone is at 0.5.0 — run `crank-mem upgrade`.",
      },
      8192
    );
    expect(out).toContain("_Note: crank-mem hooks are at 0.3.2, clone is at 0.5.0 — run `crank-mem upgrade`._");
    expect(out.indexOf("refresh skipped")).toBeLessThan(out.indexOf("hooks are at 0.3.2"));
    expect(out.indexOf("hooks are at 0.3.2")).toBeLessThan(out.indexOf("## Cerebrum"));
  });

  // Bytes are the budget that binds: Claude Code caps hook stdout, not tokens.
  describe("byte budget", () => {
    // Shaped after the real takeoff-poc cerebrum: ~9.5KB, 5 wrapped preference
    // bullets, 11 wrapped memory bullets. Whole bullets more than doubled the
    // excerpt's cost, which is exactly what could re-open the truncation cliff.
    const wrapped = (label: string, n: number, lines: number): string =>
      Array.from({ length: n }, (_, i) =>
        `- ${label} ${i}: ` +
        Array.from({ length: lines }, (_, l) =>
          `${"a reasonably wordy clause carrying real detail ".repeat(2)}${l}`
        ).join("\n  ")
      ).join("\n");
    const fat = {
      ...sources,
      journalBullets: [
        "- 2026-07-28 — NEXT: finish the excerpt rewrite",
        "- 2026-07-29 — …tests green, tree clean at 41980e5.",
        "- 2026-07-30 — NEXT: probe both live installs after the bump",
      ],
      cerebrumMd:
        `# Cerebrum\n\n## User Preferences\n\n${wrapped("Preference", 5, 3)}\n\n` +
        `## Memory\n\n${wrapped("Learning", 11, 7)}\n`,
    };

    test("the fixture really is takeoff-poc-shaped", () => {
      const size = Buffer.byteLength(fat.cerebrumMd, "utf-8");
      expect(size).toBeGreaterThan(9_000);
      expect(size).toBeLessThan(10_000);
      // Big enough that bytes, not the token cap, are what bind — otherwise the
      // ceiling below would pass without the byte trim ever running.
      const free = 8192 - Buffer.byteLength(buildInjection({ ...fat, cerebrumMd: null }, 8192), "utf-8");
      expect(estimateProseTokens(cerebrumExcerpt(fat.cerebrumMd, free))).toBeLessThan(1500);
    });

    test("a full cerebrum stays inside the byte budget", () => {
      const out = buildInjection(fat, 8192);
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(8192);
    });

    test("the ADR section survives a full cerebrum", () => {
      const out = buildInjection(fat, 8192);
      expect(out).toContain("## ADRs");
      expect(out).toContain("0025-decision-25.md");
      expect(out).toContain("## Cerebrum");
      expect(out).toContain("Learning 10:"); // the newest memory bullet
    });

    // Under real pressure the whole excerpt gives way in one direction: oldest
    // memory first, and only once memory is gone does the oldest preference
    // go. A user-stated preference outranks anything the agent inferred.
    test("a starved budget sheds memory before preferences, oldest first", () => {
      const out = buildInjection(fat, 4096);
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(4096);
      expect(out).toContain("Preference 4:"); // newest preference survives
      expect(out).not.toContain("Preference 0:"); // oldest goes first
      expect(out).not.toContain("### Memory"); // memory yields entirely before prefs do
    });

    test("a section that cannot fit is dropped, not truncated mid-way", () => {
      const out = buildInjection(sources, 2200);
      expect(out).toContain("crank-mem (project memory)");
      expect(out).not.toContain("## ADRs"); // dropped whole — no half-list
    });

    // The ADR reservation must not hold back bytes it cannot spend: an ADR list
    // too long to fit is dropped anyway, and reserving for it would take the
    // cerebrum down with it.
    test("a budget too tight for the ADRs still spends it on the cerebrum", () => {
      const out = buildInjection(sources, 2970);
      expect(out).not.toContain("## ADRs");
      expect(out).toContain("## Cerebrum");
      expect(out).toContain("Mistake number 14");
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(2970);
    });

    test("instructions survive a budget too small to hold them", () => {
      const out = buildInjection(sources, 10);
      expect(out).toContain("symbol line ranges before slice-reading a large");
      expect(out).toContain("Cerebrum protocol");
    });
  });

  test("no cerebrum / no ADRs still yields instructions and the pointer", () => {
    const out = buildInjection({ cerebrumMd: null, adrFilenames: [], index: fixtureIndex(3), adrPath: "docs/adr" }, 8192);
    expect(out).toContain("crank-mem (project memory)");
    expect(out).toContain("`.crank/anatomy.md` indexes 3 file(s)");
    expect(out).not.toContain("## Cerebrum");
    expect(out).not.toContain("## ADRs");
  });
});

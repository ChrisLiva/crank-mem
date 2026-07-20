import { describe, expect, test } from "bun:test";
import { buildInjection, cerebrumExcerpt, ADR_RECENT_COUNT } from "../src/hooks/lib/injection.ts";
import { emptyIndex, type AnatomyIndex } from "../src/hooks/lib/store.ts";
import { estimateProseTokens } from "../src/hooks/lib/tokens.ts";

function fixtureIndex(fileCount: number): AnatomyIndex {
  const idx = emptyIndex();
  for (let i = 0; i < fileCount; i++) {
    idx.files[`src/dir${i % 5}/file${i}.ts`] = {
      description: `Module ${i} that does a reasonably descriptive thing`,
      tokens: 100 + i, size: 400, mtimeMs: 1, updatedAt: "2026-07-16T00:00:00Z", source: "scan",
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

## Key Learnings

- The API rate-limits at 100 rps

## Do-Not-Repeat

${Array.from({ length: 15 }, (_, i) => `- Mistake number ${i}`).join("\n")}
`;

describe("cerebrumExcerpt", () => {
  test("includes prefs in full and last 10 do-not-repeat only", () => {
    const ex = cerebrumExcerpt(CEREBRUM);
    expect(ex).toContain("Prefers pnpm over npm");
    expect(ex).toContain("Mistake number 14");
    expect(ex).toContain("Mistake number 5");
    expect(ex).not.toContain("Mistake number 4");
    expect(ex).not.toContain("rate-limits"); // Key Learnings not injected
  });
  test("empty template yields empty excerpt", () => {
    expect(cerebrumExcerpt("# Cerebrum\n\n## User Preferences\n\n## Key Learnings\n\n## Do-Not-Repeat\n")).toBe("");
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
    expect(out).toContain("check it before reading any file");
    // The map itself must not be recited — no indexed filename, no token annotation.
    expect(out).not.toContain("file7.ts");
    expect(out).not.toMatch(/~\d+ tok/);
  });

  // The reason the map is a pointer: Claude Code swaps the whole injection for
  // a 2KB preview past ~10KiB of hook stdout, so size must not track file count.
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

  test("staleness note is included when set", () => {
    const out = buildInjection({ ...sources, stalenessNote: "index refresh skipped (lock busy)" }, 8192);
    expect(out).toContain("index refresh skipped");
  });

  // Bytes are the budget that binds: Claude Code caps hook stdout, not tokens.
  describe("byte budget", () => {
    const big = {
      ...sources,
      cerebrumMd: `# Cerebrum\n\n## User Preferences\n\n${Array.from(
        { length: 400 },
        (_, i) => `- Preference number ${i} spelled out at some length`
      ).join("\n")}\n`,
    };

    test("a fat cerebrum is trimmed to fit rather than blowing the budget", () => {
      const out = buildInjection(big, 4096);
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(4096);
      // Trimmed from the end, so the top of User Preferences survives.
      expect(out).toContain("Preference number 0");
      expect(out).not.toContain("Preference number 399");
    });

    test("a section that cannot fit is dropped, not truncated mid-way", () => {
      const out = buildInjection(sources, 1800);
      expect(out).toContain("crank-mem (project memory)");
      expect(out).not.toContain("## ADRs"); // dropped whole — no half-list
    });

    test("instructions survive a budget too small to hold them", () => {
      const out = buildInjection(sources, 10);
      expect(out).toContain("check it before reading any file");
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

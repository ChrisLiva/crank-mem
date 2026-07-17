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

  test("contains all sections in order within budget", () => {
    const out = buildInjection(sources, 5000);
    const iInstr = out.indexOf("crank-mem (project memory)");
    const iCer = out.indexOf("## Cerebrum");
    const iAdr = out.indexOf("## ADRs");
    const iMap = out.indexOf("## File map");
    expect(iInstr).toBeGreaterThanOrEqual(0);
    expect(iCer).toBeGreaterThan(iInstr);
    expect(iAdr).toBeGreaterThan(iCer);
    expect(iMap).toBeGreaterThan(iAdr);
    expect(estimateProseTokens(out)).toBeLessThanOrEqual(5000);
  });

  test("caps ADR list at most recent 20", () => {
    const out = buildInjection(sources, 5000);
    expect(out).toContain("0025-decision-25.md");
    expect(out).toContain("0006-decision-6.md");
    expect(out).not.toContain("0005-decision-5.md");
    expect((out.match(/^- \d{4}-/gm) ?? []).length).toBe(ADR_RECENT_COUNT);
  });

  test("small budget truncates file map with pointer", () => {
    const out = buildInjection({ ...sources, index: fixtureIndex(200) }, 1600);
    expect(out).toMatch(/…plus \d+ more files — see crank\/anatomy\.md/);
    expect(estimateProseTokens(out)).toBeLessThanOrEqual(1700);
  });

  test("symbols never appear in injection", () => {
    const out = buildInjection(sources, 5000);
    expect(out).not.toContain("(fn, L");
  });

  test("staleness note is included when set", () => {
    const out = buildInjection({ ...sources, stalenessNote: "index refresh skipped (lock busy)" }, 5000);
    expect(out).toContain("index refresh skipped");
  });

  test("no cerebrum / no ADRs still yields instructions + map", () => {
    const out = buildInjection({ cerebrumMd: null, adrFilenames: [], index: fixtureIndex(3), adrPath: "docs/adr" }, 5000);
    expect(out).toContain("crank-mem (project memory)");
    expect(out).toContain("## File map");
    expect(out).not.toContain("## Cerebrum");
    expect(out).not.toContain("## ADRs");
  });
});
